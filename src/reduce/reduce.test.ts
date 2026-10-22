// Behaviour tests for the reducer. The reducer is the contract: `quotient
// reduce`, the shell wrappers and the MCP server all report through it, so these
// assert the rendering rules and the status derivation, not the internals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduce } from './reduce.ts';
import type { Reduced } from './reduce.ts';

const cli = new URL('../cli.ts', import.meta.url).pathname;

const ev = (type: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ type, ...extra });

const assistant = (content: unknown[], stopReason = 'stop', usage?: unknown): string =>
  ev('message_end', { message: { role: 'assistant', content, stopReason, model: 'test-model', usage } });

const call = (name: string, args: Record<string, unknown>): string[] => [
  ev('tool_execution_start', { toolCallId: `c-${name}-${JSON.stringify(args)}`, toolName: name, args }),
];

const result = (text: string, extra: Record<string, unknown> = {}): string =>
  ev('tool_execution_end', {
    toolCallId: 'c',
    toolName: 'bash',
    result: { content: [{ type: 'text', text }], structuredContent: { exit_code: 0 } },
    isError: false,
    ...extra,
  });

/** An assistant message whose content is a single text block. */
const says = (text: string, stopReason = 'stop', usage?: unknown): string =>
  assistant([{ type: 'text', text }], stopReason, usage);

/** pi's `Usage.cost`: all four components plus the total we assert on. */
const cost = (total: number): Record<string, number> => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total });

/** pi's `Usage` shape with every component present, so a missing one is missing
 *  data rather than a zero. */
const tokenUsage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 110,
  cost: cost(0.01),
  ...overrides,
});

/** pi's `EMPTY_USAGE`: the zeros a failure message carries as a placeholder. */
const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: cost(0) };

/** A `compaction_end`; `result` present means a summarization response came back. */
const compactionEnd = (extra: Record<string, unknown> = {}): string =>
  ev('compaction_end', { reason: 'threshold', aborted: false, willRetry: false, ...extra });

const compactionResult = (usage: Record<string, unknown>): Record<string, unknown> => ({
  summary: 'Summary of the conversation so far.',
  firstKeptEntryId: 'entry-1',
  tokensBefore: 150_000,
  usage,
});

/** A minimal run: context echo, a tool round trip, then an answer. */
const run = (...middle: string[]): string[] => [
  ev('session', { version: 3, id: 'sess-1', cwd: '/repo' }),
  ev('agent_start'),
  ev('turn_start'),
  ev('message_end', { message: { role: 'system', content: 'SYSTEM PROMPT ECHO' } }),
  ev('message_end', { message: { role: 'user', content: 'USER PROMPT ECHO' } }),
  ...middle,
  ev('agent_settled'),
];

const reduceLines = (lines: string[], budgetBytes = 8192, alerts: string[] = []): Reduced =>
  reduce(lines, { budgetBytes, alerts });

test('renders prose verbatim, tool calls as one line, results as their first line', () => {
  const { transcript, status } = reduceLines(
    run(
      assistant([{ type: 'text', text: 'Looking at the tree.' }], 'toolUse'),
      ...call('bash', { command: 'ls -la' }),
      result('total 2\ndrwxr-xr-x 1 david users\n'),
      assistant([{ type: 'text', text: 'Two entries.' }]),
    ),
  );
  assert.match(transcript, /^Looking at the tree\.$/m);
  assert.match(transcript, /^→ bash\(ls -la\)$/m);
  assert.match(transcript, /^ {2}↳ total 2$/m);
  assert.match(transcript, /^## Result\nTwo entries\.$/m);
  assert.equal(status.state, 'completed');
  assert.equal(status.tool_calls, 1);
  assert.equal(status.turns, 2);
});

test('drops context echo and thinking, which are most of the raw stream', () => {
  const { transcript } = reduceLines(
    run(
      assistant([
        { type: 'thinking', thinking: 'SECRET DELIBERATION' },
        { type: 'text', text: 'Done.' },
      ]),
    ),
  );
  assert.doesNotMatch(transcript, /SYSTEM PROMPT ECHO|USER PROMPT ECHO|SECRET DELIBERATION/);
});

test('collapses identical repeated activity, but not differing output', () => {
  const cmd = { command: 'grep -r x .' };
  const { transcript } = reduceLines(
    run(
      ...call('bash', cmd),
      result('same output'),
      ...call('bash', cmd),
      result('same output'),
      ...call('bash', cmd),
      result('different output'),
      assistant([{ type: 'text', text: 'ok' }]),
    ),
  );
  assert.match(transcript, /^→ bash\(grep -r x \.\) ×2$/m);
  // The count belongs to the action; the identical output is shown once.
  assert.equal(transcript.match(/^ {2}↳ same output$/gm)?.length, 1);
  // A retry whose output changed is information: it stays visible.
  assert.match(transcript, /^ {2}↳ different output$/m);
});

test('marks failed tool results and non-zero exits', () => {
  const { transcript } = reduceLines(
    run(
      result('boom: no such file', { isError: true }),
      result('partial output', { result: { content: [{ type: 'text', text: 'partial output' }], structuredContent: { exit_code: 2 } } }),
      assistant([{ type: 'text', text: 'gave up' }]),
    ),
  );
  assert.match(transcript, /^ {2}✗ boom: no such file$/m);
  assert.match(transcript, /^ {2}↳ \[exit 2\] partial output$/m);
});

test('alerts match untruncated text, beyond the rendered snippet', () => {
  const buried = `${'x'.repeat(400)} FORBIDDEN-PATH`;
  const { status } = reduceLines(run(result(buried), assistant([{ type: 'text', text: 'ok' }])), 8192, ['forbidden-path']);
  assert.equal(status.alerts.length, 1);
  assert.equal(status.alerts[0].pattern, 'forbidden-path');
  // The rendered line is clipped; the alert still fires on the full text.
  assert.match(status.alerts[0].text, /FORBIDDEN-PATH$/);
});

test('budget is enforced, elided from the middle, and never eats the result', () => {
  const middle: string[] = [];
  for (let i = 0; i < 100; i++) {
    middle.push(...call('bash', { command: `step ${i} --with-a-reasonably-long-argument` }), result(`output of step ${i}`));
  }
  middle.push(assistant([{ type: 'text', text: 'FINISHED' }]));
  const budget = 600;
  const { transcript, status } = reduceLines(run(...middle), budget);

  assert.ok(Buffer.byteLength(transcript) <= budget, `transcript is ${Buffer.byteLength(transcript)} bytes`);
  assert.match(transcript, /entries elided/);
  assert.match(transcript, /^## Result\nFINISHED$/m);
  assert.ok(status.transcript.elided > 0);
  // The opening move survives: elision is middle-out, not tail-drop.
  assert.match(transcript, /step 0 /);
});

test('a budget too small for the mandatory sections reports honestly instead of lying', () => {
  const { transcript, status } = reduceLines(run(assistant([{ type: 'text', text: 'x'.repeat(2000) }])), 100);
  assert.ok(status.transcript.bytes > 100);
  assert.equal(status.transcript.bytes, Buffer.byteLength(transcript));
  assert.match(transcript, /^## Result\nx+$/m);
});

test('state: failed on an error stop reason, even when settled', () => {
  const { status } = reduceLines(run(assistant([{ type: 'text', text: 'nope' }], 'error')));
  assert.equal(status.state, 'failed');
});

test('state: incomplete when the stream stops without agent_settled', () => {
  const lines = run(assistant([{ type: 'text', text: 'partial' }])).filter((line) => !line.includes('agent_settled'));
  const { status } = reduceLines(lines);
  assert.equal(status.state, 'incomplete');
});

test('tokens and cost accumulate across turns, once', () => {
  // `cacheWrite` is present because usage now validates every component: an absent
  // one is missing data, not a zero.
  const usage = { input: 100, output: 10, cacheRead: 40, cacheWrite: 0, cost: { total: 0.002 } };
  const { status } = reduceLines(
    run(
      assistant([{ type: 'text', text: 'a' }], 'toolUse', usage),
      ...call('bash', { command: 'true' }),
      result(''), // agent_end replays the last message; it must not double-count
      assistant([{ type: 'text', text: 'b' }], 'stop', usage),
      ev('agent_end', { messages: [{ role: 'assistant', model: 'test-model', usage }], willRetry: false }),
    ),
  );
  assert.deepEqual(status.tokens, { input: 200, output: 20, cached: 80, cache_write: 0 });
  assert.equal(status.cost_usd?.toFixed(4), '0.0040');
  assert.equal(status.requests, 2); // `agent_end` replays messages; it is not a send
});

// --- sec-4's counting table: one request per provider send -------------------
// The counting units are defined per record, so two readers of one stream count
// the same run. Each test below is one row of that table.

test('counting table: every assistant message_end is one request, whatever its stop reason', () => {
  const { status } = reduceLines(
    run(
      says('done', 'stop', tokenUsage()),
      says('boom', 'error', emptyUsage),
      says('stopped', 'aborted', emptyUsage),
    ),
  );
  assert.equal(status.requests, 3);
  assert.equal(status.turns, 3);
});

test('counting table: a compaction_end carrying result.usage is a measured request', () => {
  const { status } = reduceLines(run(compactionEnd({ result: compactionResult(tokenUsage()) })));
  assert.equal(status.requests, 1);
  assert.equal(status.requests_unmeasured, 0);
  assert.equal(status.accounting, 'known');
  assert.deepEqual(status.tokens, { input: 100, output: 10, cached: 0, cache_write: 0 });
});

test('counting table: a compaction_end carrying a result without usage counts and leaves accounting unknown', () => {
  const { status } = reduceLines(run(compactionEnd({ result: { summary: 'a response came back unpriced' } })));
  assert.equal(status.requests, 1);
  assert.equal(status.accounting, 'unknown');
  assert.equal(status.cost_usd, null);
});

test('counting table: a result-less compaction_end counts nothing — no send left the process', () => {
  const reasons: Record<string, unknown>[] = [
    { aborted: true }, // aborted before any response
    { errorMessage: 'no api key for provider' }, // credential failure
    { errorMessage: 'unknown model: nope' }, // missing model
    { status: 'declined' }, // summarization declined
  ];
  for (const extra of reasons) {
    const { status } = reduceLines(run(compactionEnd(extra)));
    assert.equal(status.requests, 0, `counted a request for ${JSON.stringify(extra)}`);
  }
});

test('counting table: summarization_retry_scheduled counts a request it discloses as requests_unmeasured', () => {
  const { status } = reduceLines(
    run(ev('summarization_retry_scheduled', { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'terminated' })),
  );
  assert.equal(status.requests, 1);
  assert.equal(status.requests_unmeasured, 1);
  assert.equal(status.cost_usd, null);
  // Disclosed as unmeasured, not as an accounting failure: a retry is not fatal.
  assert.equal(status.accounting, 'known');
});

// --- the three verified traces, as negative controls ------------------------

test('verified trace: auto_retry_start is not a second request — error+stop is 2, not 3', () => {
  // The failed send has its own message_end; auto_retry_start marks the retry of a
  // send already counted.
  const { status } = reduceLines(
    run(
      assistant([], 'error', emptyUsage),
      ev('auto_retry_start', { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded' }),
      ev('auto_retry_end', { success: true, attempt: 2 }),
      says('recovered', 'stop', tokenUsage()),
    ),
  );
  assert.equal(status.requests, 2);
  assert.equal(status.requests_unmeasured, 1);
});

test('verified trace: summarization_retry_scheduled plus its compaction_end is 2 requests, not 3', () => {
  const { status } = reduceLines(
    run(
      ev('compaction_start', { reason: 'threshold' }),
      ev('summarization_retry_scheduled', { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'terminated' }),
      ev('summarization_retry_attempt_start', { source: 'compaction', reason: 'threshold' }),
      ev('summarization_retry_finished'),
      compactionEnd({ result: compactionResult(tokenUsage()) }),
    ),
  );
  assert.equal(status.requests, 2);
  assert.equal(status.requests_unmeasured, 1);
});

test('verified trace: an overflow diagnostic compaction_end is a zero-send record', () => {
  // Overflow recovery's diagnostic carries no result: nothing reached a provider.
  const { status } = reduceLines(
    run(
      ev('compaction_start', { reason: 'overflow' }),
      compactionEnd({
        reason: 'overflow',
        errorMessage: 'Context overflow recovery failed after one compact-and-retry attempt.',
      }),
    ),
  );
  assert.equal(status.requests, 0);
  assert.equal(status.requests_unmeasured, 0);
  assert.equal(status.cost_usd, null);
  assert.equal(status.accounting, 'known');
});

// --- cost is one path, and a zero is a price only when it was observed -------

test('cost_usd is one path: a compaction at 0.20 plus an assistant send at 0.01 is 0.21, not 0.01', () => {
  const { status } = reduceLines(
    run(
      compactionEnd({
        result: compactionResult(tokenUsage({ cost: cost(0.2) })),
      }),
      says('answered', 'stop', tokenUsage({ cost: cost(0.01) })),
    ),
  );
  assert.equal(status.cost_usd?.toFixed(4), '0.2100');
  assert.equal(status.requests, 2);
  assert.equal(status.accounting, 'known');
});

test('EMPTY_USAGE: a failure message is unmeasured — counted, no tokens, no cost_usd', () => {
  const { status } = reduceLines(run(says('boom', 'error', emptyUsage)));
  assert.equal(status.requests, 1);
  assert.equal(status.requests_unmeasured, 1);
  assert.deepEqual(status.tokens, { input: 0, output: 0, cached: 0, cache_write: 0 });
  assert.equal(status.cost_usd, null); // a placeholder price is not an observed one
  assert.equal(status.accounting, 'known'); // unmeasured is disclosed, not an abort
});

test('the asymmetry: a failed send still accrues cost_usd while its tokens do not', () => {
  for (const stopReason of ['error', 'aborted']) {
    const { status } = reduceLines(
      run(says('boom', stopReason, tokenUsage({ cost: cost(0.005) }))),
    );
    assert.equal(status.requests, 1, stopReason);
    assert.equal(status.requests_unmeasured, 0, `${stopReason}: it carried a real price, so it is measured`);
    assert.equal(status.cost_usd?.toFixed(4), '0.0050', stopReason);
    assert.deepEqual(status.tokens, { input: 0, output: 0, cached: 0, cache_write: 0 }, stopReason);
  }
});

test('an absent cost.total is unknown, never zero', () => {
  const { status } = reduceLines(run(says('answered', 'stop', tokenUsage({ cost: undefined }))));
  assert.equal(status.requests, 1); // counted; only its accounting is unknown
  assert.equal(status.accounting, 'unknown');
  assert.equal(status.cost_usd, null);
});

test('a zero-priced usage is a price, not missing data', () => {
  const { status } = reduceLines(
    run(says('answered', 'stop', tokenUsage({ cacheRead: 400, cost: cost(0) }))),
  );
  assert.equal(status.accounting, 'known');
  assert.equal(status.cost_usd, 0);
  assert.equal(status.tokens.cached, 400);
});

test('usage that is absent, non-finite or negative marks accounting unknown', () => {
  const bad: (Record<string, unknown> | undefined)[] = [
    undefined,
    tokenUsage({ input: Number.NaN }),
    tokenUsage({ output: -1 }),
    tokenUsage({ cacheWrite: undefined }),
  ];
  for (const usage of bad) {
    const { status } = reduceLines(run(says('answered', 'stop', usage)));
    assert.equal(status.requests, 1);
    assert.equal(status.accounting, 'unknown', `usage ${JSON.stringify(usage)} read as known`);
  }
});

// --- stop reasons are pi's tokens, verbatim ---------------------------------

test('toolUse and deferred are usage-bearing and are not answers', () => {
  const toolTurn = reduceLines(run(says('I will look.', 'toolUse', tokenUsage())));
  assert.equal(toolTurn.result, null);
  assert.equal(toolTurn.terminalReason, 'toolUse');
  assert.equal(toolTurn.status.accounting, 'known'); // usage-bearing: validated and accrued
  assert.deepEqual(toolTurn.status.tokens, { input: 100, output: 10, cached: 0, cache_write: 0 });

  const deferred = reduceLines(run(says('back later', 'deferred', tokenUsage())));
  assert.equal(deferred.result, null);
  assert.equal(deferred.terminalReason, 'deferred');
  assert.equal(deferred.status.accounting, 'known');
  assert.deepEqual(deferred.status.tokens, { input: 100, output: 10, cached: 0, cache_write: 0 });
});

test('pending at a message_end is counted and is not an answer', () => {
  const { status, result, terminalReason, transcript } = reduceLines(
    run(says('half a thought', 'pending', tokenUsage())),
  );
  assert.equal(status.requests, 1);
  assert.equal(terminalReason, 'pending');
  assert.equal(result, null);
  assert.match(transcript, /^## Result\n\(no assistant answer\)$/m);
  assert.match(transcript, /^half a thought$/m); // activity, never presented as the answer
});

test('the wrong-spelling tool_use control fails closed: the token passes through and is no answer', () => {
  const { status, result, terminalReason } = reduceLines(run(says('I will look.', 'tool_use', tokenUsage())));
  assert.equal(terminalReason, 'tool_use'); // verbatim: never normalised to toolUse
  assert.equal(status.last_stop_reason, 'tool_use');
  assert.equal(result, null);
});

// --- sec-5's answer: the terminal assistant message -------------------------

test('result joins every text block of the terminal message; terminalReason is its stop reason', () => {
  const { result, terminalReason, status, transcript } = reduceLines(
    run(
      assistant(
        [
          { type: 'thinking', thinking: 'SECRET DELIBERATION' },
          { type: 'text', text: 'Block one.' },
          { type: 'text', text: 'Block two.' },
        ],
        'stop',
        tokenUsage(),
      ),
    ),
  );
  assert.equal(result, 'Block one.\n\nBlock two.');
  assert.equal(terminalReason, 'stop');
  assert.equal(status.turns, 1);
  assert.match(transcript, /^## Result\nBlock one\.\n\nBlock two\.$/m);
  assert.equal(transcript.match(/Block one\./g)?.length, 1); // rendered once, not twice
});

test('a later assistant message invalidates an earlier candidate: stale prose is not the answer', () => {
  const stale = reduceLines(
    run(
      says('STALE PROSE', 'stop', tokenUsage()),
      ev('message_start', { message: { role: 'assistant', content: [] } }),
    ),
  );
  assert.equal(stale.result, null); // the stream began a message that never ended
  assert.equal(stale.terminalReason, 'stop');
  assert.match(stale.transcript, /^## Result\n\(no assistant answer\)$/m);
  assert.match(stale.transcript, /^STALE PROSE$/m); // activity, not the answer

  const replaced = reduceLines(
    run(says('STALE PROSE', 'stop', tokenUsage()), says('fresh answer', 'stop', tokenUsage())),
  );
  assert.equal(replaced.result, 'fresh answer');
  assert.match(replaced.transcript, /^## Result\nfresh answer$/m);
  assert.match(replaced.transcript, /^STALE PROSE$/m);
});

test('a textless terminal message yields no result and leaves its activity in the body', () => {
  const activity = [...call('bash', { command: 'ls' }), result('a.txt'), assistant([], 'stop', tokenUsage())];
  const { result: answer, transcript, terminalReason } = reduceLines(run(...activity));
  assert.equal(answer, null);
  assert.equal(terminalReason, 'stop');
  assert.match(transcript, /^## Result\n\(no assistant answer\)$/m);
  assert.match(transcript, /^→ bash\(ls\)$/m);
});

test('length sets truncated and is answer-bearing; stop is neither truncated nor withheld', () => {
  const cut = reduceLines(run(says('half a sente', 'length', tokenUsage())));
  assert.equal(cut.truncated, true);
  assert.equal(cut.result, 'half a sente');
  assert.equal(cut.terminalReason, 'length');
  assert.equal(cut.status.state, 'completed');

  const whole = reduceLines(run(says('whole', 'stop', tokenUsage())));
  assert.equal(whole.truncated, false);
});

// --- the status every consumer reads ---------------------------------------

test('status carries requests, requests_unmeasured, cache_write and accounting under pi-run-status/2', () => {
  const reduced = reduceLines(
    run(
      compactionEnd({ result: compactionResult(tokenUsage({ cacheWrite: 25 })) }),
      ev('summarization_retry_scheduled', { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'terminated' }),
      says('answered', 'stop', tokenUsage({ cacheWrite: 5 })),
    ),
  );
  const { status } = reduced;
  assert.equal(status.schema, 'pi-run-status/2');
  assert.equal(status.requests, 3);
  assert.equal(status.requests_unmeasured, 1);
  assert.equal(status.tokens.cache_write, 30);
  assert.equal(status.accounting, 'known');
  // `turns` keeps its own meaning: assistant messages, not sends.
  assert.equal(status.turns, 1);
  // The embedded status and the reducer's own fields are the same figures.
  assert.equal(reduced.requests, status.requests);
  assert.equal(reduced.requests_unmeasured, status.requests_unmeasured);
  assert.equal(reduced.accounting, status.accounting);
  assert.equal(reduced.settled, true);
  assert.equal(reduced.result, 'answered');
});

test('malformed lines are counted, not fatal', () => {
  const { status } = reduceLines([...run(assistant([{ type: 'text', text: 'ok' }])), 'not json at all']);
  assert.equal(status.state, 'completed');
  assert.equal(status.transcript.malformed, 1);
});

test('cli: one status line by default, exit 0 when completed', () => {
  const stdout = execFileSync('node', [cli, 'reduce', '--out', mkdtempSync(join(tmpdir(), 'reduce-'))], {
    input: run(says('ok', 'stop', tokenUsage())).join('\n'),
    encoding: 'utf8',
  });
  assert.equal(stdout.trim().split('\n').length, 1);
  // The line gained the accounting fields; every existing field keeps its place.
  assert.match(
    stdout.trim(),
    /^completed turns=1 requests=1 unmeasured=0 accounting=known tools=0 tokens=100\/10 cost=0\.0100 transcript=.*transcript\.md$/,
  );
});

test('cli: writes transcript.md and status.json beside the input, exit 1 when failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reduce-'));
  const events = join(dir, 'events.jsonl');
  writeFileSync(events, run(says('broke', 'error', emptyUsage)).join('\n'));

  let code = 0;
  try {
    execFileSync('node', [cli, 'reduce', events], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    code = (error as { status: number }).status;
  }
  assert.equal(code, 1);
  const transcript = readFileSync(join(dir, 'transcript.md'), 'utf8');
  // Corrected: an `error` stop reason is not answer-bearing (design sec-5), so its
  // prose is body activity and the result block keeps the fallback.
  assert.match(transcript, /^## Result\n\(no assistant answer\)$/m);
  assert.match(transcript, /^broke$/m);
  const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'failed');
  assert.equal(status.schema, 'pi-run-status/2');
  assert.equal(status.requests_unmeasured, 1);
});

test('cli: alerts go to stderr, status line stays parseable; -q is silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reduce-'));
  const input = run(result('touched .doctrine/state/x'), assistant([{ type: 'text', text: 'ok' }])).join('\n');
  const stdout = execFileSync('node', [cli, 'reduce', '--out', dir, '--alert', '\\.doctrine/'], { input, encoding: 'utf8' });
  assert.match(stdout, /^completed /);
  const quiet = execFileSync('node', [cli, 'reduce', '--out', dir, '-q'], { input, encoding: 'utf8' });
  assert.equal(quiet, '');
});

test('cli: usage errors exit 2 and name the problem', () => {
  let code = 0;
  let stderr = '';
  try {
    execFileSync('node', [cli, 'reduce', '--budget-bytes', 'lots'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    code = (error as { status: number }).status;
    stderr = String((error as { stderr: string }).stderr);
  }
  assert.equal(code, 2);
  assert.match(stderr, /--budget-bytes needs a non-negative integer/);
});
