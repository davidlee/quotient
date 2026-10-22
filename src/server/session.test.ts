// Tests for the session contract (design sec-2 step 7, sec-6 "Sessions (DEC-099,
// amended)"): the mint and its grammar, ownership of one session by one process,
// the (root, capability) binding written on first use, and stale reclamation.
//
// The cross-process cases are driven by real child processes over a temp state
// root. Nothing here waits on a clock: a `fork`ed caller holds the lock until it
// is told to exit, and a stale lock is a *written precondition* — a record for a
// pid whose kernel start time is not the one running now, which is exactly the
// pid-reuse case (EX-6) and is deterministically stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_GRAMMAR, acquireSession, isSessionId, mintSessionId, processStartTime, releaseSession, sessionPaths } from './session.ts';
import type { SessionPaths } from './session.ts';
import { attempts } from './test-rig.ts';

const SESSION_MODULE = new URL('./session.ts', import.meta.url).href;

// The caller the tests drive: an ordinary process using session.ts, never the
// server. `fork`ed for the cases that need a second live owner; `spawnSync`ed for
// the one-shot cases. It says `ready` before it is told what to do, and reports
// one JSON message per step, so no assertion rests on a sleep.
const HELPER_SOURCE = `
const { acquireSession } = await import(process.env.QUOTIENT_SESSION_MODULE);

function describe(acquisition) {
  if (acquisition.ok) return { ok: true, session: acquisition.session, sessionDir: acquisition.sessionDir };
  return { ok: false, reason: acquisition.reason, detail: acquisition.detail };
}

// One-shot mode: spawnSync a caller, read one line, exit.
if (typeof process.send !== 'function') {
  const acquisition = acquireSession(JSON.parse(process.env.QUOTIENT_SESSION_CALL));
  process.stdout.write(JSON.stringify(describe(acquisition)) + '\\n');
  if (acquisition.ok) acquisition.release();
  process.exit(0);
}

let held = null;
let stopping = false;

process.send({ ready: true });

process.on('message', async (message) => {
  if (message.action === 'acquire') {
    const acquisition = acquireSession(message.options);
    process.send(describe(acquisition));
    if (!acquisition.ok) process.exit(0);
    if (message.hold) {
      held = acquisition;
      return;
    }
    acquisition.release();
    process.exit(0);
  }
  if (message.action === 'probe') {
    const { openSync } = await import('node:fs');
    let attempts = 0;
    let won = 0;
    process.send({ probing: true });
    while (!stopping) {
      attempts += 1;
      try {
        openSync(message.lock, 'wx');
        won += 1;
      } catch {
        // EEXIST is the requirement: creation needs an absent path.
      }
      if (attempts % 500 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    process.send({ attempts: attempts, won: won });
    process.exit(0);
  }
  if (message.action === 'stop') {
    stopping = true;
    return;
  }
  if (message.action === 'exit') {
    if (held !== null) held.release();
    process.exit(0);
  }
});
`;

type State = { dir: string; home: string; runDir: string; helperPath: string };

/** A fresh temp tree: a session home that does not exist yet, a run dir, a helper. */
function state(): State {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-session-'));
  const helperPath = join(dir, 'caller.mjs');
  writeFileSync(helperPath, HELPER_SOURCE);
  return { dir, home: join(dir, 'home'), runDir: join(dir, 'run'), helperPath };
}

type CallerMessage = Record<string, any>;

/** A forked caller with an IPC handshake: `next()` resolves its next message. */
class Caller {
  readonly child: ChildProcess;
  private readonly queue: CallerMessage[] = [];
  private readonly waiters: { resolve: (message: CallerMessage) => void; reject: (error: Error) => void }[] = [];

  constructor(child: ChildProcess) {
    this.child = child;
    child.on('message', (message) => {
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter.resolve(message as CallerMessage);
      else this.queue.push(message as CallerMessage);
    });
    child.on('exit', (code, signal) => {
      const death = `exited (code ${String(code)}, signal ${String(signal)})`;
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(new Error(`the caller ${death} before answering`));
      }
    });
    child.on('error', (error) => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
  }

  get pid(): number {
    return this.child.pid as number;
  }

  send(message: unknown): void {
    this.child.send(message as never);
  }

  next(): Promise<CallerMessage> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<CallerMessage>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.send({ action: 'exit' });
    await exited;
  }
}

/** Enough of a test context to register cleanup on. */
type Cleanup = { after: (fn: () => Promise<void> | void) => void };

/** Stop a caller that is still running, whatever it is doing. */
async function dispose(caller: Caller): Promise<void> {
  if (caller.child.exitCode !== null || caller.child.signalCode !== null) return;
  caller.child.kill('SIGKILL');
  await new Promise((resolve) => caller.child.once('exit', resolve));
}

/**
 * Fork COUNT callers and wait until each has announced it is ready. They are
 * disposed of by the test's own cleanup, so a failed assertion cannot leave a
 * child holding the run open.
 */
async function callers(context: Cleanup, helperPath: string, count: number): Promise<Caller[]> {
  const forked = Array.from(
    { length: count },
    () =>
      new Caller(
        fork(helperPath, [], {
          env: { ...process.env, QUOTIENT_SESSION_MODULE: SESSION_MODULE },
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        }),
      ),
  );
  context.after(async () => {
    await Promise.all(forked.map(dispose));
  });
  await Promise.all(forked.map((caller) => caller.next()));
  return forked;
}

/** The kernel start time of a pid the test's own pid table reports. */
function ownStartTime(): string {
  const observed = processStartTime('/proc', process.pid);
  assert.equal(observed.ok, true, 'the test process must be visible in /proc');
  return observed.ok ? observed.starttime : '';
}

/**
 * A stale ownership record, written rather than hoped for: this test's own pid
 * with a start time that is not the running process's, which is the pid-reuse
 * case — the pid exists, the owner does not (EX-6).
 */
function staleOwner(session: string): Record<string, unknown> {
  const starttime = ownStartTime();
  return {
    session,
    pid: process.pid,
    starttime: String(Number(starttime) + 1),
    call_id: 'stale-caller',
    started: new Date(Date.now() - 60_000).toISOString(),
    root: '/work/one',
    capability: 'read',
  };
}

/** Write a lock record and return the state layout it sits in. */
function writeLock(home: string, session: string, record: Record<string, unknown>): SessionPaths {
  const paths = sessionPaths(home, session);
  mkdirSync(paths.sessions, { recursive: true, mode: 0o700 });
  writeFileSync(paths.lock, `${JSON.stringify(record)}\n`);
  return paths;
}

function readRecord(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

// ── The mint, the grammar and the layout (EX-1, EX-9) ──────────────────────

test('a call with no session mints one and lays out owner-only state beside it (EX-1, EX-9)', () => {
  const { home, runDir } = state();
  const acquisition = acquireSession({ sessionHome: home, runDir, root: '/work/one', capability: 'read', callId: 7 });
  assert.equal(acquisition.ok, true);
  if (!acquisition.ok) return;

  assert.ok(isSessionId(acquisition.session), 'a minted id matches the session grammar');
  assert.equal(acquisition.sessionDir, join(home, acquisition.session));
  assert.equal(mode(acquisition.sessionDir), 0o700, 'the session directory is owner-only');
  assert.equal(mode(home), 0o700, 'the session home is owner-only');
  assert.equal(mode(join(home, 'sessions')), 0o700);

  // Binding and lock metadata live beside the session directory, never inside it:
  // PHASE-05's child view and PHASE-06's bind both depend on this shape (EX-9).
  assert.deepEqual(readdirSync(home).sort(), [acquisition.session, 'sessions'].sort());
  assert.deepEqual(readdirSync(join(home, 'sessions')).sort(), [
    `${acquisition.session}.binding`,
    `${acquisition.session}.lock`,
  ]);
  assert.deepEqual(readdirSync(acquisition.sessionDir), []);

  const record = readRecord(join(home, 'sessions', `${acquisition.session}.lock`));
  assert.equal(record.session, acquisition.session);
  assert.equal(record.pid, process.pid);
  assert.equal(record.starttime, ownStartTime());
  assert.equal(record.call_id, 7);
  assert.equal(record.root, '/work/one');
  assert.equal(record.capability, 'read');
  assert.match(String(record.started), /^\d{4}-\d{2}-\d{2}T/);

  acquisition.release();
  assert.equal(existsSync(join(home, 'sessions', `${acquisition.session}.lock`)), false);
  assert.equal(
    existsSync(join(home, 'sessions', `${acquisition.session}.binding`)),
    true,
    'the binding survives the release: it is the session, not the call',
  );
});

test('the grammar accepts one alnum character and refuses a trailing "." "_" or "-" as session-invalid (EX-1)', () => {
  for (const valid of ['a', '7', 'a.b_c-9', 'A'.repeat(64), `a${'b'.repeat(62)}9`]) {
    assert.equal(isSessionId(valid), true, `${valid} must be a session id`);
  }
  assert.match(mintSessionId(), /^[0-9a-f]{32}$/, 'a minted id is alnum from the CSPRNG');

  const refused = ['', 'a'.repeat(65), '.abc', '_abc', '-abc', 'abc.', 'abc_', 'abc-', 'a/b', 'a b', 'a\u0000'];
  for (const invalid of refused) {
    assert.equal(isSessionId(invalid), false, `${JSON.stringify(invalid)} must not be a session id`);
    const { home, runDir } = state();
    const acquisition = acquireSession({
      sessionHome: home,
      runDir,
      session: invalid,
      root: '/work/one',
      capability: 'read',
      callId: 1,
    });
    assert.equal(acquisition.ok, false);
    if (acquisition.ok) return;
    assert.equal(acquisition.reason, 'session-invalid');
    assert.ok(acquisition.detail.includes(SESSION_GRAMMAR.source), 'the refusal names the grammar');
    assert.equal(existsSync(home), false, 'a refused grammar creates no state at all');
  }
});

// ── One owner across processes (EX-2) ──────────────────────────────────────

test('a second caller is refused session-busy while the first holds the lock (EX-2)', () => {
  const { home, runDir, helperPath } = state();
  const held = acquireSession({ sessionHome: home, runDir, session: 'oneshot', root: '/work/one', capability: 'read', callId: 1 });
  assert.equal(held.ok, true);
  if (!held.ok) return;

  const child = spawnSync(process.execPath, [helperPath], {
    env: {
      ...process.env,
      QUOTIENT_SESSION_MODULE: SESSION_MODULE,
      QUOTIENT_SESSION_CALL: JSON.stringify({
        sessionHome: home,
        runDir,
        session: 'oneshot',
        root: '/work/one',
        capability: 'read',
        callId: 2,
      }),
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const answer = JSON.parse(child.stdout.trim()) as Record<string, any>;
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'session-busy');
  assert.match(String(answer.detail), /owned by pid/);

  // The loser wrote nothing: one lock (the holder's), one binding, no claim.
  const paths = sessionPaths(home, 'oneshot');
  assert.deepEqual(readdirSync(paths.sessions).sort(), ['oneshot.binding', 'oneshot.lock']);
  assert.equal(readRecord(paths.lock).pid, process.pid);
  held.release();
});

test('a refused acquisition creates no session directory: the layout is made only once the lock is this call\'s (EX-2)', () => {
  const { home, runDir } = state();
  const session = 's9';
  // A live owner, written rather than hoped for: this process's pid AND its own
  // kernel start time name the same owner, so the lock is alive and not reclaimable.
  const paths = writeLock(home, session, {
    session,
    pid: process.pid,
    starttime: ownStartTime(),
    call_id: 'the-other-caller',
    started: new Date().toISOString(),
    root: '/work/one',
    capability: 'read',
  });
  assert.equal(existsSync(paths.sessionDir), false, 'nothing has created the session directory yet');

  const refused = acquireSession({ sessionHome: home, runDir, session, root: '/work/one', capability: 'read', callId: 5 });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.reason, 'session-busy');
  assert.match(refused.detail, /owned by pid/);
  // The loser leaves no side effect behind: <home>/<id> is the layout the winner
  // would have used, and a refused call never makes it.
  assert.equal(existsSync(paths.sessionDir), false, 'a refused call creates no session directory');
  assert.equal(existsSync(paths.sessions), true, 'the metadata directory the lock lives in stays');
  assert.equal(readRecord(paths.lock).pid, process.pid, 'the live owner keeps its lock');
});

test('two forked callers racing for one session: exactly one owns it, the other is refused session-busy (EX-2)', async (t) => {
  const { home, runDir, helperPath } = state();
  const session = 'race';
  const raced = await callers(t, helperPath, 2);
  const options = { sessionHome: home, runDir, session, root: '/work/one', capability: 'read', callId: 1 };
  for (const caller of raced) caller.send({ action: 'acquire', options, hold: true });
  const answers = await Promise.all(raced.map((caller) => caller.next()));

  const winners = answers.filter((answer) => answer.ok === true);
  const losers = answers.filter((answer) => answer.ok === false);
  assert.equal(winners.length, 1, 'exactly one caller acquires the session');
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason, 'session-busy');

  const winnerIndex = answers.findIndex((answer) => answer.ok === true);
  const paths = sessionPaths(home, session);
  assert.equal(readRecord(paths.lock).pid, raced[winnerIndex].pid, 'the lock carries the winner');
  assert.deepEqual(readdirSync(paths.sessions).sort(), [`${session}.binding`, `${session}.lock`]);

  await Promise.all(raced.map((caller) => caller.stop()));
  assert.equal(existsSync(paths.lock), false, 'the owner released the lock last, on the way out');
});

// ── The first-use binding (EX-3) ───────────────────────────────────────────

test('a first-use race with conflicting roots binds exactly once; another root or capability is refused (EX-3)', async (t) => {
  const { home, runDir, helperPath } = state();
  const session = 'bind';
  const roots = ['/work/one', '/work/two'];
  const raced = await callers(t, helperPath, 2);
  raced.forEach((caller, index) => caller.send({ action: 'acquire', hold: true, options: { sessionHome: home, runDir, session, root: roots[index], capability: 'read', callId: index } }));
  const answers = await Promise.all(raced.map((caller) => caller.next()));

  const winnerIndex = answers.findIndex((answer) => answer.ok === true);
  assert.equal(answers.filter((answer) => answer.ok === true).length, 1, 'exactly one pair is recorded');
  assert.equal(answers[1 - winnerIndex].reason, 'session-busy');

  const paths = sessionPaths(home, session);
  const binding = readRecord(paths.binding);
  assert.equal(binding.session, session);
  assert.equal(binding.root, roots[winnerIndex], 'the winner wrote the only binding');
  assert.equal(binding.capability, 'read');
  await Promise.all(raced.map((caller) => caller.stop()));

  // Resuming on another root or another capability is refused, never rebound.
  const otherRoot = acquireSession({ sessionHome: home, runDir, session, root: roots[1 - winnerIndex], capability: 'read', callId: 2 });
  assert.equal(otherRoot.ok, false);
  if (otherRoot.ok) return;
  assert.equal(otherRoot.reason, 'session-root-mismatch');
  assert.ok(otherRoot.detail.includes(roots[winnerIndex]));

  const otherCapability = acquireSession({ sessionHome: home, runDir, session, root: roots[winnerIndex], capability: 'write', callId: 3 });
  assert.equal(otherCapability.ok, false);
  if (otherCapability.ok) return;
  assert.equal(otherCapability.reason, 'session-capability-mismatch');

  // A mismatch refusal leaves no lock behind and does not rewrite the binding.
  assert.equal(existsSync(paths.lock), false);
  assert.equal(readRecord(paths.binding).root, roots[winnerIndex]);

  const resumed = acquireSession({ sessionHome: home, runDir, session, root: roots[winnerIndex], capability: 'read', callId: 4 });
  assert.equal(resumed.ok, true, 'the bound pair still resumes');
  if (resumed.ok) resumed.release();
});

// ── Stale reclamation (EX-4, EX-5) ─────────────────────────────────────────

test('two callers presented with one stale lock: exactly one reclaims under <lock>.claim via rename, the loser refuses (EX-4)', async (t) => {
  const { home, runDir, helperPath } = state();
  const session = 'stale-race';
  const paths = writeLock(home, session, staleOwner(session));

  const raced = await callers(t, helperPath, 2);
  const options = { sessionHome: home, runDir, session, root: '/work/one', capability: 'read', callId: 1 };
  for (const caller of raced) caller.send({ action: 'acquire', options, hold: true });
  const answers = await Promise.all(raced.map((caller) => caller.next()));

  assert.equal(answers.filter((answer) => answer.ok === true).length, 1, 'exactly one caller reclaims and proceeds');
  assert.equal(answers.filter((answer) => answer.ok === false).length, 1);
  assert.equal(answers.find((answer) => answer.ok === false)!.reason, 'session-busy');

  const winnerIndex = answers.findIndex((answer) => answer.ok === true);
  // The successor record replaced the stale one in a single atomic rename over
  // <lock>; the claim that serialised it is gone.
  assert.equal(readRecord(paths.lock).pid, raced[winnerIndex].pid);
  assert.equal(existsSync(paths.claim), false, 'the winning reclaim released its claim');
  assert.deepEqual(readdirSync(paths.sessions).sort(), [`${session}.binding`, `${session}.lock`], 'no temp file or claim is left behind');

  await Promise.all(raced.map((caller) => caller.stop()));
  assert.equal(existsSync(paths.lock), false);
});

test('no caller wins an O_EXCL create of <lock> across a reclaim: the rename never leaves the path absent (EX-4)', async (t) => {
  const { home, runDir, helperPath } = state();
  const session = 'atomic';
  const paths = writeLock(home, session, staleOwner(session));

  const [prober] = await callers(t, helperPath, 1);
  prober.send({ action: 'probe', lock: paths.lock });
  const probing = await prober.next();
  assert.equal(probing.probing, true);

  const reclaimed = acquireSession({ sessionHome: home, runDir, session, root: '/work/one', capability: 'read', callId: 3 });
  assert.equal(reclaimed.ok, true);
  if (!reclaimed.ok) return;

  prober.send({ action: 'stop' });
  const observed = await prober.next();
  assert.equal(observed.won, 0, 'an O_EXCL create succeeded, so <lock> was absent: replacement was not one rename');
  assert.ok(observed.attempts > 0, 'the prober actually attempted the create');
  reclaimed.release();
  await prober.stop();
});

test('a killed reclaimer leaves a live lock plus an orphan claim: the next caller refuses session-busy naming the claim, and only an operator clears it (EX-5)', () => {
  const { home, runDir } = state();
  const session = 'orphan';
  const paths = writeLock(home, session, staleOwner(session));
  // What a reclaimer that died holding the claim leaves behind: the lock it was
  // replacing, and the claim it never released.
  writeFileSync(paths.claim, '');

  const refused = acquireSession({ sessionHome: home, runDir, session, root: '/work/one', capability: 'read', callId: 9 });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.reason, 'session-busy');
  assert.ok(refused.detail.includes(paths.claim), 'the refusal names the orphan claim');
  assert.match(refused.detail, /operator/);
  assert.equal(existsSync(paths.claim), true, 'the claim is left in place: one level of indirection, no recursion');

  // A second caller refuses identically: a lost claim is not a retry storm.
  const again = acquireSession({ sessionHome: home, runDir, session, root: '/work/one', capability: 'read', callId: 10 });
  assert.equal(again.ok, false);
  if (again.ok) return;
  assert.equal(again.reason, 'session-busy');

  // Only an operator clears it; then the stale lock is reclaimed normally.
  unlinkSync(paths.claim);
  const reclaimed = acquireSession({ sessionHome: home, runDir, session, root: '/work/one', capability: 'read', callId: 11 });
  assert.equal(reclaimed.ok, true, 'once the operator clears the claim, the stale lock is reclaimable');
  if (reclaimed.ok) reclaimed.release();
});

// ── Owner identity and unknowable liveness (EX-6) ──────────────────────────

test('owner identity is pid plus kernel start time: a reused pid is stale, and unknowable liveness refuses session-busy (EX-6)', () => {
  const { dir, home, runDir } = state();
  const session = 'identity';
  const paths = writeLock(home, session, staleOwner(session));

  // Alive: this pid, this start time -> the same owner.
  writeFileSync(
    paths.lock,
    `${JSON.stringify({ ...staleOwner(session), pid: process.pid, starttime: ownStartTime() })}\n`,
  );
  const busy = acquireSession({ sessionHome: home, runDir, session, root: '/work/one', capability: 'read', callId: 1 });
  assert.equal(busy.ok, false);
  if (busy.ok) return;
  assert.equal(busy.reason, 'session-busy');
  assert.match(busy.detail, /owned by pid/);

  // A reused pid: same pid, another start time -> another owner, and that owner
  // is gone, so the lock is stale rather than live.
  writeFileSync(paths.lock, `${JSON.stringify(staleOwner(session))}\n`);
  const reclaimed = acquireSession({ sessionHome: home, runDir, session, root: '/work/one', capability: 'read', callId: 2 });
  assert.equal(reclaimed.ok, true, 'a reused pid does not read as the same owner');
  if (reclaimed.ok) reclaimed.release();

  // Unknown: no pid table at all.
  const noProc = join(dir, 'no-proc');
  writeFileSync(paths.lock, `${JSON.stringify({ ...staleOwner(session), pid: 999_999 })}`);
  const unknowable = acquireSession({
    sessionHome: home,
    runDir,
    procDir: noProc,
    session,
    root: '/work/one',
    capability: 'read',
    callId: 3,
  });
  assert.equal(unknowable.ok, false);
  if (unknowable.ok) return;
  assert.equal(unknowable.reason, 'session-busy');
  assert.equal(readRecord(paths.lock).pid, 999_999, 'an unknowable owner is never stolen from');
  assert.equal(existsSync(paths.claim), false, 'liveness is decided before the claim is taken');

  // Unknown for the holder alone: a pid table that reports this process but
  // carries a stat line without field 22 for the owner.
  const fake = join(dir, 'fake-proc');
  mkdirSync(join(fake, String(process.pid)), { recursive: true });
  copyFileSync(join('/proc', String(process.pid), 'stat'), join(fake, String(process.pid), 'stat'));
  mkdirSync(join(fake, '999999'), { recursive: true });
  writeFileSync(join(fake, '999999', 'stat'), '999999 (node) S\n');
  const unparsable = acquireSession({
    sessionHome: home,
    runDir,
    procDir: fake,
    session,
    root: '/work/one',
    capability: 'read',
    callId: 4,
  });
  assert.equal(unparsable.ok, false);
  if (unparsable.ok) return;
  assert.equal(unparsable.reason, 'session-busy');
  assert.equal(readRecord(paths.lock).pid, 999_999, 'a stat line without a start time is not evidence of death');
});

// ── The reclaim is auditable (EX-8) ────────────────────────────────────────

test('every reclaim leaves an attempts.jsonl line naming the replaced record, the claim and the successor (EX-8)', () => {
  const { home, runDir } = state();
  const session = 'audit';
  const stale = staleOwner(session);
  const paths = writeLock(home, session, stale);

  const acquisition = acquireSession({ sessionHome: home, runDir, session, root: '/work/one', capability: 'read', callId: 5 });
  assert.equal(acquisition.ok, true);
  if (!acquisition.ok) return;

  const lines = attempts(runDir);
  assert.equal(lines.length, 1, 'one line per reclaim');
  const [line] = lines;
  assert.equal(line.reason, 'session-reclaimed');
  assert.equal(line.call_id, 5);
  const reclaim = line.reclaim as Record<string, any>;
  assert.equal(reclaim.lock, paths.lock);
  assert.equal(reclaim.claim, paths.claim);
  assert.equal(reclaim.stale.pid, stale.pid, 'the record it replaced');
  assert.equal(reclaim.stale.starttime, stale.starttime);
  assert.equal(reclaim.successor.pid, process.pid, 'the record it installed');
  assert.equal(reclaim.successor.session, session);
  assert.equal(reclaim.successor.root, '/work/one');

  acquisition.release();
  assert.equal(attempts(runDir).length, 1, 'a plain acquire/release records no reclaim');
});

// ── Release never deletes a successor (sec-6) ──────────────────────────────

test('release never unlinks a lock that is not this owner\'s record (sec-6: no unlink may delete a live successor)', () => {
  const { home } = state();
  const session = 'release';
  const successorRecord = { ...staleOwner(session), pid: 424_242, starttime: '5150' };
  const paths = writeLock(home, session, successorRecord);
  const successor = `${JSON.stringify(successorRecord)}\n`;
  const notes: string[] = [];
  const diagnostics = { write: (text: string) => notes.push(text) };

  // Another owner's record: a reclaim installed it as this call was releasing.
  releaseSession(
    paths,
    { session, pid: process.pid, starttime: ownStartTime(), call_id: 1, started: '', root: '/work/one', capability: 'read' },
    diagnostics,
  );
  assert.equal(readFileSync(paths.lock, 'utf8'), successor, 'the successor record is untouched');
  assert.match(notes.join(''), /leaving .* in place/);

  // The same owner's pid and start time but a different call is not this call's
  // lock either: identity is the whole record, not the path.
  writeFileSync(paths.lock, `${JSON.stringify({ session, pid: process.pid, starttime: ownStartTime(), call_id: 'other', started: '', root: '/work/one', capability: 'read' })}\n`);
  notes.length = 0;
  releaseSession(
    paths,
    { session, pid: process.pid, starttime: ownStartTime(), call_id: 'mine', started: '', root: '/work/one', capability: 'read' },
    diagnostics,
  );
  assert.equal(existsSync(paths.lock), true);
  assert.match(notes.join(''), /not this owner/);

  // Its own record: released, and a second release is silent.
  writeFileSync(paths.lock, `${JSON.stringify({ session, pid: process.pid, starttime: ownStartTime(), call_id: 'mine', started: '', root: '/work/one', capability: 'read' })}\n`);
  notes.length = 0;
  releaseSession(
    paths,
    { session, pid: process.pid, starttime: ownStartTime(), call_id: 'mine', started: '', root: '/work/one', capability: 'read' },
    diagnostics,
  );
  assert.equal(existsSync(paths.lock), false, 'its own lock is released');
  releaseSession(
    paths,
    { session, pid: process.pid, starttime: ownStartTime(), call_id: 'mine', started: '', root: '/work/one', capability: 'read' },
    diagnostics,
  );
  assert.deepEqual(notes, [], 'releasing an already-absent lock says nothing');
});
