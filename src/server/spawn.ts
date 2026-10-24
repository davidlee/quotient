// The spawn: one launch form, one child, one termination ladder.
//
// `buildArgv` is pi's argv, and the form kind decides the command once
// (`launchCommand`, DEC-114). A confined form is a launcher with pi baked in: it
// consumes exactly one positional — the active session directory it binds at run
// time — and then receives pi's argv verbatim, with no executable word and no
// `--`. An unconfined form is pi itself, given pi's argv alone. Everything after
// that choice is shared: process group, ladder, child env, audit.
//
// Design sec-4's spawn: cwd is the root, the prompt travels on the child's own
// stdin pipe (closed after the write), stdout is captured into the run's
// `events.jsonl` and stderr into `stderr.log` (never merged), and the child is
// spawned `detached` — one `setsid(2)` session, i.e. its own process-group leader
// — so the ladder signals `-pid` and can never reach the server or a concurrent
// call. `no-new-session` in the jail means no group would exist otherwise.
//
// ONE ladder, for every trigger: SIGTERM to the group, `graceMs`, SIGKILL to the
// group, reap, drain, audit, return. The one rung a trigger may skip is the
// SIGTERM: a trigger arriving after the leader was reaped has no live leader left
// to grace, so the group it left behind is SIGKILLed directly, and the drain is
// what that signal bounds. Cancellation (DEC-103), stdin EOF, an evidence failure
// and later the gate all ride it; there is no second shutdown path that could fall
// out of step with it. Releasing the session lock and answering the call are the
// server's, and they happen after this resolves.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { finished } from 'node:stream/promises';
import { countRecord, createTally, type Tally } from '../reduce/reduce.ts';
import { attemptsPath, appendAudit, removeRun, runLayout, type AuditRecord, type CallId, type RunLayout } from './evidence.ts';
import type { Form } from './policy.ts';
import { MCP_EXTENSION, MCP_TOOL_PREFIX, toolsArgument, type Profile } from './profiles.ts';
import type { Termination } from './result.ts';

/** Design sec-4's grace between SIGTERM and SIGKILL on the abort path. Injectable
 *  so a test does not spend two seconds per cancelled run; the default is the
 *  contract. */
export const DEFAULT_GRACE_MS = 2000;

/** Every variable the server's own launch environment carries is named here and
 *  nowhere reaches a child: a `QUOTIENT_*` value is the server's configuration. */
const SERVER_VAR_PREFIX = 'QUOTIENT_';

/**
 * The causes a trigger may abort a run with. They ride `AbortSignal.reason`, so a
 * trigger is one value: the cancellation notification, stdin EOF, an evidence
 * failure and (PHASE-07) the gate all hand the ladder a cause through the same
 * signal rather than a second channel beside it. The gate's rung carries its
 * crossing in that same value (`{ cause, trigger }`), so the abort's audit record
 * can name what crossed; a bare token means the rung had no crossing to report.
 */
export type AbortCause = Extract<Termination, 'cancelled' | 'eof' | 'audit' | 'timeout' | 'switch' | 'ceiling' | 'accounting'>;

const ABORT_CAUSES: readonly AbortCause[] = ['cancelled', 'eof', 'audit', 'timeout', 'switch', 'ceiling', 'accounting'];

/** The crossing a gate trigger carried: which unit, what it read and the bound it
 *  crossed. Structural on purpose — `spawn` reads the three fields off the abort
 *  reason and keeps no dependency on the gate. */
type Crossing = { unit: string; observed: number | null; limit: number | null };

/** What an admitted call hands the spawn: the launch form, the profile it runs
 *  under, the active session directory the form binds, and the evidence root. */
export type SpawnPlan = {
  /** The policy's form for the profile's capability: a launcher, or pi itself. */
  form: Form;
  profile: Profile;
  session: string;
  /** `<QUOTIENT_SESSION_HOME>/<session>` — pi's `--session-dir`, and a confined
   *  form's one positional argument. */
  sessionDir: string;
  /** The canonical root: the child's cwd, and the directory it works in. */
  root: string;
  /** `QUOTIENT_RUN_DIR`; this run's directory is allocated under it (EX-6). */
  runDir: string;
  /** The JSON-RPC id of the call, for the run directory's name. */
  callId: CallId;
  /** The effective tool set — the profile's, narrowed by the call. */
  tools: readonly string[];
  prompt: string;
  /** sha256 of the policy bytes: on every audit line of this run. */
  policyDigest: string;
  /** sha256 of the start-up profile snapshot: on the `spawn` record. */
  profileDigest: string;
  /** sha256 of the start-up help snapshot: on the `spawn` record. */
  helpDigest: string;
  /** A test's seam: an already-named run directory instead of a fresh one. */
  layout?: RunLayout;
};

/** What drives a run: the one abort trigger, the grace, and the environment the
 *  child's is derived from. */
export type RunControl = {
  signal: AbortSignal;
  /** Defaults to `DEFAULT_GRACE_MS`. */
  graceMs?: number;
  /** Defaults to `process.env`; `childEnv` strips it down for the child. */
  env?: Record<string, string | undefined>;
  /** The reader's hook (PHASE-07's gate): called once with the fresh tally and
   *  again immediately after every `countRecord`, so a second consumer reads the
   *  one accumulator instead of keeping its own. */
  onRecord?: (tally: Tally) => void;
};

/**
 * What the run was, reported rather than interpreted (EX-7): the child's exit
 * status and the observed `agent_settled` are facts the result builder reads, and
 * a nonzero exit is never success on its own. `lines` is the stream, in order, for
 * the reducer; nothing here decides a state.
 */
export type RunOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** `agent_settled` was observed on the child's stream. */
  settled: boolean;
  /** Raw event records, in order, as the child wrote them. */
  lines: string[];
  /** The ladder's cause, when a trigger fired; null when the run ended itself. */
  abort: AbortCause | null;
  /** The executable could not be launched: no process ever ran. */
  spawnFailed: boolean;
  /** An audit append failed at any point — before spawn or after. */
  auditFailed: boolean;
  /** The `spawn` audit record failed, so nothing was launched and the run
   *  directory was discarded: the call is a refusal, not a run (EX-6). */
  auditFailedBeforeSpawn: boolean;
  /** Where this run's evidence lives (or would have, for a discarded run). */
  layout: RunLayout;
};

/**
 * Pi's argv: its options verbatim, with no executable word, no `--`, no
 * positional, and no `-e` beyond `builtin:mcp` (design sec-3). Which command
 * receives it, and with what in front, is `launchCommand`'s.
 *
 * `-e builtin:mcp` is passed exactly when the profile names an `mcp__*` tool,
 * because `--no-extensions` also disables the MCP built-in: step 5 has already
 * refused a profile that names such a tool while its form declines the extension,
 * so the flag re-enables precisely what the profile requires and nothing else.
 *
 * `--thinking <level>` follows the `--model` pair only when the profile names a
 * level, so a profile that omits it produces the child's own default and an argv
 * byte-identical to one built before the field existed.
 */
export function buildArgv(plan: {
  profile: Profile;
  session: string;
  sessionDir: string;
  tools: readonly string[];
}): string[] {
  const argv = [
    '--mode',
    'json',
    '--model',
    plan.profile.model,
    ...(plan.profile.thinking === undefined ? [] : ['--thinking', plan.profile.thinking]),
    '--tools',
    toolsArgument(plan.tools),
    '--session-id',
    plan.session,
    '--session-dir',
    plan.sessionDir,
    '--no-extensions',
  ];
  if (plan.profile.tools.some((tool) => tool.startsWith(MCP_TOOL_PREFIX))) {
    argv.push('-e', MCP_EXTENSION);
  }
  return argv;
}

/**
 * The one branch on the form kind (DEC-114): the command to run and its argv. A
 * confined form takes the session directory as its positional, then pi's argv;
 * unconfined pi takes pi's argv alone, which already names `--session-dir`.
 */
export function launchCommand(form: Form, sessionDir: string, piArgv: readonly string[]): [string, string[]] {
  return form.kind === 'confined' ? [form.path, [sessionDir, ...piArgv]] : [form.pi, [...piArgv]];
}

/**
 * The child's environment: the server's, minus every `QUOTIENT_*` variable and minus
 * any whose value names `QUOTIENT_RUN_DIR` or one of this run's evidence files, so
 * no environment member hands the run's evidence to the child (EX-5). PATH and the
 * provider/gateway variables stay: the launch closure and the model call need
 * them. No extra file descriptor is passed either — the child's table is exactly
 * the three pipes.
 */
export function childEnv(
  env: Record<string, string | undefined>,
  runDir: string,
  layout: RunLayout,
): Record<string, string | undefined> {
  const evidence = [
    runDir,
    attemptsPath(runDir),
    layout.dir,
    layout.events,
    layout.stderr,
    layout.transcript,
    layout.status,
    layout.audit,
  ];
  const child: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(SERVER_VAR_PREFIX)) {continue;}
    if (typeof value === 'string' && evidence.some((path) => value.includes(path))) {continue;}
    child[name] = value;
  }
  return child;
}

/**
 * Launch the form, capture its streams and own its termination.
 *
 * The run directory is allocated here and nowhere earlier, so only a call that
 * passed validation step 8 has one (EX-6). Inside, the order is the contract:
 * the `spawn` audit record, the launch, the stream capture, then — on a trigger —
 * the ladder, and after either ending, the reap, the drain and the `exit` record.
 * The caller releases the session lock and answers only after this resolves.
 */
export async function runChild(plan: SpawnPlan, control: RunControl): Promise<RunOutcome> {
  const layout = plan.layout ?? runLayout(plan.runDir, plan.callId);
  const graceMs = control.graceMs ?? DEFAULT_GRACE_MS;
  const [command, argv] = launchCommand(plan.form, plan.sessionDir, buildArgv(plan));
  const env = childEnv(control.env ?? process.env, plan.runDir, layout);

  const lines: string[] = [];
  const tally = createTally();
  let settled = false;
  let abort: AbortCause | null = null;
  let spawnFailed = false;
  let auditFailed = false;
  let auditFailedBeforeSpawn = false;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  /** When the drain must give up on the pipes; null until a trigger signals the
   *  group, because a run that ended itself has a tail worth waiting for. */
  let drainBound: number | null = null;

  // The tally exists before the first byte does: the hook is told the run's
  // starting state, so an idle poll has something to judge while the child is
  // still silent.
  control.onRecord?.(tally);

  const outcome = (): RunOutcome => ({
    exitCode: exit?.code ?? null,
    signal: exit?.signal ?? null,
    settled,
    lines,
    abort,
    spawnFailed,
    auditFailed,
    auditFailedBeforeSpawn,
    layout,
  });

  const audit = (record: AuditRecord): boolean => {
    const ok = appendAudit(layout, { policy_digest: plan.policyDigest, session: plan.session, ...record });
    if (!ok) {auditFailed = true;}
    return ok;
  };

  try {
    mkdirSync(layout.dir, { recursive: true });
  } catch {
    // Nowhere to put the evidence: nothing ran, so this is the same refusal as a
    // failed `spawn` record below (design sec-6's unallocatable run directory).
    auditFailed = true;
    auditFailedBeforeSpawn = true;
    return outcome();
  }

  // The decision before the act: an operator reading audit.jsonl sees what was
  // launched, under which snapshot. A record that cannot be written means the run
  // never starts and its directory is discarded (EX-6).
  if (
    !audit({
      record: 'spawn',
      root: plan.root,
      form: command,
      form_kind: plan.form.kind,
      profile: plan.profile.name,
      profile_digest: plan.profileDigest,
      profile_source: plan.profile.source,
      help_digest: plan.helpDigest,
      argv,
    })
  ) {
    auditFailedBeforeSpawn = true;
    removeRun(layout);
    return outcome();
  }

  const events = createWriteStream(layout.events);
  const stderrLog = createWriteStream(layout.stderr);

  const child: ChildProcess = spawn(command, argv, {
    cwd: plan.root,
    env,
    // One session of its own (`setsid`): the child leads a new process group, so
    // `process.kill(-pid)` reaches it and everything it starts, and nothing else.
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      resolve();
    });
    child.once('error', (error) => {
      // A pre-exec failure (ENOENT, EACCES) has no pid, so `exit` never arrives:
      // the run is `failed` with termination `spawn`, not a success with no
      // evidence (EX-7).
      if (child.pid === undefined) {
        spawnFailed = true;
        exit = { code: null, signal: null };
      }
      process.stderr.write(`quotient: the launch form ${command} failed: ${error.message}\n`);
      resolve();
    });
  });

  // stdout is the event stream: captured verbatim into events.jsonl and split on
  // LF for the record list (pi's json.md framing — split on LF, strip a CR, no
  // `readline`). The count runs through the reducer's own accumulator, so the
  // audit's usage snapshot and PHASE-07's gate cannot disagree about a record.
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const observe = (record: string): void => {
    if (record.trim().length === 0) {return;}
    lines.push(record);
    let event: unknown;
    try {
      event = JSON.parse(record);
    } catch {
      return; // malformed: the reducer counts it, this only watches for settling
    }
    countRecord(event, tally);
    control.onRecord?.(tally);
    if ((event as { type?: unknown }).type === 'agent_settled') {settled = true;}
  };
  const stdout = child.stdout!;
  stdout.on('data', (chunk: Buffer) => {
    events.write(chunk);
    pending += decoder.write(chunk);
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      let record = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (record.endsWith('\r')) {record = record.slice(0, -1);}
      observe(record);
      newline = pending.indexOf('\n');
    }
  });

  // The evidence streams end exactly once, whatever ended them: a stream `end`, a
  // destroyed pipe (a launch that never happened) or the drain below. A trailing
  // fragment without LF is not a record — the same framing rule the server's own
  // reader follows — and it stays in events.jsonl verbatim.
  let eventsEnded = false;
  const finishEvents = (): void => {
    if (eventsEnded) {return;}
    eventsEnded = true;
    events.end();
  };
  stdout.on('end', finishEvents);
  stdout.on('close', finishEvents);

  let stderrEnded = false;
  const finishStderr = (): void => {
    if (stderrEnded) {return;}
    stderrEnded = true;
    stderrLog.end();
  };
  child.stderr!.on('data', (chunk: Buffer) => stderrLog.write(chunk));
  child.stderr!.on('end', finishStderr);
  child.stderr!.on('close', finishStderr);

  // The prompt is the child's stdin, and the pipe closes after the write: pi
  // reads its prompt from a stream that ends, never from the server's stdin.
  const stdin = child.stdin!;
  stdin.on('error', () => {
    // The child exited before reading: EPIPE is the child's ending, not an
    // evidence failure.
  });
  stdin.end(plan.prompt);

  /**
   * The one ladder. Idempotent: the first trigger's cause is the reported one, and
   * a later trigger is not a second shutdown. The abort record is written where
   * the decision is taken, so it carries the usage facts known at that moment and,
   * when the rung carried one, the crossing it judged.
   *
   * Whatever the rung, a trigger that has signalled leaves a `drainBound` behind:
   * from there the drain is bounded rather than trustful, because a member the
   * group signal could not reach is exactly what keeps the pipe open. It is set
   * last, one grace past the signal actually sent, so the drain never gives up
   * before the ladder has finished with the leader.
   */
  const terminate = async (cause: AbortCause, crossing: Crossing | null = null): Promise<void> => {
    if (abort !== null) {return;}
    abort = cause;
    // Additive evidence, never a new cause: only a gate rung names a crossing, so
    // a `cancelled`/`eof`/`audit` abort writes the same record it always wrote.
    audit({
      record: 'abort',
      cause,
      settled,
      usage: usageOf(tally),
      ...(crossing ? { unit: crossing.unit, observed: crossing.observed, limit: crossing.limit } : {}),
    });
    const pid = child.pid;
    // Never signal without a verified pid of our own child, and never `-0` or the
    // server's own group: the child leads its group, the server leads another.
    if (!signallable(pid)) {return;}
    if (exit === null) {
      signalGroup(pid, 'SIGTERM');
      if (!(await waitFor(exited, graceMs))) {
        signalGroup(pid, 'SIGKILL');
        await exited;
      }
    } else {
      // The leader is reaped; its process group is not. A member that outlived the
      // leader is exactly what holds the stdout pipe open, so the group is killed
      // outright: there is no graceful rung for a leader that has already exited,
      // and the drain is what this signal bounds.
      signalGroup(pid, 'SIGKILL');
    }
    drainBound = Date.now() + graceMs;
  };

  // An evidence failure fails the run closed: a stream that cannot be recorded
  // stops the run through the same ladder as every other trigger.
  const evidenceFailure = (): void => {
    auditFailed = true;
    void terminate('audit');
  };
  events.on('error', evidenceFailure);
  stderrLog.on('error', evidenceFailure);

  const onAbort = (): void => {
    const reason: unknown = control.signal.reason;
    void terminate(abortCauseOf(reason), crossingOf(reason));
  };
  control.signal.addEventListener('abort', onAbort, { once: true });
  if (control.signal.aborted) {onAbort();}

  // Reap: the exit status is the child's, whatever the trigger. The abort listener
  // stays attached through the drain below: a trigger that lands while the pipe is
  // still open is what bounds the wait, so it may not be removed with the reap.
  await exited;

  // Drain: the child's exit does not close stdout while a member of its group
  // holds the pipe, and the `exit` record and the caller's answer both wait for
  // the last byte. With no trigger the wait is unbounded — a run that ended itself
  // has a tail worth every byte of, and truncating it would lose evidence — so the
  // wait is taken a grace at a time and the bound re-read between slices: a trigger
  // landing mid-drain applies a bound the wait did not have when it started. With
  // a trigger the wait is bounded by `drainBound` outright.
  const pipesClosed = Promise.all([finished(stdout).catch(() => {}), finished(child.stderr!).catch(() => {})]);
  let drained = false;
  for (;;) {
    const bound = drainBound;
    const slice = bound === null ? graceMs : bound - Date.now();
    if (slice <= 0) {break;}
    if (await waitFor(pipesClosed, slice)) {
      drained = true;
      break;
    }
  }
  if (!drained) {
    // The bound expired with the pipe still open: a member our group signal could
    // not reach is holding it. EX-11 does not let that stand — the group is
    // SIGKILLed once more — and the pipes are destroyed so the two evidence
    // writers still end and the run ends without an unreachable tail rather than
    // never ending at all.
    if (signallable(child.pid)) {signalGroup(child.pid, 'SIGKILL');}
    stdout.destroy();
    child.stderr!.destroy();
  }
  finishEvents();
  finishStderr();
  await finished(events).catch(() => {});
  await finished(stderrLog).catch(() => {});

  // Read through outcome(): `exit` is assigned in the `exited` callback, which
  // TypeScript's narrowing cannot see, so a direct read here types as `never`.
  const { exitCode, signal } = outcome();
  audit({ record: 'exit', code: exitCode, signal, settled, spawn_failed: spawnFailed });

  // The `exit` record is the last thing a trigger could usefully precede: from
  // here the run is over and a late trigger has no bound left to move.
  control.signal.removeEventListener('abort', onAbort);

  return outcome();
}

/** The usage facts an audit record carries: the accumulator's units, verbatim. */
function usageOf(tally: Tally): Record<string, unknown> {
  return {
    requests: tally.requests,
    requests_unmeasured: tally.requests_unmeasured,
    context: { ...tally.context },
    tokens: { ...tally.tokens },
    cost_usd: tally.cost,
    accounting: tally.accounting,
  };
}

/** The cause a trigger asked for. A bare cause token is the whole reason for a
 *  cancellation; the gate hands an object carrying one beside its trigger. An
 *  unrecognised reason is a cancellation: a trigger fired, and the ladder needs a
 *  cause rather than none. */
function abortCauseOf(reason: unknown): AbortCause {
  const named = typeof reason === 'string' ? reason : (reason as { cause?: unknown } | null | undefined)?.cause;
  return ABORT_CAUSES.find((cause) => cause === named) ?? 'cancelled';
}

/** The crossing a gate rung carried, read structurally off the abort reason: the
 *  unit that crossed, what it read and the bound it crossed. A bare cause token,
 *  or a trigger without a readable unit, names no crossing and adds no fields. */
function crossingOf(reason: unknown): Crossing | null {
  if (typeof reason !== 'object' || reason === null) {return null;}
  const trigger = (reason as { trigger?: unknown }).trigger;
  if (typeof trigger !== 'object' || trigger === null) {return null;}
  const fields = trigger as Record<string, unknown>;
  const unit = fields.unit;
  if (typeof unit !== 'string') {return null;}
  const observed = fields.observed;
  const limit = fields.limit;
  return {
    unit,
    observed: typeof observed === 'number' ? observed : null,
    limit: typeof limit === 'number' ? limit : null,
  };
}

/** A pid this process may signal as a group: its own child's, positive, and never
 *  the server's own. `-0` would signal the server's group; `-pid` must never be
 *  built from anything but a verified positive pid. */
function signallable(pid: number | undefined): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid !== process.pid;
}

/** Signal the child's process group. `-pid` reaches the group leader and every
 *  process it started — and, because the child leads its own session, cannot
 *  reach the server or a concurrent call. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone. Nothing to escalate against.
  }
}

/** Resolve true when `settled` finishes within `ms`, false when the grace runs
 *  out first. The timer is cleared either way. */
function waitFor(done: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(false); }, ms);
    void done.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
