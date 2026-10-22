// Session ownership, the (root, capability) binding and stale reclamation
// (design sec-2 step 7, sec-6 "Sessions (DEC-099, amended)").
//
// A stdio MCP server is per client, so two drivers run two servers over one
// `PI_MCP_SESSION_HOME`. Ownership therefore cannot be an in-memory map: it is
// exactly one `O_EXCL` create of `<home>/sessions/<id>.lock`, and only the process
// that wins that create may use the session.
//
// Shape (EX-9). `<home>/<id>/` is the one session directory a child is given; the
// lock, the binding and the reclaim claim live in `<home>/sessions/`, beside it
// and outside every child bind. Nothing here spawns anything: PHASE-05 checks the
// child view and PHASE-06 spawns.
//
// Why no unlink here can delete a live successor. A new owner can only appear when
// the lock path is *absent*, and this module never leaves it absent: a stale lock is
// replaced by writing a successor record to a temp file and renaming it OVER
// `<lock>`, one atomic replacement, so there is no window to create into. The two
// reclamation steps are serialised by the claim — itself an `O_EXCL` create of
// `<lock>.claim` — and the winner re-reads `<lock>` under the claim and requires
// the same stale record it first saw. A process that dies holding the claim leaves
// an orphan claim with the lock intact; the next caller refuses `session-busy`
// naming the claim, and only an operator clears it (one level of indirection, no
// recursion).
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { appendAttempt } from './evidence.ts';
import type { CallId } from './evidence.ts';
import type { Filesystem } from './profiles.ts';

/**
 * The session grammar (EX-1): 1–64 characters, alphanumeric at both ends, so an id
 * is always a single path component and can never be `.` or `..`.
 */
export const SESSION_GRAMMAR = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

/** The server-side metadata directory, beside the session directories it serves. */
export const SESSIONS_DIR = 'sessions';
export const LOCK_SUFFIX = '.lock';
export const BINDING_SUFFIX = '.binding';
export const CLAIM_SUFFIX = '.claim';

/** Owner-only permissions for the state this module creates (EX-9). */
const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;

/** The four refusals step 7 can produce (design sec-2 step 7). */
export type SessionRefusal =
  | 'session-invalid'
  | 'session-root-mismatch'
  | 'session-capability-mismatch'
  | 'session-busy';

/** Somewhere a note about a release can go; `process.stderr` in production. */
export type Diagnostics = { write: (text: string) => void };

/** The paths one session's state occupies. */
export type SessionPaths = {
  /** `PI_MCP_SESSION_HOME`. */
  home: string;
  /** `<home>/sessions` — lock, binding and claim, outside every child bind. */
  sessions: string;
  /** `<home>/<id>` — the one session directory a child is given. */
  sessionDir: string;
  lock: string;
  binding: string;
  claim: string;
};

/** The (root, capability) pair a session is bound to at first use (EX-3). */
export type BindingRecord = {
  session: string;
  /** The canonical root the session was first used on. */
  root: string;
  capability: Filesystem;
  /** ISO 8601: when the binding was written. */
  bound: string;
};

/**
 * The ownership record `<lock>` carries. Identity is `pid` PLUS `starttime`: a bare
 * pid is reused, and a reused pid must not read as the same owner (EX-6).
 */
export type OwnershipRecord = {
  session: string;
  pid: number;
  /** Field 22 of `/proc/<pid>/stat`, verbatim: the process's kernel start time. */
  starttime: string;
  call_id: CallId;
  /** ISO 8601: when ownership was taken. */
  started: string;
  root: string;
  capability: Filesystem;
};

export type AcquireOptions = {
  /** `PI_MCP_SESSION_HOME`, absolute (`admission.sessionHome`). */
  sessionHome: string;
  /** The `attempts.jsonl` directory; null when the operator declared none. */
  runDir: string | null;
  /** The caller's session id; absent mints one. */
  session?: string;
  /** The call's canonical root, which first use binds the session to. */
  root: string;
  capability: Filesystem;
  callId: CallId;
  /** The pid table the owner's start time is read from; `/proc` in production. */
  procDir?: string;
  /** Recorded on a reclaim line when the policy was readable. */
  policyDigest?: string | null;
};

export type SessionAcquisition =
  | {
      ok: true;
      session: string;
      sessionDir: string;
      paths: SessionPaths;
      root: string;
      capability: Filesystem;
      binding: BindingRecord;
      /** Release last: only after the work this lock protects has finished. */
      release: () => void;
    }
  | { ok: false; reason: SessionRefusal; detail: string };

const errorCode = (error: unknown): string =>
  error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'unknown error';

/** A fresh id from the CSPRNG: 32 lowercase hex characters, alnum at both ends. */
export function mintSessionId(): string {
  return randomBytes(16).toString('hex');
}

/** Whether a string is a session id (EX-1). */
export function isSessionId(value: string): boolean {
  return SESSION_GRAMMAR.test(value);
}

/** Where one session's state lives under a session home (EX-9). */
export function sessionPaths(home: string, session: string): SessionPaths {
  const sessions = join(home, SESSIONS_DIR);
  const lock = join(sessions, `${session}${LOCK_SUFFIX}`);
  return {
    home,
    sessions,
    sessionDir: join(home, session),
    lock,
    binding: join(sessions, `${session}${BINDING_SUFFIX}`),
    claim: `${lock}${CLAIM_SUFFIX}`,
  };
}

// ── Liveness ───────────────────────────────────────────────────────────────

export type ProcessStart = { ok: true; starttime: string } | { ok: false; missing: boolean };

/**
 * Field 22 of `/proc/<pid>/stat`: the process's start time in kernel clock ticks.
 * The command name in field 2 is parenthesised and may itself contain spaces and
 * parentheses, so the fields are counted from the LAST `)`; the first field after
 * it is field 3 (`state`), which puts field 22 at index 19.
 */
function startTimeField(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const starttime = fields[19];
  return starttime !== undefined && /^\d+$/.test(starttime) ? starttime : null;
}

/**
 * One pid's kernel start time. `missing` distinguishes "there is no such process"
 * from "the pid table cannot say", which are the two halves of EX-6.
 */
export function processStartTime(procDir: string, pid: number): ProcessStart {
  let stat: string;
  try {
    stat = readFileSync(join(procDir, String(pid), 'stat'), 'utf8');
  } catch (error) {
    return { ok: false, missing: errorCode(error) === 'ENOENT' };
  }
  const starttime = startTimeField(stat);
  return starttime === null ? { ok: false, missing: false } : { ok: true, starttime };
}

/** Whether a pid table is readable at all; an absent one makes every owner unknown. */
function pidTableReadable(procDir: string): boolean {
  try {
    return statSync(procDir).isDirectory() && readdirSync(procDir).length > 0;
  } catch {
    return false;
  }
}

export type Liveness = 'alive' | 'stale' | 'unknown';

/**
 * The owner's liveness. `alive` is the same pid AND the same kernel start time;
 * a reused pid is a different process, so the recorded owner is gone and the lock
 * is `stale`. An unreadable pid table, or a stat line without field 22, is
 * `unknown` — and the caller resolves that to `session-busy`, never to a steal
 * (EX-6).
 */
export function observeLiveness(procDir: string, pid: number, starttime: string): Liveness {
  if (!pidTableReadable(procDir)) return 'unknown';
  const observed = processStartTime(procDir, pid);
  if (!observed.ok) return observed.missing ? 'stale' : 'unknown';
  return observed.starttime === starttime ? 'alive' : 'stale';
}

// ── Records ────────────────────────────────────────────────────────────────

type RecordRead =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; detail: string; missing: boolean };

/** Read one JSON record; unreadable or unparsable is a named failure, never a guess. */
function readRecord(path: string): RecordRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, detail: `${path} could not be read (${errorCode(error)})`, missing: errorCode(error) === 'ENOENT' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, detail: `${path} is not a JSON record`, missing: false };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, detail: `${path} is not a JSON record`, missing: false };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

type OwnershipRead =
  | { ok: true; record: OwnershipRecord; value: Record<string, unknown> }
  | { ok: false; detail: string; missing: boolean };

/**
 * Read `<lock>`. A record that carries no integer pid and no kernel start time
 * cannot name an owner, so it is reported as an unreadable record rather than
 * silently treated as stale: an unreadable lock is fail-closed, not reclaimable.
 */
function readOwnership(path: string): OwnershipRead {
  const read = readRecord(path);
  if (!read.ok) return read;
  const pid = read.value.pid;
  const starttime = read.value.starttime;
  if (typeof pid !== 'number' || !Number.isInteger(pid)) {
    return { ok: false, detail: `${path} carries no integer pid`, missing: false };
  }
  if (typeof starttime !== 'string' || !/^\d+$/.test(starttime)) {
    return { ok: false, detail: `${path} carries no kernel start time`, missing: false };
  }
  return { ok: true, record: read.value as OwnershipRecord, value: read.value };
}

/** Write one record where `<lock>` or its successor will be read from. */
function writeRecord(path: string, record: unknown): void {
  const fd = openSync(path, 'wx', OWNER_ONLY_FILE);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
}

// ── Acquisition ────────────────────────────────────────────────────────────

type Step = { ok: true } | { ok: false; reason: SessionRefusal; detail: string };

/**
 * Take ownership of `<lock>`: the single `O_EXCL` create, or — when the record
 * there is stale — one serialised reclaim of it (EX-4).
 *
 * `retried` says this call is the second attempt of a create that lost to a lock
 * which then vanished: the create is re-attempted exactly once, never recursively,
 * because one vanished path is a race and two are a disagreement the caller has to
 * hear about.
 */
function takeOwnership(
  paths: SessionPaths,
  record: OwnershipRecord,
  procDir: string,
  runDir: string | null,
  callId: CallId,
  policyDigest: string | null | undefined,
  retried: boolean,
): Step {
  let fd: number;
  try {
    fd = openSync(paths.lock, 'wx', OWNER_ONLY_FILE);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      return { ok: false, reason: 'session-busy', detail: `${paths.lock} could not be created (${errorCode(error)})` };
    }
    return reclaim(paths, record, procDir, runDir, callId, policyDigest, retried);
  }
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
  } catch (error) {
    // The lock exists but carries no readable record, which fails closed for
    // everyone (an unreadable lock is not reclaimed). Nothing is unlinked here.
    return {
      ok: false,
      reason: 'session-busy',
      detail: `${paths.lock} was created but its ownership record could not be written (${errorCode(error)}); it must be cleared by an operator`,
    };
  } finally {
    closeSync(fd);
  }
  return { ok: true };
}

const aliveRefusal = (record: OwnershipRecord): Step => ({
  ok: false,
  reason: 'session-busy',
  detail: `session "${record.session}" is owned by pid ${record.pid} (start time ${record.starttime}, call ${JSON.stringify(record.call_id)}), which is alive; concurrency on one session is refused rather than queued`,
});

const unknownRefusal = (record: OwnershipRecord, procDir: string): Step => ({
  ok: false,
  reason: 'session-busy',
  detail: `session "${record.session}" is owned by pid ${record.pid} (start time ${record.starttime}) and its liveness cannot be read from ${procDir}; an unknowable owner is treated as live and the lock is not reclaimed`,
});

/** Drop the claim this process created; it is ours by construction, so this is safe. */
function dropClaim(paths: SessionPaths): void {
  try {
    unlinkSync(paths.claim);
  } catch (error) {
    process.stderr.write(`quotient: could not clear the claim ${paths.claim}: ${errorCode(error)}\n`);
  }
}

/**
 * Reclaim a stale lock. The claim serialises the decision; the winner re-reads
 * `<lock>` and requires the identical stale record it first saw, writes the
 * successor to a temp file in the same directory and renames it OVER `<lock>` —
 * one atomic replacement, so the path is never absent. No path here unlinks the
 * lock itself (EX-4). A lock that vanished before the read is not reclaimed but
 * re-created: there is no record to replace, so the single create is legal again.
 */
function reclaim(
  paths: SessionPaths,
  record: OwnershipRecord,
  procDir: string,
  runDir: string | null,
  callId: CallId,
  policyDigest: string | null | undefined,
  retried: boolean,
): Step {
  const before = readOwnership(paths.lock);
  if (!before.ok) {
    if (before.missing) {
      // The lock the create lost to is gone. Nothing was replaced, nothing is
      // serialised and no record was observed: the plain create is legal again,
      // and it is re-attempted exactly once (never recursively — a second vanish
      // is a path that keeps changing under us, not a race to keep chasing).
      if (!retried) return takeOwnership(paths, record, procDir, runDir, callId, policyDigest, true);
      return {
        ok: false,
        reason: 'session-busy',
        detail: `${paths.lock} was absent when read after the create lost to it, and again after one re-attempt; ownership is decided by a single create, so the call is refused`,
      };
    }
    return {
      ok: false,
      reason: 'session-busy',
      detail: `${paths.lock} exists and carries no readable ownership record (${before.detail}); it must be cleared by an operator`,
    };
  }
  const liveness = observeLiveness(procDir, before.record.pid, before.record.starttime);
  if (liveness === 'alive') return aliveRefusal(before.record);
  if (liveness === 'unknown') return unknownRefusal(before.record, procDir);

  try {
    closeSync(openSync(paths.claim, 'wx', OWNER_ONLY_FILE));
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return {
        ok: false,
        reason: 'session-busy',
        detail: `the reclaim of ${paths.lock} is serialised by ${paths.claim}, which is already held — by a live reclaimer or by one that died holding it; only an operator can clear it`,
      };
    }
    return { ok: false, reason: 'session-busy', detail: `the claim ${paths.claim} could not be created (${errorCode(error)})` };
  }

  // Under the claim, re-confirm the record we intended to replace: two stale
  // observers must not both install an owner. The re-confirm is a fresh liveness
  // observation, so it can say all three things the first one could: the owner is
  // alive, the owner is stale, or the owner's liveness cannot be read — and only
  // the last is a refusal about knowing, not about a live owner.
  const again = readOwnership(paths.lock);
  if (!again.ok || again.record.pid !== before.record.pid || again.record.starttime !== before.record.starttime) {
    dropClaim(paths);
    return {
      ok: false,
      reason: 'session-busy',
      detail: `${paths.lock} changed while the reclaim was being serialised; the lock is not the stale record this call saw`,
    };
  }
  const reconfirmed = observeLiveness(procDir, again.record.pid, again.record.starttime);
  if (reconfirmed !== 'stale') {
    dropClaim(paths);
    return reconfirmed === 'alive' ? aliveRefusal(again.record) : unknownRefusal(again.record, procDir);
  }

  const successor = `${paths.lock}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeRecord(successor, record);
    renameSync(successor, paths.lock);
  } catch (error) {
    try {
      unlinkSync(successor);
    } catch {
      // A temp file that was never created is nothing to clear.
    }
    dropClaim(paths);
    return {
      ok: false,
      reason: 'session-busy',
      detail: `the successor record could not be installed over ${paths.lock} (${errorCode(error)})`,
    };
  }
  dropClaim(paths);

  // Every reclaim is auditable after the fact: what it replaced, the claim it won
  // and the record it installed (EX-8).
  appendAttempt(runDir, {
    callId,
    reason: 'session-reclaimed',
    detail: `pid ${before.record.pid} (start time ${before.record.starttime}, call ${JSON.stringify(before.record.call_id)}) was stale and its lock was reclaimed by pid ${record.pid} (start time ${record.starttime})`,
    policyDigest,
    reclaim: {
      lock: paths.lock,
      claim: paths.claim,
      stale: before.value,
      successor: record as unknown as Record<string, unknown>,
    },
  });
  return { ok: true };
}

type BindStep = { ok: true; binding: BindingRecord } | { ok: false; reason: SessionRefusal; detail: string };

/**
 * Bind the session to (root, capability) on first use, and refuse a different pair
 * afterwards (EX-3). This runs while the lock is held, in the same critical section
 * as the create, so two processes cannot record different bindings.
 */
function bind(paths: SessionPaths, record: OwnershipRecord): BindStep {
  const binding: BindingRecord = {
    session: record.session,
    root: record.root,
    capability: record.capability,
    bound: new Date().toISOString(),
  };
  try {
    writeRecord(paths.binding, binding);
    return { ok: true, binding };
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      return {
        ok: false,
        reason: 'session-busy',
        detail: `${paths.binding} could not be created (${errorCode(error)})`,
      };
    }
  }

  const existing = readRecord(paths.binding);
  if (!existing.ok) {
    return {
      ok: false,
      reason: 'session-busy',
      detail: `${paths.binding} exists and carries no readable binding (${existing.detail}); it must be cleared by an operator`,
    };
  }
  const boundRoot = existing.value.root;
  const boundCapability = existing.value.capability;
  if (boundRoot !== record.root) {
    return {
      ok: false,
      reason: 'session-root-mismatch',
      detail: `session "${record.session}" is bound to root ${String(boundRoot)}; this call names ${record.root}`,
    };
  }
  if (boundCapability !== record.capability) {
    return {
      ok: false,
      reason: 'session-capability-mismatch',
      detail: `session "${record.session}" is bound to the "${String(boundCapability)}" capability; this call asks for "${record.capability}"`,
    };
  }
  return { ok: true, binding: existing.value as unknown as BindingRecord };
}

/**
 * Acquire one session: mint when the caller named none, take ownership, bind on
 * first use and hand back the release. The caller releases last.
 */
export function acquireSession(options: AcquireOptions): SessionAcquisition {
  const { sessionHome, runDir, root, capability, callId } = options;
  const procDir = options.procDir ?? '/proc';

  let session = options.session;
  if (session === undefined) {
    session = mintSessionId();
  } else if (!isSessionId(session)) {
    return {
      ok: false,
      reason: 'session-invalid',
      detail: `session ${JSON.stringify(session)} does not match the session grammar ${SESSION_GRAMMAR.source}`,
    };
  }

  const paths = sessionPaths(sessionHome, session);
  const refuse = (reason: SessionRefusal, detail: string): SessionAcquisition => ({ ok: false, reason, detail });

  try {
    mkdirSync(paths.home, { recursive: true, mode: OWNER_ONLY_DIR });
    mkdirSync(paths.sessions, { recursive: true, mode: OWNER_ONLY_DIR });
  } catch (error) {
    return refuse('session-busy', `the session state under ${sessionHome} could not be laid out (${errorCode(error)})`);
  }

  const own = processStartTime(procDir, process.pid);
  if (!own.ok) {
    return refuse(
      'session-busy',
      `this process's kernel start time cannot be read from ${procDir}, so its ownership record would be indistinguishable from a stale one`,
    );
  }
  const record: OwnershipRecord = {
    session,
    pid: process.pid,
    starttime: own.starttime,
    call_id: callId,
    started: new Date().toISOString(),
    root,
    capability,
  };

  const held = takeOwnership(paths, record, procDir, runDir, callId, options.policyDigest, false);
  if (!held.ok) return refuse(held.reason, held.detail);

  // `<home>/<id>` is laid out only now, under the lock this call won: a refused
  // call leaves the session home exactly as it found it (EX-2), so the loser of a
  // contended session creates no directory of its own. Home and `sessions` are
  // made before the lock because the lock lives in `sessions`; the session
  // directory is a side effect of ownership, so it comes after it.
  try {
    mkdirSync(paths.sessionDir, { recursive: true, mode: OWNER_ONLY_DIR });
  } catch (error) {
    // The lock is this call's and the layout it protects cannot be made: give the
    // ownership back before refusing, so the refusal is this call's layout failure
    // and not a lock the next caller would have to wait out.
    releaseSession(paths, record);
    return refuse('session-busy', `the session state under ${sessionHome} could not be laid out (${errorCode(error)})`);
  }

  const bound = bind(paths, record);
  if (!bound.ok) {
    // The lock is this call's; a refused call keeps no ownership.
    releaseSession(paths, record);
    return refuse(bound.reason, bound.detail);
  }

  return {
    ok: true,
    session,
    sessionDir: paths.sessionDir,
    paths,
    root,
    capability,
    binding: bound.binding,
    release: () => releaseSession(paths, record),
  };
}

// ── Release ────────────────────────────────────────────────────────────────

/**
 * Release last. The lock is unlinked ONLY when the record at `<lock>` is still
 * this owner's — same pid, same kernel start time, same call id. Any other record
 * is a successor, and an unlink by path alone would delete a live lock (sec-6), so
 * it is left in place and noted. An absent lock is simply nothing to release.
 */
export function releaseSession(
  paths: SessionPaths,
  record: OwnershipRecord,
  diagnostics: Diagnostics = process.stderr,
): void {
  const observed = readOwnership(paths.lock);
  if (!observed.ok) {
    if (observed.missing) return;
    diagnostics.write(`quotient: leaving ${paths.lock} in place: ${observed.detail}\n`);
    return;
  }
  const holder = observed.record;
  if (holder.pid !== record.pid || holder.starttime !== record.starttime || holder.call_id !== record.call_id) {
    diagnostics.write(
      `quotient: leaving ${paths.lock} in place: it is not this owner's record (pid ${holder.pid}, start time ${holder.starttime}, call ${JSON.stringify(holder.call_id)})\n`,
    );
    return;
  }
  try {
    unlinkSync(paths.lock);
  } catch (error) {
    diagnostics.write(`quotient: could not release ${paths.lock} (${errorCode(error)})\n`);
  }
}
