// Tests for the result contract — design sec-5 over DEC-093's normative table: the
// success predicate, the abort latch and its commit point, cause precedence, the
// refusal arm, the one vocabulary, the soft transcript budget, and the enum
// reachability claim.
//
// Nothing here spawns anything. The stream side is the REAL reducer
// (`pi/reduce/reduce.ts`) over synthetic JSONL in pi's own shapes — the fixtures
// `pi/mcp/spawn.test.ts` uses — and the child's facts (its exit status, a launch
// that never ran, where the evidence lives) are handed in exactly as the spawn
// reports them. Offline, no child, no wall clock, no filesystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reduce } from '../reduce/reduce.ts';
import type { Reduced } from '../reduce/reduce.ts';
import {
  CAUSE_STATE,
  createLatch,
  failedResult,
  REACHABILITY,
  refusedResult,
  RESULT_REFUSAL_REASONS,
  RESULT_SCHEMA,
  RESULT_STATES,
  resultFor,
  TERMINATIONS,
  validateAgentResult,
} from './result.ts';
import { transcriptBudget } from './policy.ts';
import type { AgentResult, Artifacts, LatchCause, Reachability, ResultState, RunFacts, Termination } from './result.ts';

/** pi's `Usage` shape with every component present: missing data is then missing
 *  rather than a zero, which is the distinction accounting turns on. */
const usage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 110,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  ...overrides,
});

/** A terminal assistant `message_end`, with pi's stop-reason token verbatim (sec-4:
 *  the token is `toolUse`, never `tool_use`). */
function messageEnd(stop: string, text: string | null = 'the answer', usageOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: stop,
      content: text === null ? [] : [{ type: 'text', text }],
      usage: usage(usageOverrides),
    },
  });
}

/** `agent_settled`: the stream's own statement that the run came to rest. */
const SETTLED = JSON.stringify({ type: 'agent_settled' });

const ARTIFACTS: Artifacts = {
  dir: '/state/runs/run-1',
  events: '/state/runs/run-1/events.jsonl',
  transcript: '/state/runs/run-1/transcript.md',
  status: '/state/runs/run-1/status.json',
  audit: '/state/runs/run-1/audit.jsonl',
};

type RunInput = {
  lines?: string[];
  /** The child's exit status; `null` means it never exited (a failed launch). */
  exitCode?: number | null;
  spawnFailed?: boolean;
  /** The latch's committed snapshot, as the server hands it over. */
  causes?: LatchCause[];
  budgetBytes?: number;
};

/** One run: the real reducer, then the one builder. */
function run(input: RunInput = {}): { doc: AgentResult; reduced: Reduced } {
  const reduced = reduce(input.lines ?? [], input.budgetBytes === undefined ? {} : { budgetBytes: input.budgetBytes });
  const outcome: RunFacts = {
    exitCode: input.exitCode === undefined ? 0 : input.exitCode,
    spawnFailed: input.spawnFailed ?? false,
    layout: ARTIFACTS,
  };
  return {
    doc: resultFor({ reduced, outcome, causes: input.causes ?? [], session: 'sess-1' }),
    reduced,
  };
}

/** Every mapped outcome must satisfy the advertised schema, and `termination` must
 *  always be `causes[0]` (sec-5, EX-4). */
function assertConforms(doc: AgentResult, label: string): void {
  const check = validateAgentResult(doc);
  if (!check.ok) assert.fail(`${label}: ${check.detail}`);
  assert.equal(doc.schema, RESULT_SCHEMA);
  assert.equal(doc.causes[0], doc.termination, `${label}: termination is always causes[0]`);
}

// ── EX-1 / VT-1: the success predicate and every settlement combination ─────

type Settlement = RunInput & {
  name: string;
  state: ResultState;
  termination: Termination;
  final: boolean;
  result: string | null;
  /** The reducer's verdict on the stream, which is not the call's verdict. */
  stream: 'completed' | 'failed' | 'incomplete';
};

test('success is one predicate: an answer-bearing terminal message, agent_settled, exit 0 and known accounting (EX-1, VT-1)', async (t) => {
  const cases: Settlement[] = [
    {
      name: 'stop, settled, exit 0',
      lines: [messageEnd('stop'), SETTLED],
      state: 'completed',
      termination: 'stop',
      final: true,
      result: 'the answer',
      stream: 'completed',
    },
    {
      name: 'length, settled, exit 0: complete as far as the provider produced it',
      lines: [messageEnd('length'), SETTLED],
      state: 'completed',
      termination: 'length',
      final: true,
      result: 'the answer',
      stream: 'completed',
    },
    // The three settlement failures. None is a success, and none is inferred from
    // the exit status: an answer plus a nonzero exit is a failure.
    {
      name: 'stop, EOF without agent_settled',
      lines: [messageEnd('stop')],
      state: 'incomplete',
      termination: 'eof',
      final: false,
      result: null,
      stream: 'incomplete',
    },
    {
      name: 'stop, settled, nonzero exit',
      lines: [messageEnd('stop'), SETTLED],
      exitCode: 3,
      state: 'failed',
      termination: 'exit',
      final: false,
      result: null,
      stream: 'completed',
    },
    {
      name: 'settled, nonzero exit, no terminal message',
      lines: [SETTLED],
      exitCode: 3,
      state: 'failed',
      termination: 'exit',
      final: false,
      result: null,
      stream: 'completed',
    },
    {
      name: 'a terminal stopReason error is a failure, never an answer',
      lines: [messageEnd('error'), SETTLED],
      state: 'failed',
      termination: 'error',
      final: false,
      result: null,
      stream: 'failed',
    },
    {
      name: 'a terminal stopReason aborted is a failure',
      lines: [messageEnd('aborted'), SETTLED],
      state: 'failed',
      termination: 'aborted',
      final: false,
      result: null,
      stream: 'failed',
    },
    {
      name: 'a terminal stopReason toolUse issued a call; it did not answer',
      lines: [messageEnd('toolUse'), SETTLED],
      state: 'incomplete',
      termination: 'toolUse',
      final: false,
      result: null,
      stream: 'completed',
    },
    {
      name: 'a terminal stopReason deferred did not answer either',
      lines: [messageEnd('deferred'), SETTLED],
      state: 'incomplete',
      termination: 'deferred',
      final: false,
      result: null,
      stream: 'completed',
    },
    {
      name: 'pending at a message_end is malformed, not merely unfinished',
      lines: [messageEnd('pending'), SETTLED],
      state: 'incomplete',
      termination: 'eof',
      final: false,
      result: null,
      stream: 'completed',
    },
    {
      name: 'settled, exit 0, no terminal message at all',
      lines: [SETTLED],
      state: 'incomplete',
      termination: 'eof',
      final: false,
      result: null,
      // The reducer's `completed` means the loop came to rest; the call's verdict is
      // that there is no answer. Two verdicts about two subjects, one cause named.
      stream: 'completed',
    },
    {
      name: 'a usage-bearing message with no price leaves accounting unknown',
      lines: [messageEnd('stop', 'the answer', { cost: {} }), SETTLED],
      state: 'accounting_unknown',
      termination: 'accounting',
      final: false,
      result: null,
      stream: 'completed',
    },
    {
      name: 'a launch form that never ran',
      lines: [],
      exitCode: null,
      spawnFailed: true,
      state: 'failed',
      termination: 'spawn',
      final: false,
      result: null,
      stream: 'incomplete',
    },
  ];

  for (const settlement of cases) {
    await t.test(settlement.name, () => {
      const { doc, reduced } = run(settlement);
      assert.equal(doc.state, settlement.state, JSON.stringify(doc));
      assert.equal(doc.termination, settlement.termination);
      assert.equal(doc.final, settlement.final, 'final is derived here, from the predicate');
      assert.equal(doc.result, settlement.result, 'only result and final are withdrawn');
      assert.equal(doc.truncated, settlement.termination === 'length', 'truncated is the reducer\'s, verbatim');
      assert.equal(doc.session, 'sess-1');
      assert.equal(doc.status, reduced.status, 'status.state judges the stream');
      assert.equal(doc.status.state, settlement.stream);
      assertConforms(doc, settlement.name);
    });
  }
});

test('exit 0 is never evidence of success (EX-1)', async (t) => {
  // Every exit-0 run with no answer-bearing terminal message, and every one whose
  // stream never settled, is a non-success — the exit status decides nothing.
  await t.test('exit 0 with no stream at all', () => {
    const { doc } = run({ lines: [], exitCode: 0 });
    assert.equal(doc.state, 'incomplete');
    assert.equal(doc.final, false);
    assert.equal(doc.result, null);
  });
  await t.test('exit 0, settled, toolUse: counted and paid for, not an answer', () => {
    const { doc } = run({ lines: [messageEnd('toolUse'), SETTLED], exitCode: 0 });
    assert.equal(doc.final, false);
    assert.equal(doc.result, null);
    assert.equal(doc.status.requests, 1, 'the send was counted; it just was not an answer');
  });
});

// ── EX-2 / VT-2: the latch, the commit point, the full ordered list ────────

test('the abort latch defeats provisional success: a cause recorded before the commit point decides the state (EX-2, VT-2)', async (t) => {
  const answering = [messageEnd('stop'), SETTLED];

  for (const [name, causes, state] of [
    ['a run the backstop stopped cannot report success', ['timeout'], 'timeout'],
    ['a cancel mid-run decides the state even with an answer in hand', ['cancelled'], 'cancelled'],
    ['a switch flip mid-run decides the state', ['switch'], 'cancelled'],
    ['a measured ceiling crossing decides the state', ['ceiling'], 'ceiling_exceeded'],
    ['a failed evidence append decides the state', ['audit'], 'audit_failed'],
  ] as [string, LatchCause[], ResultState][]) {
    await t.test(name, () => {
      const { doc } = run({ lines: answering, causes });
      assert.equal(doc.state, state, JSON.stringify(doc));
      assert.equal(doc.termination, causes[0]);
      assert.deepEqual(doc.causes, causes);
      assert.equal(doc.final, false, 'the latch defeats the provisional completion');
      assert.equal(doc.result, null);
      assert.ok(doc.transcript.length > 0, 'the transcript is returned in every case');
      assertConforms(doc, name);
    });
  }

  await t.test('concurrent causes: termination is causes[0] and the whole ordered list is returned', () => {
    const { doc } = run({ lines: answering, causes: ['timeout', 'audit'] });
    assert.equal(doc.termination, 'timeout', 'discovery order decides; the earliest cause wins');
    assert.deepEqual(doc.causes, ['timeout', 'audit'], 'the later cause is never hidden behind the earlier one');
    assert.equal(doc.state, 'timeout');
    assertConforms(doc, 'timeout then audit');

    const cancelled = run({ lines: answering, causes: ['cancelled', 'audit'] }).doc;
    assert.equal(cancelled.termination, 'cancelled');
    assert.deepEqual(cancelled.causes, ['cancelled', 'audit']);
    assert.equal(cancelled.state, 'cancelled');
  });

  await t.test('the commit point freezes the latch: a record after it cannot alter the outcome', () => {
    const latch = createLatch();
    latch.record('timeout');
    latch.record('audit');
    const committed = latch.commit();
    assert.deepEqual(committed, ['timeout', 'audit'], 'the causes come back in discovery order');
    latch.record('cancelled');
    assert.deepEqual(latch.commit(), ['timeout', 'audit'], 'nothing runs after the commit point, so the return is immutable');
  });

  await t.test('one cause discovered twice is one cause', () => {
    // The ladder records an evidence failure as its cause and the append reports
    // the same failure; the call has one of them, not two.
    const latch = createLatch();
    latch.record('audit');
    latch.record('audit');
    assert.deepEqual(latch.commit(), ['audit']);
  });

  await t.test('an empty latch lets the stream decide, and causes names what decided it', () => {
    assert.deepEqual(createLatch().commit(), []);
    const { doc } = run({ lines: answering, causes: [] });
    assert.equal(doc.state, 'completed');
    assert.deepEqual(doc.causes, ['stop'], 'a completed run still reports the cause it completed on');
  });

  await t.test('an answering reason cannot be latched: the predicate is the only door to completed', () => {
    // A types-only vocabulary does not survive a cast, so `resultFor` filters the
    // list: a stream that never settled stays non-success no matter what the caller
    // claims to have latched.
    const { doc } = run({ lines: [messageEnd('stop')], causes: ['stop'] as unknown as LatchCause[] });
    assert.equal(doc.state, 'incomplete');
    assert.equal(doc.termination, 'eof');
    assert.equal(doc.final, false);
    assert.equal(doc.result, null);
    assert.deepEqual(doc.causes, ['eof'], 'the cast cause is dropped, not reported');
    assertConforms(doc, 'cast stop');
  });
});

// ── EX-3 / VT-3: the refusal arm ───────────────────────────────────────────

test('a refusal is the arm where nothing ran: status, artifacts, result and session null (EX-3, VT-3)', async (t) => {
  for (const reason of RESULT_REFUSAL_REASONS) {
    await t.test(reason, () => {
      const doc = refusedResult(reason, `recorded for ${reason}`);
      assert.equal(doc.schema, RESULT_SCHEMA);
      assert.equal(doc.state, 'refused');
      assert.equal(doc.termination, 'refused');
      assert.deepEqual(doc.causes, ['refused']);
      assert.equal(doc.session, null, 'nothing was minted');
      assert.equal(doc.status, null);
      assert.equal(doc.artifacts, null);
      assert.equal(doc.result, null);
      assert.equal(doc.final, false);
      assert.deepEqual(doc.refusal, { reason, detail: `recorded for ${reason}` });
      assertConforms(doc, reason);
    });
  }

  await t.test('audit-failed before spawn is a refusal; audit_failed is a state only for a run that spawned', () => {
    const refused = refusedResult('audit-failed', 'the run audit could not be written, so nothing ran');
    assert.equal(refused.state, 'refused');
    assert.equal(refused.artifacts, null, 'nothing ran, so there is no run directory');
    assert.equal(refused.refusal?.reason, 'audit-failed');

    const spawned = run({ lines: [messageEnd('stop'), SETTLED], causes: ['audit'] }).doc;
    assert.equal(spawned.state, 'audit_failed');
    assert.equal(spawned.termination, 'audit');
    assert.equal(spawned.artifacts?.dir, ARTIFACTS.dir, 'a spawned run keeps its evidence even when an append failed');
    assert.equal(spawned.refusal, null, 'a spawned run is never a refusal');
    assertConforms(spawned, 'audit_failed');
  });

  await t.test('a refusal carries no run evidence and a run carries no refusal', () => {
    const runDoc = run({ lines: [messageEnd('stop'), SETTLED] }).doc;
    assert.equal(runDoc.refusal, null);
    assert.notEqual(runDoc.artifacts, null);
    assert.equal(validateAgentResult({ ...refusedResult('request-invalid', 'params is not an object'), status: {} }).ok, false);
  });
});

// ── EX-4 / VT-4: one vocabulary, and the schema every outcome must satisfy ─

/** One named path per termination token, shared by EX-4's schema sweep and EX-9's
 *  production table: the point is that a member is *produced*, not merely listed. */
const PRODUCED: Record<Termination, () => AgentResult> = {
  stop: () => run({ lines: [messageEnd('stop'), SETTLED] }).doc,
  length: () => run({ lines: [messageEnd('length'), SETTLED] }).doc,
  error: () => run({ lines: [messageEnd('error'), SETTLED] }).doc,
  aborted: () => run({ lines: [messageEnd('aborted'), SETTLED] }).doc,
  toolUse: () => run({ lines: [messageEnd('toolUse'), SETTLED] }).doc,
  deferred: () => run({ lines: [messageEnd('deferred'), SETTLED] }).doc,
  eof: () => run({ lines: [messageEnd('stop')] }).doc,
  exit: () => run({ lines: [SETTLED], exitCode: 2 }).doc,
  spawn: () => run({ lines: [], exitCode: null, spawnFailed: true }).doc,
  timeout: () => run({ lines: [messageEnd('stop'), SETTLED], causes: ['timeout'] }).doc,
  cancelled: () => run({ lines: [messageEnd('stop'), SETTLED], causes: ['cancelled'] }).doc,
  switch: () => run({ lines: [messageEnd('stop'), SETTLED], causes: ['switch'] }).doc,
  ceiling: () => run({ lines: [messageEnd('stop'), SETTLED], causes: ['ceiling'] }).doc,
  accounting: () => run({ lines: [messageEnd('stop', 'the answer', { cost: {} }), SETTLED] }).doc,
  audit: () => run({ lines: [messageEnd('stop'), SETTLED], causes: ['audit'] }).doc,
  refused: () => refusedResult('audit-unavailable', 'attempts.jsonl cannot be appended to'),
};

test('one vocabulary: `timeout` is the cause token, `backstop` is not, and every mapped outcome satisfies pi-agent-result/1 (EX-4, VT-4)', async (t) => {
  await t.test('the enums are the wire vocabulary', () => {
    assert.equal(RESULT_SCHEMA, 'pi-agent-result/1');
    assert.deepEqual(
      [...RESULT_STATES],
      ['completed', 'failed', 'incomplete', 'timeout', 'cancelled', 'ceiling_exceeded', 'accounting_unknown', 'audit_failed', 'refused'],
    );
    assert.equal(new Set(TERMINATIONS).size, TERMINATIONS.length, 'no duplicated token');
    assert.equal(TERMINATIONS.length, 16);
    assert.ok(TERMINATIONS.includes('timeout'), 'the wall clock\'s cause and state are one word');
    assert.ok(!(TERMINATIONS as readonly string[]).includes('backstop'), '`backstop` names the mechanism in prose; it is not a cause token');
    // pi's stop reasons, verbatim: a snake-case matcher classifies nothing while
    // looking correct.
    for (const token of ['stop', 'length', 'error', 'aborted', 'toolUse', 'deferred']) {
      assert.ok(TERMINATIONS.includes(token as Termination), token);
    }
    assert.ok(!(TERMINATIONS as readonly string[]).includes('tool_use'), 'the wrong spelling must never appear');
  });

  await t.test('the table is total: every cause maps to a state and every state is reachable from it', () => {
    assert.deepEqual(Object.keys(CAUSE_STATE).sort(), [...TERMINATIONS].sort());
    for (const token of TERMINATIONS) assert.ok(RESULT_STATES.includes(CAUSE_STATE[token]), token);
    assert.deepEqual([...new Set(Object.values(CAUSE_STATE))].sort(), [...RESULT_STATES].sort());
  });

  await t.test('every mapped outcome satisfies the advertised schema', async (inner) => {
    for (const token of TERMINATIONS) {
      await inner.test(token, () => {
        // Every token through the path that actually produces it — the answering
        // reasons through the predicate, never latched in.
        const doc = PRODUCED[token]();
        assertConforms(doc, token);
        assert.equal(doc.state, CAUSE_STATE[token], `${token} maps to its own row`);
      });
    }
  });

  await t.test('the last resort: a post-run throw is a conforming `failed` envelope, not a refusal', () => {
    // The arm the server answers with when it throws after the run was established:
    // it has the call's session, a status and a layout, so it must satisfy the same
    // schema every derived outcome does.
    const status = reduce([], {}).status;
    const doc = failedResult('error', ['error'], 'sess-9', status, ARTIFACTS);
    assertConforms(doc, 'failedResult');
    assert.equal(doc.state, 'failed');
    assert.equal(doc.session, 'sess-9', 'the call\'s own session');
    assert.equal(doc.artifacts?.dir, ARTIFACTS.dir, 'the run layout\'s directory');
    assert.equal(doc.transcript, '', 'the diagnostic detail is not reduced markdown');
    assert.equal(doc.result, null);
    assert.equal(doc.final, false);
    assert.equal(doc.refusal, null);
    assert.equal(doc.status, status, 'the verdict on an unread stream');
  });

  await t.test('a cause token outside the enum fails the suite, not the reader', () => {
    const outside = { ...run({ causes: ['timeout'] }).doc, termination: 'backstop', causes: ['backstop'] };
    const check = validateAgentResult(outside);
    if (check.ok) assert.fail('a cause token outside the enum must be rejected');
    assert.match(check.detail, /backstop/);
  });

  await t.test('the precedence rule is part of the schema: causes[0] is the termination, and the state is its row', () => {
    const completed = run({ lines: [messageEnd('stop'), SETTLED] }).doc;
    const wrongCause = validateAgentResult({ ...completed, causes: ['audit'] });
    assert.equal(wrongCause.ok, false, 'a list whose first cause is not the termination is a defect');
    const wrongState = validateAgentResult({ ...completed, state: 'failed' });
    assert.equal(wrongState.ok, false, 'a state that is not the cause\'s row is a defect');
    // A textless terminal message is a legitimate completion, so only a NON-completed
    // run holding an answer is the defect DEC-093 names.
    const timedOut = run({ lines: [messageEnd('stop'), SETTLED], causes: ['timeout'] }).doc;
    assert.equal(validateAgentResult({ ...timedOut, result: 'the answer' }).ok, false, 'a non-completed run withdraws its answer');
  });
});

// ── EX-6 / VT-5: the soft transcript budget, wired through the policy clamp ─

/** A stream long enough that the body — not the mandatory header and result block —
 *  is what the budget elides. */
function bulky(): string[] {
  const lines: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    lines.push(
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: `call-${index}`,
        toolName: 'bash',
        args: { command: `step ${index}` },
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: `call-${index}`,
        toolName: 'bash',
        result: { content: [{ type: 'text', text: `step ${index} output` }], structuredContent: { exit_code: 0 } },
        isError: false,
      }),
    );
    lines.push(messageEnd('stop', `step ${index} prose`));
  }
  lines.push(SETTLED);
  return lines;
}

test('the transcript budget is soft and wired through the policy clamp (EX-6, VT-5)', async (t) => {
  await t.test('the clamped budget is what reaches the reducer', () => {
    const lines = bulky();
    const loose = run({ lines, budgetBytes: transcriptBudget(undefined, undefined) }).reduced;
    const clamped = run({ lines, budgetBytes: transcriptBudget(0, 512) }).reduced;
    assert.ok(clamped.transcript.length < loose.transcript.length, 'the clamp reached the reducer');
    assert.ok(clamped.status.transcript.elided > loose.status.transcript.elided);
  });

  await t.test('mandatory sections may exceed the budget, by design and by test', () => {
    const budget = transcriptBudget(64, 64);
    const { doc } = run({ lines: bulky(), budgetBytes: budget });
    const bytes = Buffer.byteLength(doc.transcript);
    assert.ok(bytes > 64, `the header and the result block are mandatory: ${bytes} bytes`);
    assert.equal(doc.status.transcript.bytes, bytes, 'the status reports the honest byte count');
    assert.ok(doc.status.transcript.elided > 0, 'the body was elided');
    assert.equal(doc.artifacts?.transcript, ARTIFACTS.transcript, 'the unbudgeted text is at artifacts.transcript');
    assert.ok(doc.result === 'step 39 prose', 'the answer survives the budget');
  });

  await t.test('truncated reports a length stop; a small budget never fakes one', () => {
    const length = run({ lines: [messageEnd('length'), SETTLED], budgetBytes: 64 }).doc;
    assert.equal(length.truncated, true);
    assert.equal(length.state, 'completed', 'length with the predicate is a completion that was cut');
    const stop = run({ lines: [messageEnd('stop'), SETTLED], budgetBytes: 64 }).doc;
    assert.equal(stop.truncated, false, 'eliding the body does not truncate the answer');
  });

  await t.test('status is embedded verbatim and the artifacts name the run', () => {
    const { doc, reduced } = run({ lines: [messageEnd('stop'), SETTLED] });
    assert.equal(doc.status, reduced.status, 'the same object from reduce(), never rebuilt');
    assert.equal(doc.transcript, reduced.transcript);
    assert.deepEqual(doc.artifacts, ARTIFACTS);
    assert.equal(refusedResult('request-invalid', 'nothing ran').artifacts, null);
  });

  await t.test('server.ts hands the clamp to the reducer: request and policy, no budget of its own', () => {
    // The clamp is unit-tested above, but a dropped argument at the seam would leave
    // both suites green. Read the one call site and require both values in it.
    const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    const start = server.indexOf('reduce(run.lines');
    assert.notEqual(start, -1, 'the reduce(run.lines, { budgetBytes: … }) seam must exist to be wired');
    let depth = 0;
    let end = -1;
    for (let index = server.indexOf('(', start); index !== -1; index += 1) {
      if (server[index] === '(') depth += 1;
      else if (server[index] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    assert.notEqual(end, -1, 'the reduce call must close: an unlocatable seam fails here, not vacuously');
    const seam = server.slice(start, end);
    assert.match(seam, /budgetBytes:\s*transcriptBudget\(/, 'the budget reaches the reducer through the clamp');
    assert.match(seam, /request\.transcript_budget_bytes/, 'the request\'s value is one argument: dropping it fails here');
    assert.match(seam, /admission\.policy\.transcript_budget_bytes/, 'the policy maximum is the other: neither is ignored');
  });
});

// ── EX-5: two verdicts, one reason ─────────────────────────────────────────

test('status.state judges the stream and state judges the call (EX-5)', async (t) => {
  const cases: { name: string; input: RunInput; state: ResultState; termination: Termination; stream: string }[] = [
    {
      name: 'an answer plus a nonzero exit',
      input: { lines: [messageEnd('stop'), SETTLED], exitCode: 3 },
      state: 'failed',
      termination: 'exit',
      stream: 'completed',
    },
    {
      name: 'an answer the wall clock cut off',
      input: { lines: [messageEnd('stop'), SETTLED], causes: ['timeout'] },
      state: 'timeout',
      termination: 'timeout',
      stream: 'completed',
    },
    {
      name: 'an answer whose spend is unknown',
      input: { lines: [messageEnd('stop', 'the answer', { cost: {} }), SETTLED] },
      state: 'accounting_unknown',
      termination: 'accounting',
      stream: 'completed',
    },
    {
      name: 'an answer the run never settled',
      input: { lines: [messageEnd('stop')] },
      state: 'incomplete',
      termination: 'eof',
      stream: 'incomplete',
    },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const { doc, reduced } = run(testCase.input);
      assert.equal(doc.status, reduced.status, 'the status is the reducer\'s own object');
      assert.equal(doc.status.state, testCase.stream, 'the stream\'s verdict');
      assert.equal(doc.state, testCase.state, 'the call\'s verdict');
      assert.equal(doc.causes[0], testCase.termination, 'the deciding cause is named, so the divergence is explained');
    });
  }

  await t.test('never two accounting stories', () => {
    const { doc } = run({ lines: [messageEnd('stop', 'the answer', { cost: {} }), SETTLED] });
    assert.equal(doc.state, 'accounting_unknown');
    assert.equal(doc.status?.accounting, 'unknown', 'the call\'s state and the status\'s own field agree');
    assert.equal(doc.causes[0], 'accounting');
  });
});

// ── EX-9 / VT-7: every enum member is produced by a named path ─────────────

const isUnreachable = (entry: Reachability): entry is { unreachable: string } => 'unreachable' in entry;
const producedBy = (entry: Reachability): entry is { producedBy: string } => 'producedBy' in entry;

test('every state and every termination is produced by a named path or declared unreachable (EX-9, VT-7)', async (t) => {
  const produced = new Map<Termination, AgentResult>();
  for (const token of TERMINATIONS) {
    await t.test(token, () => {
      const doc = PRODUCED[token]();
      produced.set(token, doc);
      assert.equal(doc.termination, token, 'the named path produces this token');
      assertConforms(doc, token);
    });
  }

  // The table over the enum: every member has an entry and the table has no member
  // the enum does not have. A member with neither a producer nor a stated reason is
  // the silent hole RV-043 F-12 raised.
  assert.deepEqual(Object.keys(REACHABILITY.terminations).sort(), [...TERMINATIONS].sort());
  assert.deepEqual(Object.keys(REACHABILITY.states).sort(), [...RESULT_STATES].sort());
  for (const token of TERMINATIONS) {
    const entry = REACHABILITY.terminations[token];
    assert.ok(producedBy(entry) ? entry.producedBy.length > 0 : entry.unreachable.length > 0, `termination ${token} names its path or its reason`);
  }
  for (const state of RESULT_STATES) {
    const entry = REACHABILITY.states[state];
    assert.ok(producedBy(entry) ? entry.producedBy.length > 0 : entry.unreachable.length > 0, `state ${state} names its path or its reason`);
  }

  // A4: every member is reachable in this build, so the hole list is empty — and it
  // is empty as a stated choice, which is why the arm exists.
  const holes = [
    ...Object.entries(REACHABILITY.states)
      .filter(([, entry]) => isUnreachable(entry))
      .map(([member, entry]) => `state ${member}: ${(entry as { unreachable: string }).unreachable}`),
    ...Object.entries(REACHABILITY.terminations)
      .filter(([, entry]) => isUnreachable(entry))
      .map(([member, entry]) => `termination ${member}: ${(entry as { unreachable: string }).unreachable}`),
  ];
  assert.deepEqual(holes, [], 'an unreachable member is a stated hole, and this build has none');

  // Every state is reached by a produced token's row, so the state enum has no
  // member the table cannot reach.
  const states = new Set([...produced.values()].map((doc) => doc.state));
  for (const state of RESULT_STATES) assert.ok(states.has(state), `no named path produces state ${state}`);
  assert.ok(states.has('ceiling_exceeded'), 'the gate\'s own state is reachable, not merely declared');
});
