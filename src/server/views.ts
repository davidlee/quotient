// The one answer to "what is run X" (design sec-3, sec-7): a live registry record
// as a view, or a handle no registry holds, resolved from its evidence directory.
//
// `viewOf` copies a record into the view every caller reads; `viewFromDisk` walks
// sec-3's flowchart (with D-5: a failed read of the directory or the audit reads
// `unreadable`) — the result first, then a published `lost` record,
// then the `admitted` record's owner and its liveness — so a run that has read
// `completed` never then reads `working`, and a run is called `lost` only on
// positive evidence that no one can still write it a result. Nothing here throws:
// every absent directory, unreadable file and torn audit is a described answer.
import { statSync } from 'node:fs';
import {
  layoutFor,
  readAudit,
  readResult,
  RUN_NAME_GRAMMAR,
  type AuditRecord,
  type RunLayout,
} from './evidence.ts';
import type { AgentResult, ResultState, Termination } from './result.ts';
import { absent } from './paths.ts';
import type { Registry, RunRecord } from './runs.ts';
import { ownerLiveness, parseRunOwner, type HostIdentity, type RunOwner } from './session.ts';

/** A run as a reader sees it: `settled` and `lost` are terminal, `foreign` is not. */
export type ViewState = 'queued' | 'running' | 'foreign' | 'settled' | 'lost';

/** One run as every reader sees it: a live record's facts, or what its evidence says. */
export type RunView = {
  run: string;
  layout: RunLayout;
  state: ViewState;
  createdAt: string;
  updatedAt: string;
  lane: string | null;
  key: string | null;
  session: string | null;
  predecessor: string | null;
  cancelled: boolean;
  outcome: { state: ResultState; causes: Termination[] } | null;
  foreignPid: number | null;
};

/** A resolved run: its view, and the result document when it is settled and readable. */
export type Resolved = { view: RunView; result: AgentResult | null };

/** What resolving a handle answers: the run, `unreadable` for a result that cannot be
 *  read now, or null for an id that no evidence names. */
export type Resolution = Resolved | 'unreadable' | null;

/** One run's view, copied from the record the registry holds. A live record is the
 *  server's own, so no disk is consulted and no foreign owner is named. */
export function viewOf(record: RunRecord): RunView {
  return {
    run: record.run,
    layout: record.layout,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lane: record.lane,
    key: record.key,
    session: record.session,
    predecessor: record.predecessor,
    cancelled: record.cancelled,
    outcome: record.outcome === null ? null : { state: record.outcome.state, causes: [...record.outcome.causes] },
    foreignPid: null,
  };
}

/**
 * What is run X: the live record when the registry holds one, else its evidence
 * directory (design sec-3). The result document travels with the view, so no caller
 * reads `result.json` a second time. A live record's state is never changed by a
 * failed read: the view stands and only the result is missing.
 */
export function resolveRun(
  registry: Registry,
  runDir: string,
  procDir: string,
  here: HostIdentity,
  run: string,
): Resolution {
  const record = registry.get(run);
  if (record === undefined) {
    return viewFromDisk(runDir, run, procDir, here);
  }
  const view = viewOf(record);
  if (record.state !== 'settled') {
    return { view, result: null };
  }
  const read = readResult(record.layout);
  return { view, result: isFound(read) ? read.found : null };
}

/**
 * A handle no registry holds, resolved from disk by sec-3's flowchart: the result
 * settles it; a published `lost` record outranks an unreadable result; an unreadable
 * result is reported apart, never as `lost` or `foreign`; and with no result, the
 * `admitted` record's owner and its liveness decide between `foreign` and `lost`.
 * A malformed id, or no directory at all, names no run: null.
 */
export function viewFromDisk(
  runDir: string,
  run: string,
  procDir: string,
  here: HostIdentity,
): Resolution {
  if (!RUN_NAME_GRAMMAR.test(run)) {
    return null;
  }
  const layout = layoutFor(runDir, run);
  const mtime = directoryMtime(layout.dir);
  if (mtime === 'absent' || mtime === 'unreadable') {
    return mtime === 'absent' ? null : 'unreadable';
  }
  const result = readResult(layout);
  const read: DiskRead = { layout, run, trail: readTrail(layout, mtime.at), procDir, here };
  if (isFound(result)) {
    return settledAt(read, result);
  }
  if (read.trail.lost) {
    return withoutResult(read, 'lost', null);
  }
  if (result === 'unreadable') {
    return 'unreadable';
  }
  return ownerResolution(read);
}

/** One disk resolution's fixed inputs: the run's paths, the trail it left and the
 *  pid table its owner is judged against. */
type DiskRead = {
  layout: RunLayout;
  run: string;
  trail: Trail;
  procDir: string;
  here: HostIdentity;
};

/** What `readResult` answers: the document with the moment it landed, or why there
 *  is none. */
type ResultRead = ReturnType<typeof readResult>;

/** The document arm of a result read. */
type Found = Extract<ResultRead, { found: AgentResult }>;

/** A result read found a conforming document: the one branch that settles a run. */
function isFound(read: ResultRead): read is Found {
  return typeof read === 'object';
}

/** A settled run: the view, and the document read once. */
function settledAt(read: DiskRead, found: Found): Resolved {
  return { view: diskView(read, 'settled', found, null), result: found.found };
}

/** A run with no result to carry: `lost`, or `foreign` when another server may still
 *  be writing one. */
function withoutResult(read: DiskRead, state: 'foreign' | 'lost', foreignPid: number | null): Resolved {
  return { view: diskView(read, state, null, foreignPid), result: null };
}

/**
 * What a run's audit says (design sec-7): the fields a disk view is built from, the
 * two flags the flowchart branches on, and the timestamps the evidence gives. An
 * audit that cannot be read is `readable: false` and says nothing at all; the
 * directory's own mtime is then the first stamp.
 */
type Trail = {
  /** The `admitted` record, when one whole line names it. */
  admitted: AuditRecord | null;
  /** A published `lost` record: the commit's rename never happened. */
  lost: boolean;
  /** A line was skipped as unparsable, so the trail has a hole. */
  torn: boolean;
  readable: boolean;
  createdAt: string;
  /** The latest record's `ts`, or `createdAt` when there is none. */
  updatedAt: string;
};

/** One run's audit as a trail (design sec-7): the first record's `ts` is `createdAt`,
 *  the last one's moves `updatedAt`. */
function readTrail(layout: RunLayout, mtime: string): Trail {
  const audit = readAudit(layout);
  if (audit === null) {
    return { admitted: null, lost: false, torn: false, readable: false, createdAt: mtime, updatedAt: mtime };
  }
  const { records, torn } = audit;
  const createdAt = stampOf(records[0]) ?? mtime;
  return {
    admitted: records.find((record) => record.record === 'admitted') ?? null,
    lost: records.some((record) => record.record === 'lost'),
    torn,
    readable: true,
    createdAt,
    updatedAt: latestStamp(createdAt, stampOf(records[records.length - 1])),
  };
}

/** A record's `ts`, when it carries one: the audit is untrusted JSON. */
function stampOf(record: AuditRecord | undefined): string | null {
  const ts = record?.ts;
  return typeof ts === 'string' ? ts : null;
}

/** The latest of these stamps; every stamp is a `toISOString`, so later is greater
 *  as text. The first is always present. */
function latestStamp(first: string, ...rest: (string | null)[]): string {
  let newest = first;
  for (const stamp of rest) {
    if (stamp !== null && stamp > newest) {
      newest = stamp;
    }
  }
  return newest;
}

/** A record field as text, or null: the audit is untrusted JSON, so a field of
 *  another type is a field the trail does not have. */
function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The directory's modification time — the oldest stamp a view can use — or why
 *  there is none (D-5): `absent` when no directory is there, so the run names no
 *  evidence; `unreadable` for any other failure, which is no evidence of absence. */
function directoryMtime(dir: string): { at: string } | 'absent' | 'unreadable' {
  try {
    const stat = statSync(dir);
    return stat.isDirectory() ? { at: stat.mtime.toISOString() } : 'absent';
  } catch (error) {
    return absent(dir, error) ? 'absent' : 'unreadable';
  }
}

/**
 * The result was absent: the owner decides (design sec-3). An audit that cannot be
 * read is a failed observation and reads `unreadable` (D-5); one with no `admitted`
 * record and a torn line names no owner but is no evidence that none was recorded,
 * so it reads `foreign`; a whole trail with no `admitted` record, or one whose
 * record names no owner, reads `lost`.
 */
function ownerResolution(read: DiskRead): Resolution {
  const { admitted, readable, torn } = read.trail;
  // A failed read of the audit could hide a published `lost` record (D-5).
  if (!readable) {
    return 'unreadable';
  }
  if (admitted === null) {
    return withoutResult(read, torn ? 'foreign' : 'lost', null);
  }
  if (admitted.owner === undefined || admitted.owner === null) {
    return withoutResult(read, 'lost', null);
  }
  // An owner that does not parse is one this reader cannot judge — never a dead one.
  const owner = parseRunOwner(admitted.owner);
  return owner === null ? withoutResult(read, 'foreign', null) : livenessResolution(read, owner);
}

/** The owner's liveness decides (design sec-3): a live or unknowable owner reads
 *  `foreign`, and a stale one is confirmed dead only by a second read — it may have
 *  committed its result between the first read and the liveness check. */
function livenessResolution(read: DiskRead, owner: RunOwner): Resolution {
  if (ownerLiveness(read.procDir, read.here, owner) !== 'stale') {
    return withoutResult(read, 'foreign', owner.pid);
  }
  const again = readResult(read.layout);
  if (isFound(again)) {
    return settledAt(read, again);
  }
  return again === 'unreadable' ? 'unreadable' : withoutResult(read, 'lost', null);
}

/**
 * One run's view from its evidence (design sec-7): the `admitted` record's lane, key,
 * predecessor and session, the found result's outcome, `createdAt` from the first
 * audit record and `updatedAt` from the latest of the last record, the result write
 * and `createdAt`. Nothing on disk carries a cancel mark, so `cancelled` is false.
 */
function diskView(read: DiskRead, state: ViewState, found: Found | null, foreignPid: number | null): RunView {
  const { admitted, createdAt, updatedAt } = read.trail;
  return {
    run: read.run,
    layout: read.layout,
    state,
    createdAt,
    updatedAt: latestStamp(updatedAt, found?.writtenAt ?? null),
    lane: textOf(admitted?.lane),
    key: textOf(admitted?.key),
    session: textOf(admitted?.session),
    predecessor: textOf(admitted?.predecessor),
    cancelled: false,
    outcome: found === null ? null : { state: found.found.state, causes: [...found.found.causes] },
    foreignPid,
  };
}
