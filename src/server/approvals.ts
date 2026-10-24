// The approvals store (design sec-2 "The approvals store"; its format is
// `docs/contract/quotient-approvals-1.md`): which identity runs for one
// (root, capability), as the operator recorded it.
//
// One reader, one lookup and one writer. The reader is closed-world: a store this
// module would not have written is malformed, and a malformed store refuses every
// call rather than being silently narrowed — whether an approval governs a call is
// itself the selection, so a store that cannot be read decides nothing. The writer
// is the only one: it reads and publishes under a lock, and publishes by rename, so
// a reader never sees half a store and two operators never interleave.
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { absent, errorCode, within } from './paths.ts';
import { isFilesystem, type Filesystem } from './profiles.ts';

/** The schema tag this build reads and writes. */
export const APPROVALS_SCHEMA = 'quotient-approvals/1';

/** One recorded approval: the identity that runs for a root and a capability. */
export type Approval = {
  /** The canonical `roots` entry the approved form matched when it was recorded. */
  root: string;
  capability: Filesystem;
  /** The approved real path of the form — never the project's link. */
  path: string;
  /** sha256 of that file's bytes. */
  sha256: string;
  approved_at: string;
};

export type ApprovalsRead = { ok: true; approvals: Approval[] } | { ok: false; detail: string };

const DOCUMENT_KEYS: readonly string[] = ['schema', 'approvals'];
const ENTRY_KEYS: readonly string[] = ['root', 'capability', 'path', 'sha256', 'approved_at'];
/** A digest is 64 lowercase hex characters, and nothing else. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type EntryRead = { ok: true; approval: Approval } | { ok: false; detail: string };
type EntriesRead = { ok: true; entries: unknown[] } | { ok: false; detail: string };
type RecordRead = { ok: true; record: Record<string, unknown> } | { ok: false; detail: string };
type JsonRead = { ok: true; value: unknown } | { ok: false; detail: string };

const invalid = (detail: string): { ok: false; detail: string } => ({ ok: false, detail });

const isCanonicalAbsolute = (value: unknown): value is string =>
  typeof value === 'string' && isAbsolute(value) && resolve(value) === value;

/** A digest is 64 lowercase hex characters, and nothing else. Exported so the
 *  verbs parse the digest they are given by the same rule the store reads it. */
export const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && SHA256_HEX.test(value);

/** VALUE as a record whose keys are exactly KEYS, or why it is not one. AT names
 *  it in the detail, as `approvals[3]`. */
function readRecord(value: unknown, keys: readonly string[], at: string): RecordRead {
  if (!isRecord(value)) {return invalid(`${at} is not an object`);}
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) {return invalid(`${at}: unknown key ${JSON.stringify(unknown)}`);}
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) {return invalid(`${at}: missing key ${JSON.stringify(missing)}`);}
  return { ok: true, record: value };
}

/** One entry, closed-world. AT names it in a detail, as `approvals[3]`.
 *
 *  ROOT and PATH must be canonical (`resolve(x) === x`): `/work/one` and
 *  `/work/one/` name one directory, so admitting both would key one root twice and
 *  let the order of entries decide which identity runs. */
function readEntry(value: unknown, at: string): EntryRead {
  const shape = readRecord(value, ENTRY_KEYS, at);
  if (!shape.ok) {return shape;}
  const { root, capability, path, sha256, approved_at: approvedAt } = shape.record;
  if (!isCanonicalAbsolute(root)) {return invalid(`${at}: root must be a canonical absolute path string`);}
  if (!isCanonicalAbsolute(path)) {return invalid(`${at}: path must be a canonical absolute path string`);}
  if (!isFilesystem(capability)) {return invalid(`${at}: capability must be "read" or "write"`);}
  if (!isDigest(sha256)) {return invalid(`${at}: sha256 must be 64 lowercase hex characters`);}
  if (typeof approvedAt !== 'string') {return invalid(`${at}: approved_at must be a string`);}
  return { ok: true, approval: { root, capability, path, sha256, approved_at: approvedAt } };
}

/** TEXT as JSON, or why it is not. */
function parseJson(text: string): JsonRead {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return invalid('not valid JSON');
  }
}

/** The document's ENTRIES, closed-world, in the order the document names its
 *  faults. No path: the caller names the store. */
function readDocument(parsed: unknown): EntriesRead {
  if (!isRecord(parsed)) {return invalid('not a JSON object');}
  if (!Object.hasOwn(parsed, 'schema')) {return invalid('missing approvals field: schema');}
  if (parsed.schema !== APPROVALS_SCHEMA) {
    return invalid(`schema ${JSON.stringify(parsed.schema)} is not one this build reads: expected "${APPROVALS_SCHEMA}"`);
  }
  const unknown = Object.keys(parsed).find((key) => !DOCUMENT_KEYS.includes(key));
  if (unknown !== undefined) {return invalid(`unknown approvals field: ${unknown}`);}
  if (!Object.hasOwn(parsed, 'approvals')) {return invalid('missing approvals field: approvals');}
  const entries = parsed.approvals;
  if (!Array.isArray(entries)) {return invalid('approvals must be an array');}
  return { ok: true, entries };
}

/** ENTRIES read one at a time, each named by its index in any detail. */
function readEntries(entries: unknown[]): ApprovalsRead {
  const approvals: Approval[] = [];
  const recorded = new Set<string>();
  for (const [index, value] of entries.entries()) {
    const at = `approvals[${String(index)}]`;
    const entry = readEntry(value, at);
    if (!entry.ok) {return entry;}
    const { root, capability } = entry.approval;
    // At most one entry per root and capability: two would be two identities for
    // one call, and the tie-break would be policy order.
    const identity = `${root}\u0000${capability}`;
    if (recorded.has(identity)) {
      return invalid(`${at}: duplicate entry for the root ${JSON.stringify(root)} and the capability ${JSON.stringify(capability)}`);
    }
    recorded.add(identity);
    approvals.push(entry.approval);
  }
  return { ok: true, approvals };
}

/** The whole document, closed-world. No path: the caller names the store. */
function parseApprovals(text: string): ApprovalsRead {
  const parsed = parseJson(text);
  if (!parsed.ok) {return parsed;}
  const document = readDocument(parsed.value);
  return document.ok ? readEntries(document.entries) : document;
}

/**
 * The store at PATH, or why it cannot be one. An absent file is an empty store; an
 * entry that is not an absent one (`absent()`: a dangling link is not absent) is a
 * deployment to fix, not an empty store.
 */
export function readApprovals(path: string): ApprovalsRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return absent(path, error) ? { ok: true, approvals: [] } : invalid(`${path}: could not be read (${errorCode(error)})`);
  }
  const parsed = parseApprovals(text);
  return parsed.ok ? parsed : invalid(`${path}: ${parsed.detail}`);
}

/**
 * The entry for CAPABILITY whose recorded root contains ROOT, deepest first; the
 * store holds canonical roots and ROOT is the call's canonical root, so every
 * candidate that governs the call is one whose root contains it, however the call
 * was spelled. Pure: the store is read by the caller.
 */
export function governingApproval(
  approvals: readonly Approval[],
  root: string,
  capability: Filesystem,
): Approval | undefined {
  let governing: Approval | undefined;
  for (const approval of approvals) {
    if (approval.capability !== capability || !within(approval.root, root)) {continue;}
    // Both candidates contain ROOT, so the deeper one contains the other.
    if (governing === undefined || within(governing.root, approval.root)) {governing = approval;}
  }
  return governing;
}

// ── The writer (EX-4) ──────────────────────────────────────────────────────

/** The writer's verdict: it published, or it did not and why. */
export type ApprovalsUpdate = { ok: true } | { ok: false; detail: string };

/**
 * The only writer (design sec-2 "The approvals store"): take the lock, read under
 * it, apply CHANGE, publish by rename, release the lock in every path. CHANGE
 * returns the new list, or a string that aborts the write with that detail — the
 * store is then byte-identical to what it was.
 *
 * The lock is never reclaimed automatically: its holder is an operator command, not
 * a server, so a stale lock is the operator's to remove rather than something to
 * break on the operator's behalf.
 */
export function updateApprovals(
  path: string,
  change: (current: Approval[]) => Approval[] | string,
): ApprovalsUpdate {
  // A first-ever record on a host whose `quotient/` directory does not exist yet:
  // the lock create would otherwise fail ENOENT instead of taking the lock.
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const taken = takeLock(lock);
  if (!taken.ok) {return taken;}
  try {
    const current = readApprovals(path);
    // Malformed or unreadable aborts before CHANGE runs and before anything is written.
    if (!current.ok) {return current;}
    const next = change(current.approvals);
    if (typeof next === 'string') {return { ok: false, detail: next };}
    // What CHANGE returns is read by the same parser before it is published: the
    // writer never records a store this build would refuse.
    const body = document(next);
    const admitted = parseApprovals(body);
    if (!admitted.ok) {
      return { ok: false, detail: `the change would publish a store this build would refuse: ${admitted.detail}` };
    }
    publish(path, body);
    return { ok: true };
  } finally {
    releaseLock(lock);
  }
}

/** The lock, taken with O_EXCL and carrying this process's pid. */
function takeLock(lock: string): ApprovalsUpdate {
  let fd: number;
  try {
    fd = openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {return { ok: false, detail: `${lock} could not be created (${errorCode(error)})` };}
    return {
      ok: false,
      detail: `${lock} is held by ${lockHolder(lock)}; if no quotient allow or revoke is running, remove it by hand and retry`,
    };
  }
  try {
    writeSync(fd, `${String(process.pid)}\n`);
  } finally {
    closeSync(fd);
  }
  return { ok: true };
}

/** The pid a lock carries, or the empty string when it is gone or carries none. */
function lockPid(lock: string): string {
  try {
    return readFileSync(lock, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Who holds a lock, from the pid it carries; a lock with no readable pid names none. */
function lockHolder(lock: string): string {
  const pid = lockPid(lock);
  return pid.length === 0 ? 'a process that left no pid' : `pid ${pid}`;
}

/** The lock, unlinked only while it still carries this writer's pid: a lock another
 *  writer replaced is theirs, and removing it would admit a third. */
function releaseLock(lock: string): void {
  if (lockPid(lock) === String(process.pid)) {rmSync(lock, { force: true });}
}

/** The writer's published form: the reader is the only thing that must accept it,
 *  and a stable text form keeps a recorded store diffable. */
const document = (approvals: readonly Approval[]): string =>
  `${JSON.stringify({ schema: APPROVALS_SCHEMA, approvals }, null, 2)}\n`;

/**
 * The publish: a private temp file BESIDE the store (same directory, so the rename
 * cannot cross a filesystem), flushed, then renamed over it. A reader sees the old
 * store or the new one, never half of either.
 *
 * The temp name is cleared before the create and unconditionally after it: a file
 * planted there is never reused (it would keep its own mode) and never written
 * through (a planted link), and a publish that fails leaves no debris.
 */
function publish(path: string, body: string): void {
  const tmp = `${path}.${String(process.pid)}.tmp`;
  rmSync(tmp, { force: true });
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
