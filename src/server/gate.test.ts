// Tests for the gate (design sec-4's enforcement: the ceilings, the wall clock,
// the switch and usage sanity) and for the accounting it shares with the result.
//
// Unit cases drive the gate directly: `countRecord` — the same accumulator the
// spawn runs, never a second one — counts recorded event fixtures, and `tick` is
// handed that tally exactly as the spawn's `onRecord` seam hands it.
//
// Integration cases run the real ladder against a bash stub launcher this file
// writes into its own temp tree; the reporting cases drive the server in-process
// through `serve`, as `pi/mcp/spawn.test.ts` does. The stub records its pid into a
// marker directory OUTSIDE the run dir, and every spawning test registers a
// teardown that SIGKILLs the groups its stubs reported. Nothing touches the
// network, and nothing waits a real second: `graceMs` is 150-200 and `gateIdleMs`
// is 20-50 everywhere.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countRecord, reduce } from '../reduce/reduce.ts';
import type { Tally } from '../reduce/reduce.ts';
import { createGate } from './gate.ts';
import type { Gate, GateConfig } from './gate.ts';
import { serve } from './server.ts';
import type { ServeOptions } from './server.ts';

type Env = Record<string, string | undefined>;

const line = (message: Record<string, unknown>): string => JSON.stringify({ jsonrpc: '2.0', ...message });
const callLine = (id: number | string, args: Record<string, unknown>): string =>
  line({ id, method: 'tools/call', params: { name: 'pi_agent', arguments: args } });

/** A bash line that writes one event record on stdout, newline-terminated. */
function emit(record: Record<string, unknown>): string {
  return `printf '%s\\n' '${JSON.stringify(record)}'`;
}

/** `agent_settled`: the stream's own statement that the run came to rest. */
const SETTLED = emit({ type: 'agent_settled' });

const cost = (total: number): Record<string, number> => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total });

/** pi's `Usage` shape with every component present: missing data is then missing
 *  rather than a zero, which is the distinction usage sanity turns on. */
const usage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 110,
  cost: cost(0.01),
  ...overrides,
});

/** pi's `EMPTY_USAGE`: the zeros a failure message carries as a placeholder. */
const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: cost(0) };

const ev = (type: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ type, ...extra });

/** A usage-bearing assistant message: one send, priced. */
const messageEnd = (stopReason = 'stop', usageRecord: unknown = usage()): Record<string, unknown> => ({
  type: 'message_end',
  message: {
    role: 'assistant',
    stopReason,
    content: [{ type: 'text', text: 'the answer' }],
    model: 'test-model',
    usage: usageRecord,
  },
});

/** The same record as a stream line, for the fixtures counted directly. */
const send = (stopReason = 'stop', usageRecord: unknown = usage()): string =>
  JSON.stringify(messageEnd(stopReason, usageRecord));

/** A recorded retry/compaction trace: a failed send, its retry, a scheduled
 *  summarization retry and the compaction that answered it. */
const RETRY_FIXTURE: string[] = [
  ev('session', { version: 3, id: 'sess-1', cwd: '/repo' }),
  send('error', EMPTY_USAGE),
  ev('auto_retry_start', { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded' }),
  ev('auto_retry_end', { success: true, attempt: 2 }),
  send('stop'),
  ev('summarization_retry_scheduled', { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'terminated' }),
  ev('compaction_end', {
    reason: 'threshold',
    aborted: false,
    willRetry: false,
    result: { summary: 'Summary so far.', firstKeptEntryId: 'entry-1', tokensBefore: 150000, usage: usage({ cost: cost(0.2) }) },
  }),
  ev('agent_settled'),
];

/** An empty accumulator, shaped like the reducer's: the state a `Tally` has
 *  before its first record. */
const emptyTally = (): Tally => ({
  requests: 0,
  requests_unmeasured: 0,
  tokens: { input: 0, output: 0, cached: 0, cache_write: 0 },
  cost: null,
  accounting: 'known',
});

/** The accumulator as the spawn leaves it after the stream: every line counted by
 *  `countRecord`, the one writer of its units. */
const tallyOf = (lines: string[]): Tally => {
  const tally = emptyTally();
  for (const raw of lines) countRecord(JSON.parse(raw), tally);
  return tally;
};

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── The deployment: a root, a run dir, a session home, a policy over stubs ──

type Rig = {
  dir: string;
  /** Outside the run dir, so the child's own notes never mix with the evidence. */
  markerDir: string;
  runDir: string;
  sessionHome: string;
  root: string;
  policyPath: string;
  readLauncher: string;
  writeLauncher: string;
  /** The server's environment: the process's own plus this deployment's three. */
  env: Env;
};

/** The default stub: it settles and exits 0. */
const QUIET = `${SETTLED}\nexit 0`;

function stubLauncher(dir: string, name: string, body: string, markerDir: string): string {
  const path = join(dir, `${name}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${body.replaceAll('@MARKER@', markerDir)}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Write the policy this rig runs under; `patch` replaces a field wholesale. */
function writePolicy(rig: Rig, patch: Record<string, unknown> = {}): void {
  const document = {
    mode: 'per-call',
    roots: [rig.root],
    maxima: { requests: 20, tokens: 100000, cost_usd: 1.5, wall_clock_s: 600 },
    profiles: ['read', 'write'],
    forms: { read: rig.readLauncher, write: rig.writeLauncher },
    child_binds: [],
    enabled: true,
    transcript_budget_bytes: 4096,
    ...patch,
  };
  writeFileSync(rig.policyPath, `${JSON.stringify(document)}\n`);
}

/** Change one field of the policy on disk, as an operator's flip would. */
function patchPolicy(rig: Rig, field: string, value: unknown): void {
  const policy = JSON.parse(readFileSync(rig.policyPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(rig.policyPath, JSON.stringify({ ...policy, [field]: value }));
}

/** Kill every group a stub reported, ignoring one that is already gone. */
function killSurvivors(markerDir: string): void {
  for (const name of readdirSync(markerDir)) {
    if (!name.endsWith('pid') && !name.endsWith('pids')) continue;
    for (const raw of readText(join(markerDir, name)).split('\n')) {
      const pid = Number(raw.trim());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }
}

function newRig(t: TestContext, readBody: string = QUIET, policyPatch: Record<string, unknown> = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-gate-'));
  const markerDir = join(dir, 'markers');
  mkdirSync(markerDir);
  const root = join(dir, 'root');
  mkdirSync(root);
  const runDir = join(dir, 'run');
  const sessionHome = join(dir, 'sessions');
  const policyPath = join(dir, 'policy.json');
  const rig: Rig = {
    dir,
    markerDir,
    runDir,
    sessionHome,
    root,
    policyPath,
    readLauncher: stubLauncher(dir, 'pi-mcp-read', readBody, markerDir),
    writeLauncher: stubLauncher(dir, 'pi-mcp-write', QUIET, markerDir),
    env: {
      ...process.env,
      PI_MCP_POLICY: policyPath,
      PI_MCP_RUN_DIR: runDir,
      PI_MCP_SESSION_HOME: sessionHome,
    },
  };
  writePolicy(rig, policyPatch);
  t.after(() => {
    killSurvivors(markerDir);
    rmSync(dir, { recursive: true, force: true });
  });
  return rig;
}

/** A gate over the rig's policy, recording what it aborts with and resolving a
 *  promise on the first trigger — the abort is `controller.abort` in the server. */
function unitGate(rig: Rig, overrides: Partial<GateConfig> = {}): { gate: Gate; causes: string[]; aborted: Promise<string> } {
  const causes: string[] = [];
  let settle: (cause: string) => void = () => {};
  const aborted = new Promise<string>((resolve) => (settle = resolve));
  const gate = createGate({
    ceilings: {},
    policyPath: rig.policyPath,
    abort: (cause) => {
      causes.push(cause);
      settle(cause);
    },
    idleMs: 20,
    ...overrides,
  });
  return { gate, causes, aborted };
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForPath(path: string, what = path, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(5);
  }
}

function markerPid(rig: Rig, name = 'pid'): number {
  return Number(readText(join(rig.markerDir, name)).trim());
}

/** A JSONL file as records: the run's audit. */
function jsonLines(path: string): Record<string, any>[] {
  return readText(path)
    .split('\n')
    .filter((raw) => raw.length > 0)
    .map((raw) => JSON.parse(raw) as Record<string, any>);
}

/** A server in this process, with an input channel the test owns. */
type Session = {
  replies: () => Record<string, any>[];
  write: (record: string) => void;
  end: () => void;
  done: Promise<void>;
  stderr: () => string;
};

function openServer(env: Env, options: ServeOptions = {}): Session {
  const out: string[] = [];
  const err: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      out.push(String(chunk));
      done();
    },
  });
  const diagnostics = new Writable({
    write(chunk, _encoding, done) {
      err.push(String(chunk));
      done();
    },
  });
  const input = new PassThrough();
  const done = serve(input, output, env, diagnostics, options);
  return {
    replies: () =>
      out
        .join('')
        .split('\n')
        .filter((raw) => raw.length > 0)
        .map((raw) => JSON.parse(raw) as Record<string, any>),
    write: (record) => input.write(`${record}\n`),
    end: () => input.end(),
    done,
    stderr: () => err.join(''),
  };
}

async function waitForReplies(session: Session, count: number, timeoutMs = 10000): Promise<Record<string, any>[]> {
  const deadline = Date.now() + timeoutMs;
  while (session.replies().length < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} replies: ${session.stderr()}`);
    await pause(5);
  }
  return session.replies();
}

/** The pi-agent-result/1 document inside one tool result. */
function document(reply: Record<string, any>): Record<string, any> {
  assert.equal(reply.error, undefined, 'a call must never surface as a JSON-RPC error');
  return JSON.parse(reply.result.content[0].text) as Record<string, any>;
}

/** End one server after its answers, and wait for its cleanup. */
async function closeServer(session: Session): Promise<void> {
  session.end();
  await session.done;
}

// ── VT-1: a crossing aborts, per unit, through the same abort hook ─────────

test('ceiling: a requests, tokens and cost_usd crossing each abort with cause ceiling and the value it observed (VT-1)', (t) => {
  const rig = newRig(t);
  // Two counted sends: 2 requests, 220 tokens, 0.02 usd — the accumulator's units.
  const tally = tallyOf([send('toolUse'), send('stop')]);

  const crossings = [
    { unit: 'requests', ceilings: { requests: 1 }, observed: 2, limit: 1 },
    { unit: 'tokens', ceilings: { tokens: 200 }, observed: 220, limit: 200 },
    { unit: 'cost_usd', ceilings: { cost_usd: 0.01 }, observed: 0.02, limit: 0.01 },
  ];
  for (const crossing of crossings) {
    const { gate, causes } = unitGate(rig, { ceilings: crossing.ceilings });
    gate.tick(tally);
    gate.close();

    assert.deepEqual(causes, ['ceiling'], `${crossing.unit} crossing aborts`);
    assert.equal(gate.cause(), 'ceiling');
    assert.equal(gate.triggers().length, 1, 'one crossing is one trigger');
    const [trigger] = gate.triggers();
    assert.equal(trigger.unit, crossing.unit);
    assert.equal(trigger.observed, crossing.observed, 'the trigger carries the observed value');
    assert.equal(trigger.limit, crossing.limit);
  }

  // A ceiling a unit does not exceed fires nothing: a value equal to the bound is
  // within it, and a gate that has not fired reports no trigger.
  const { gate, causes } = unitGate(rig, { ceilings: { requests: 2, tokens: 220, cost_usd: 0.02 } });
  gate.tick(tally);
  gate.close();
  assert.deepEqual(causes, [], 'no crossing, no abort');
  assert.deepEqual(gate.triggers(), []);
  assert.equal(gate.cause(), null);
});

// ── VT-2: one accumulator — the gate's inputs are the returned status ──────

test('the gate judges the numbers the status reports: a retry/compaction fixture through one accumulator (VT-2)', (t) => {
  const rig = newRig(t);
  const reduced = reduce(RETRY_FIXTURE);
  const tally = tallyOf(RETRY_FIXTURE);

  // Enforcement and reporting cannot disagree: the tick is handed the accumulator
  // that produced this status, not a lookalike.
  assert.equal(tally.requests, reduced.status.requests);
  assert.equal(tally.requests_unmeasured, reduced.status.requests_unmeasured);
  assert.equal(tally.requests_unmeasured, 2, 'the failed send and the scheduled retry are requests_unmeasured');
  assert.equal(tally.cost, reduced.status.cost_usd);
  assert.equal(reduced.requests, tally.requests, 'the reducer and the fixture agree on the count');

  // Ticked, the ceiling fires on exactly the status's number.
  const { gate, causes } = unitGate(rig, { ceilings: { requests: reduced.status.requests - 1 } });
  gate.tick(tally);
  gate.close();
  assert.deepEqual(causes, ['ceiling']);
  const [trigger] = gate.triggers();
  assert.equal(trigger.observed, reduced.status.requests, 'the crossing names the status\'s request count');

  // The same for cost: the gate's observed cost is the status's cost_usd.
  const byCost = unitGate(rig, { ceilings: { cost_usd: reduced.status.cost_usd - 0.001 } });
  byCost.gate.tick(tally);
  byCost.gate.close();
  assert.deepEqual(byCost.causes, ['ceiling']);
  assert.equal(byCost.gate.triggers()[0].observed, reduced.status.cost_usd);
});

// ── VT-3 / VT-4: the switch, and the policy source it reads ────────────────

test('switch: a flip to enabled:false is caught by an idle tick with no new record, and aborts through the ladder (VT-3)', async (t) => {
  const rig = newRig(t);
  const { gate, aborted } = unitGate(rig, { idleMs: 20 });
  // The spawn's seam hands the gate the fresh tally before the first byte, so the
  // idle poll has something to judge while the child is silent.
  gate.tick(emptyTally());
  assert.equal(gate.cause(), null, 'an enabled policy and a quiet child fire nothing');

  patchPolicy(rig, 'enabled', false);
  assert.equal(await within(aborted, 2000, 'the switch'), 'switch', 'no record arrived: the idle tick found it');
  assert.deepEqual(gate.triggers(), [{ cause: 'switch', unit: 'enabled', observed: null, limit: null }]);
  gate.close();
});

test('switch: a policy deleted mid-run aborts the run — policy-unavailable is not evidence that the switch is off (VT-4)', async (t) => {
  const rig = newRig(t);
  const { gate, aborted } = unitGate(rig);
  gate.tick(emptyTally());

  rmSync(rig.policyPath);
  assert.equal(await within(aborted, 2000, 'the switch'), 'switch');
  assert.equal(gate.cause(), 'switch');
  gate.close();
});

test('switch: a policy corrupted mid-run aborts the run — an unparsable source is policy-invalid, not silence (VT-4)', async (t) => {
  const rig = newRig(t);
  const { gate, aborted } = unitGate(rig);
  gate.tick(emptyTally());

  writeFileSync(rig.policyPath, '{ this is not json');
  assert.equal(await within(aborted, 2000, 'the switch'), 'switch');
  assert.equal(gate.cause(), 'switch');
  gate.close();
});

test('a maximum lowered mid-run does not reach the run: the admission snapshot judges it (EX-4)', async (t) => {
  const rig = newRig(t);
  // The snapshot allows one request; the tick then sees the policy's maximum
  // lowered to zero, and ignores it: the re-read supplies the switch, never the
  // bounds.
  const { gate, causes } = unitGate(rig, { ceilings: { requests: 1 } });
  gate.tick(tallyOf([send('stop')]));
  patchPolicy(rig, 'maxima', { requests: 0, tokens: 0, cost_usd: 0, wall_clock_s: 600 });
  await pause(80);
  gate.close();
  assert.deepEqual(causes, [], 'the snapshot judges the run, not the re-read maxima');
  assert.deepEqual(gate.triggers(), []);
});

// ── VT-5: usage sanity, and the wall-clock backstop ────────────────────────

test('usage sanity: absent, non-finite or negative usage aborts accounting (state accounting_unknown); EMPTY_USAGE and a zero-priced read do not (VT-5)', (t) => {
  const rig = newRig(t);

  const unsound: { label: string; line: string }[] = [
    { label: 'usage without cost.total', line: send('stop', { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 }) },
    // `1e999` is a JSON number that parses to a non-finite value: the accumulator
    // refuses it rather than reading it as headroom.
    {
      label: 'non-finite component',
      line: '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","usage":{"input":1e999,"output":2,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.01}}}}',
    },
    { label: 'negative component', line: send('stop', usage({ input: -10, totalTokens: 100 })) },
  ];
  for (const case_ of unsound) {
    const tally = tallyOf([case_.line]);
    assert.equal(tally.accounting, 'unknown', `${case_.label} marks accounting unknown`);
    const { gate, causes } = unitGate(rig);
    gate.tick(tally);
    gate.close();
    assert.deepEqual(causes, ['accounting'], `${case_.label} aborts accounting`);
    const [trigger] = gate.triggers();
    assert.equal(trigger.unit, 'accounting');
  }

  // A failure message's placeholder zeros are unmeasured, not a fatal
  // accounting_unknown: every provider error would otherwise end the run.
  const failed = tallyOf([send('error', EMPTY_USAGE)]);
  assert.equal(failed.accounting, 'known');
  assert.equal(failed.requests_unmeasured, 1);
  const placeholder = unitGate(rig);
  placeholder.gate.tick(failed);
  placeholder.gate.close();
  assert.deepEqual(placeholder.causes, [], 'EMPTY_USAGE does not abort');

  // A cached read priced at zero is a price, not missing data.
  const cached = tallyOf([send('stop', usage({ cacheRead: 5000, totalTokens: 5000, cost: cost(0) }))]);
  assert.equal(cached.accounting, 'known');
  assert.equal(cached.tokens.cached, 5000);
  assert.equal(cached.cost, 0);
  const priced = unitGate(rig, { ceilings: { cost_usd: 0.005, tokens: 100000 } });
  priced.gate.tick(cached);
  priced.gate.close();
  assert.deepEqual(priced.causes, [], 'a zero-priced cached read does not abort');
});

test('timeout: the wall clock aborts with cause timeout, however quiet the child is (VT-5)', async (t) => {
  const rig = newRig(t);
  const { gate, aborted } = unitGate(rig, {
    ceilings: { wall_clock_s: 0.05 },
    startedAt: Date.now() - 100,
    idleMs: 10,
  });
  gate.tick(emptyTally());
  assert.equal(await within(aborted, 2000, 'the wall clock'), 'timeout');
  const [trigger] = gate.triggers();
  assert.equal(trigger.unit, 'wall_clock_s');
  assert.equal(trigger.limit, 0.05);
  assert.ok((trigger.observed as number) >= 0.1, `observed ${trigger.observed} s`);
  gate.close();
});

// ── EX-1 / VT-1: a live crossing, the ladder, and the abort record ─────────

test('ceiling: a live crossing aborts the run through the ladder, and the abort record carries the accumulator usage (EX-1)', async (t) => {
  const rig = newRig(
    t,
    [`printf '%s\\n' $$ > "@MARKER@/pid"`, emit(messageEnd('stop')), SETTLED, 'exit 0'].join('\n'),
    { maxima: { requests: 20, tokens: 100000, cost_usd: 0.005, wall_clock_s: 600 } },
  );
  const session = openServer(rig.env, { graceMs: 150, gateIdleMs: 20 });
  session.write(callLine(1, { prompt: 'spend', profile: 'read', cwd: rig.root, session: 'ceiling1' }));
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');
  const [reply] = await waitForReplies(session, 1);
  await closeServer(session);

  const doc = document(reply);
  assert.equal(doc.state, 'ceiling_exceeded', JSON.stringify(doc));
  assert.equal(doc.termination, 'ceiling');
  assert.deepEqual(doc.causes, ['ceiling']);
  assert.equal(doc.status.cost_usd, 0.01, 'the status is the accumulator that crossed');

  const audit = jsonLines(doc.artifacts.audit);
  const abort = audit.find((record) => record.record === 'abort');
  assert.ok(abort, `an abort record is owed: ${JSON.stringify(audit)}`);
  assert.equal(abort.cause, 'ceiling');
  assert.ok(abort.usage.requests >= 1, 'the abort record carries the accumulator\'s usage');
  assert.equal(abort.usage.cost_usd, 0.01, 'the usage is the accumulator\'s at the crossing');
  assert.equal(isAlive(markerPid(rig)), false, 'the child is gone');
});

// ── EX-3 / VT-3: the switch halts an in-flight run ────────────────────────

test('switch: flipping enabled to false halts an in-flight run through the ladder, and the next call is refused (EX-3, VT-3)', async (t) => {
  const rig = newRig(t, [`printf '%s\\n' $$ > "@MARKER@/pid"`, 'sleep 60'].join('\n'));
  const session = openServer(rig.env, { graceMs: 150, gateIdleMs: 20 });
  session.write(callLine(1, { prompt: 'stall', profile: 'read', cwd: rig.root, session: 'switch1' }));
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');

  // No driver cooperation: the child is asleep, and the operator's flip is the
  // only thing that happened.
  patchPolicy(rig, 'enabled', false);
  const [reply] = await waitForReplies(session, 1);

  const doc = document(reply);
  assert.equal(doc.state, 'failed', 'a switch leaves the run failed, not a counting verdict');
  assert.equal(doc.termination, 'switch');
  assert.deepEqual(doc.causes, ['switch']);
  const abort = jsonLines(doc.artifacts.audit).find((record) => record.record === 'abort');
  assert.equal(abort?.cause, 'switch', 'the ladder audited the switch');
  assert.equal(isAlive(markerPid(rig)), false, 'no child left behind');

  // The flip also refuses the next call at admission.
  session.write(callLine(2, { prompt: 'again', profile: 'read', cwd: rig.root, session: 'switch2' }));
  const [, refused] = await waitForReplies(session, 2);
  await closeServer(session);
  const next = document(refused);
  assert.equal(next.state, 'refused');
  assert.equal(next.refusal.reason, 'disabled');
});

// ── EX-4 / VT-4: policy loss fails closed, live ───────────────────────────

test('switch: a policy deleted during an idle run aborts it, and the next call is refused policy-unavailable (EX-4, VT-4)', async (t) => {
  const rig = newRig(t, [`printf '%s\\n' $$ > "@MARKER@/pid"`, 'sleep 60'].join('\n'));
  const session = openServer(rig.env, { graceMs: 150, gateIdleMs: 20 });
  session.write(callLine(1, { prompt: 'stall', profile: 'read', cwd: rig.root, session: 'lost1' }));
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');

  rmSync(rig.policyPath);
  const [reply] = await waitForReplies(session, 1);
  const doc = document(reply);
  assert.equal(doc.termination, 'switch');
  const abort = jsonLines(doc.artifacts.audit).find((record) => record.record === 'abort');
  assert.equal(abort?.cause, 'switch', 'a source that cannot be read is not evidence the switch is off');
  assert.equal(isAlive(markerPid(rig)), false, 'no child left behind');

  session.write(callLine(2, { prompt: 'again', profile: 'read', cwd: rig.root, session: 'lost2' }));
  const [, refused] = await waitForReplies(session, 2);
  await closeServer(session);
  assert.equal(document(refused).refusal.reason, 'policy-unavailable');
});

test('switch: a policy corrupted during an idle run aborts it, and the next call is refused policy-invalid (EX-4, VT-4)', async (t) => {
  const rig = newRig(t, [`printf '%s\\n' $$ > "@MARKER@/pid"`, 'sleep 60'].join('\n'));
  const session = openServer(rig.env, { graceMs: 150, gateIdleMs: 20 });
  session.write(callLine(1, { prompt: 'stall', profile: 'read', cwd: rig.root, session: 'broken1' }));
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');

  writeFileSync(rig.policyPath, '{"mode": "per-call", "roots": [');
  const [reply] = await waitForReplies(session, 1);
  const doc = document(reply);
  assert.equal(doc.termination, 'switch');
  const abort = jsonLines(doc.artifacts.audit).find((record) => record.record === 'abort');
  assert.equal(abort?.cause, 'switch', 'an unparsable source fails closed');
  assert.equal(isAlive(markerPid(rig)), false, 'no child left behind');

  session.write(callLine(2, { prompt: 'again', profile: 'read', cwd: rig.root, session: 'broken2' }));
  const [, refused] = await waitForReplies(session, 2);
  await closeServer(session);
  assert.equal(document(refused).refusal.reason, 'policy-invalid');
});

// ── EX-6: the wall clock, and a clean run's empty audit ───────────────────

test('timeout: the wall clock halts a stalled run with cause timeout and its own state row (EX-6)', async (t) => {
  const rig = newRig(
    t,
    [`printf '%s\\n' $$ > "@MARKER@/pid"`, 'sleep 60'].join('\n'),
    { maxima: { requests: 20, tokens: 100000, cost_usd: 1.5, wall_clock_s: 0.2 } },
  );
  const session = openServer(rig.env, { graceMs: 150, gateIdleMs: 20 });
  session.write(callLine(1, { prompt: 'stall', profile: 'read', cwd: rig.root, session: 'backstop1' }));
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');
  const [reply] = await waitForReplies(session, 1);
  await closeServer(session);

  const doc = document(reply);
  assert.equal(doc.termination, 'timeout');
  assert.equal(doc.state, 'timeout', 'the backstop has its own state row');
  assert.deepEqual(doc.causes, ['timeout']);
  const abort = jsonLines(doc.artifacts.audit).find((record) => record.record === 'abort');
  assert.equal(abort?.cause, 'timeout');
  assert.equal(isAlive(markerPid(rig)), false, 'the child is gone');
});

test('usage sanity live: an unpriced send halts the run as accounting_unknown (EX-5)', async (t) => {
  const rig = newRig(
    t,
    [
      `printf '%s\\n' $$ > "@MARKER@/pid"`,
      // A usage-bearing message whose `cost.total` is absent: missing data, never
      // a priced zero.
      emit(messageEnd('stop', { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 })),
      'sleep 60',
    ].join('\n'),
  );
  const session = openServer(rig.env, { graceMs: 150, gateIdleMs: 20 });
  session.write(callLine(1, { prompt: 'unpriced', profile: 'read', cwd: rig.root, session: 'accounting1' }));
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');
  const [reply] = await waitForReplies(session, 1);
  await closeServer(session);

  const doc = document(reply);
  assert.equal(doc.state, 'accounting_unknown', JSON.stringify(doc));
  assert.equal(doc.termination, 'accounting');
  assert.equal(doc.status.accounting, 'unknown');
  const abort = jsonLines(doc.artifacts.audit).find((record) => record.record === 'abort');
  assert.equal(abort?.cause, 'accounting');
  assert.equal(isAlive(markerPid(rig)), false, 'the child is gone');
});

test('a run that hits no limit completes, and its audit has no abort record (EX-6)', async (t) => {
  const rig = newRig(t, [`printf '%s\\n' $$ > "@MARKER@/pid"`, emit(messageEnd('stop')), SETTLED, 'exit 0'].join('\n'));
  const session = openServer(rig.env, { graceMs: 150, gateIdleMs: 20 });
  session.write(callLine(1, { prompt: 'work', profile: 'read', cwd: rig.root, session: 'clean1' }));
  const [reply] = await waitForReplies(session, 1);
  await closeServer(session);

  const doc = document(reply);
  assert.equal(doc.state, 'completed', JSON.stringify(doc));
  assert.equal(doc.termination, 'stop');
  const records = jsonLines(doc.artifacts.audit).map((record) => record.record);
  assert.deepEqual(records, ['spawn', 'exit'], 'no abort record on a run that hit no limit');
});

// ── EX-7 / VT-6: nested spend is neither attributed nor claimed ────────────

test('a nested figure named in a tool result is not attributed to the run: cost_usd is the run\'s own send (EX-7, VT-6)', async (t) => {
  const rig = newRig(
    t,
    [
      emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'curl -s gateway/spend' } }),
      emit({
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'the nested run spent 9.99' }], structuredContent: { exit_code: 0 } },
        isError: false,
      }),
      emit(messageEnd('stop')),
      SETTLED,
      'exit 0',
    ].join('\n'),
  );
  const session = openServer(rig.env, { graceMs: 150, gateIdleMs: 20 });
  session.write(callLine(1, { prompt: 'call a nested agent', profile: 'read', cwd: rig.root, session: 'nested1' }));
  const [reply] = await waitForReplies(session, 1);
  await closeServer(session);

  const doc = document(reply);
  assert.equal(doc.state, 'completed', JSON.stringify(doc));
  // One real send, priced at 0.01: the status describes this run's own sends.
  assert.equal(doc.status.cost_usd, 0.01, 'the run\'s own send is the whole of cost_usd');
  assert.equal(doc.status.requests, 1);
  // The text is carried verbatim in the transcript, and nowhere in the accounting:
  // the nested figure is not attributed to the run, and no field claims it is.
  assert.ok(doc.transcript.includes('9.99'), 'the tool result\'s text stays verbatim in the transcript');
  assert.ok(!JSON.stringify(doc.status).includes('9.99'), 'nested spend is not attributed to the run\'s status');
});
