// The run registry: the record a run becomes for the server's whole life.
//
// A run is one admitted delegation — a session, an evidence directory, at most
// one child — and here it stops being an ambient detail of the `tools/call` that
// started it. `start` publishes it (an `admitted` audit record, then the record
// itself) and places it on its lane; `launch` is the server's run task, handed in
// as a seam so this module never imports admission or execution; `settle` is the
// one save sequence every ending passes through, whatever ended the run. The
// registry keeps no result payload: a blocked caller is handed its document, and
// the record keeps only the state and causes a lane or a task status needs.
//
// Nothing here throws. Every failure is a settlement, a diagnostic line, or a
// refusal the caller reports on the wire.
import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import type { Writable } from 'node:stream';
import { EMPTY_STATUS } from '../reduce/reduce.ts';
import type { Admitted, Refused } from './admission.ts';
import {
  appendAttempt,
  appendAudit,
  removeRun,
  runLayout,
  RUN_NAME_GRAMMAR,
  writeResult,
  type AuditRecord,
  type RunLayout,
} from './evidence.ts';
import { failedResult, refusedResult, type AgentResult, type ResultState, type Termination } from './result.ts';

/** A run's four states: `lost` is reached only when `result.json` cannot land. */
export type RunState = 'queued' | 'running' | 'settled' | 'lost';

/** Which door a run came through: an implicit start, a blocking call, a task. */
export type Origin = 'start' | 'blocking' | 'task';

/**
 * One run as the registry holds it: compact facts, never a result document. A
 * final answer is unbounded, so `outcome` keeps only the settled result's state
 * and causes — what a lane's `needs_success` and a task status are decided from.
 */
export type RunRecord = {
  /** The handle, which is also the task id: the run directory's name. */
  readonly run: string;
  /** The run's evidence paths. */
  readonly layout: RunLayout;
  /** Which door it came through; set once, by `start`. */
  readonly origin: Origin;
  /** The lane it was started into, or null for one that launches at once. */
  readonly lane: string | null;
  /** The lane's last-started run when this one was enqueued, if there was one. */
  readonly predecessor: string | null;
  readonly needsSuccess: boolean;
  /** The idempotency key it was started with, if any. */
  readonly key: string | null;
  /** sha256 of the normalised request, the key excluded. */
  readonly argsDigest: string;
  readonly session: string;
  /** The `admitted` record's ts. */
  readonly createdAt: string;
  /** The latest audit record's ts, or the moment `result.json` landed. */
  updatedAt: string;
  state: RunState;
  /** The settled result's state and causes, or null when nothing was written. */
  outcome: { state: ResultState; causes: Termination[] } | null;
  /** An intent mark, taken before any await; it never changes the state. */
  cancelled: boolean;
  /** Set only by `ack`, and only once the run is terminal. */
  acknowledged: boolean;
  /** The run's one abort trigger: a cancel and EOF both drive its ladder. */
  readonly controller: AbortController;
  /** Resolves once the run has settled or been lost. */
  readonly settled: Promise<void>;
};

/** What a start gives the registry once admission decided that the run MAY run. */
export type StartSpec = {
  admitted: Admitted;
  origin: Origin;
  lane: string | null;
  needsSuccess: boolean;
  key: string | null;
  argsDigest: string;
};

/**
 * The server's run task: re-admission when the run waited on a lane, then the run
 * itself. A re-admission refusal comes back as `{ refused }`, so the registry can
 * record it and settle the run as that refusal; `onAudit` carries each audit ts
 * the run task appends, so `updatedAt` follows the evidence.
 */
export type Launch = (
  record: RunRecord,
  admitted: Admitted,
  queued: boolean,
  onAudit: (ts: string) => void,
) => Promise<{ refused: Refused } | { result: AgentResult }>;

/** One `pi_agent_ack` verdict per id: acknowledged, or why it was not. */
export type AckEntry =
  | { taskId: string; acknowledged: true }
  | { taskId: string; acknowledged: false; reason: 'not-settled' | 'unknown' };

/** The registry the server drives: every run it owns, and the ways one ends. */
export type Registry = {
  /** Publish, place, and maybe launch: synchronous from admission to the record. */
  start(spec: StartSpec): { ok: true; record: RunRecord; document: Promise<AgentResult> } | Refused;
  findKey(key: string): RunRecord | undefined;
  get(run: string): RunRecord | undefined;
  /** The unacknowledged `start` runs in start order, or those in the named lanes. */
  implicit(lanes?: string[]): RunRecord[];
  ack(runs: string[]): AckEntry[];
  /** Marks and starts every target's ending synchronously; the promise is theirs. */
  cancel(runs: string[]): Promise<void>;
  /** EOF observed: no lane advances or launches from here. */
  closing(): void;
  /** EOF: closing, abort running runs, drop queued ones, await every record. */
  close(): Promise<void>;
};

/**
 * What a start's key decides before admission: reuse the run it already names,
 * refuse a clash, or null when no run holds the key and the start admits afresh.
 */
export function matchKey(found: RunRecord | undefined, argsDigest: string): { reuse: RunRecord } | Refused | null {
  if (found === undefined) { return null; }
  if (found.argsDigest === argsDigest) { return { reuse: found }; }
  return { ok: false, reason: 'request-invalid', detail: 'the key was used with different arguments' };
}

/** The record while it is being published: `createdAt` is the `admitted` record's
 *  ts, so it is filled in when that record lands. */
type Draft = { -readonly [K in keyof RunRecord]: RunRecord[K] };

/** What a published, unsettled run still needs, and all it needs: the admission it
 *  will launch and release with, and the two promises only it can resolve. */
type Live = {
  admitted: Admitted;
  /** Hand the caller the document the settlement wrote. */
  hand: (document: AgentResult) => void;
  /** Resolve the record's `settled`. */
  done: () => void;
};

/** One lane: its runs in start order, and the last one started into it. */
type Lane = {
  queue: RunRecord[];
  lastStarted: RunRecord | null;
};

/** Everything the registry owns, threaded through the functions below. */
type RegistryState = {
  /** Every run held, in start order. */
  records: Map<string, RunRecord>;
  /** Key → run, written by a start that succeeded and never removed. */
  keys: Map<string, RunRecord>;
  live: Map<string, Live>;
  /** Lanes by name, created by the first start that names one. */
  lanes: Map<string, Lane>;
  /** The lanes an advance has been asked for. */
  due: Set<string>;
  /** True while the advance loop runs: a call then only asks for a turn. */
  advancing: boolean;
  /** True while a start places its run: a launch inside it is not queued. */
  admitting: boolean;
  /** True once EOF is observed: no lane advances or launches. */
  closed: boolean;
  diagnostics: Writable;
  launch: Launch;
};

/** A promise and its resolver, held apart: the registry resolves a settled run's
 *  `settled` and a caller's document, then keeps neither. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const box: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>((resolve) => {
    box.resolve = resolve;
  });
  return { promise, resolve: (value: T): void => { box.resolve?.(value); } };
}

/** One line from a caught value, for a diagnostic or a refusal's detail. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a record has reached a terminal state: settled, or lost. */
const terminal = (record: RunRecord): boolean => record.state === 'settled' || record.state === 'lost';

/** Whether a lookup found a record: the filter that keeps the ones that did. */
const isRun = (record: RunRecord | undefined): record is RunRecord => record !== undefined;

/** Whether an id cannot name a run at all: every handle obeys one grammar. */
const unknownId = (id: string): boolean => !RUN_NAME_GRAMMAR.test(id);

/** The verdict for an id no record will answer. */
const unacknowledged = (taskId: string): AckEntry => ({ taskId, acknowledged: false, reason: 'unknown' });

/** Whether a run is one an implicit wait may target: a `start` door, still
 *  unacknowledged, and in a named lane when lanes were named. */
function selectable(record: RunRecord, only: string[] | undefined): boolean {
  if (record.origin !== 'start' || record.acknowledged) { return false; }
  return only === undefined || (record.lane !== null && only.includes(record.lane));
}

/** How a predecessor ended, in words a refusal names: its result's state, or
 *  `lost`, which left no result and so no outcome. */
function stateOf(before: RunRecord | null): string {
  if (before === null) { return 'none'; }
  if (before.state === 'lost') { return 'lost'; }
  return before.outcome?.state ?? before.state;
}

/** The failed arm a loss hands a caller: the cause `audit` leads, so the reported
 *  termination is `causes[0]` as `pi-agent-result/2` requires. */
function failedArm(record: RunRecord, document: AgentResult): AgentResult {
  return failedResult(
    'audit',
    ['audit', ...document.causes],
    record.session,
    document.status ?? EMPTY_STATUS,
    record.layout,
  );
}

/** The registry over one server's runs: the seam is `launch`, the sink is where
 *  bookkeeping it cannot hand to a caller is reported. */
export function createRegistry(deps: { launch: Launch; diagnostics: Writable; now?: () => string }): Registry {
  const state: RegistryState = {
    records: new Map<string, RunRecord>(),
    keys: new Map<string, RunRecord>(),
    live: new Map<string, Live>(),
    lanes: new Map<string, Lane>(),
    due: new Set<string>(),
    advancing: false,
    admitting: false,
    closed: false,
    diagnostics: deps.diagnostics,
    launch: deps.launch,
  };
  return {
    start: (spec: StartSpec) => start(state, spec),
    findKey: (key: string): RunRecord | undefined => state.keys.get(key),
    get: (run: string): RunRecord | undefined => state.records.get(run),
    implicit: (lanes?: string[]): RunRecord[] => implicit(state, lanes),
    ack: (runs: string[]): AckEntry[] => ack(state, runs),
    cancel: (runs: string[]): Promise<void> => cancel(state, runs),
    closing: (): void => { state.closed = true; },
    close: (): Promise<void> => close(state),
  };
}

/** One diagnostic line: nothing the registry writes can fail outward, so this is
 *  where a failure only the operator can see is said. */
function report(state: RegistryState, detail: string): void {
  state.diagnostics.write(`quotient: ${detail}\n`);
}

/**
 * Append one of the registry's own audit records: `refused`, `cancelled`, `dropped`
 * and `lost` all come through here, each stamped with the policy the run was
 * admitted under and its session. Returns the ts it wrote, or null when nothing
 * landed: before publication the caller refuses, and a settlement carries on.
 */
function audit(state: RegistryState, record: RunRecord, fields: AuditRecord): string | null {
  const ts = appendAudit(record.layout, {
    ...fields,
    policy_digest: state.live.get(record.run)?.admitted.policyDigest ?? null,
    session: record.session,
  });
  if (ts === null) {
    report(state, `could not append ${record.layout.audit}: ${record.run} ${fields.record}`);
    return null;
  }
  record.updatedAt = ts;
  return ts;
}

/**
 * Publish and place one run (sec-3's start steps 4 and 5): the audit record, the
 * record itself, then its lane. The key is mapped only on success, so a retry of
 * a refused start re-admits.
 */
function start(state: RegistryState, spec: StartSpec): { ok: true; record: RunRecord; document: Promise<AgentResult> } | Refused {
  const layout = runLayout(spec.admitted.runDir, spec.admitted.callId);
  const predecessor = previousRun(state, spec.lane);
  const settled = deferred<undefined>();
  const document = deferred<AgentResult>();
  const draft = draftOf(spec, layout, predecessor, settled.promise);
  state.live.set(draft.run, { admitted: spec.admitted, hand: document.resolve, done: (): void => { settled.resolve(undefined); } });
  const refused = publish(state, draft, spec, predecessor);
  if (refused !== null) {
    state.live.delete(draft.run);
    return refused;
  }
  const record: RunRecord = draft;
  state.records.set(record.run, record);
  if (record.key !== null) { state.keys.set(record.key, record); }
  state.admitting = true;
  try {
    place(state, record);
  } finally {
    state.admitting = false;
  }
  return { ok: true, record, document: document.promise };
}

/** One run's record, published but not yet inserted: the handle is the evidence
 *  directory's name, so an id can never name a path outside the run dir. */
function draftOf(spec: StartSpec, layout: RunLayout, predecessor: string | null, settled: Promise<void>): Draft {
  return {
    run: basename(layout.dir),
    layout,
    origin: spec.origin,
    lane: spec.lane,
    predecessor,
    needsSuccess: spec.needsSuccess,
    key: spec.key,
    argsDigest: spec.argsDigest,
    session: spec.admitted.session.session,
    createdAt: '',
    updatedAt: '',
    state: 'queued',
    outcome: null,
    cancelled: false,
    acknowledged: false,
    controller: new AbortController(),
    settled,
  };
}

/** The lane's last-started run, which a new run records as its predecessor. A run
 *  started into an idle lane still records the one that last used it. */
function previousRun(state: RegistryState, lane: string | null): string | null {
  if (lane === null) { return null; }
  return state.lanes.get(lane)?.lastStarted?.run ?? null;
}

/**
 * Write the run's first audit record, and through it its `createdAt`. A refusal
 * here means nothing ran: the directory is discarded, the attempts ledger records
 * why, and the session acquired at admission goes back.
 */
function publish(state: RegistryState, record: Draft, spec: StartSpec, predecessor: string | null): Refused | null {
  try {
    mkdirSync(record.layout.dir);
  } catch (error) {
    return publishFailed(spec.admitted, record.layout, `the run directory could not be made: ${messageOf(error)}`);
  }
  const ts = audit(state, record, {
    record: 'admitted',
    origin: spec.origin,
    lane: spec.lane,
    predecessor,
    needs_success: spec.needsSuccess,
    key: spec.key,
    owner: spec.admitted.session.owner,
  });
  if (ts === null) {
    return publishFailed(spec.admitted, record.layout, `the run's first audit record could not be written: ${record.layout.audit}`);
  }
  record.createdAt = ts;
  return null;
}

/** Discard a run that was never published, and answer the caller's refusal. */
function publishFailed(admitted: Admitted, layout: RunLayout, detail: string): Refused {
  removeRun(layout);
  appendAttempt(admitted.runDir, {
    callId: admitted.callId,
    reason: 'audit-failed',
    detail,
    policyDigest: admitted.policyDigest,
  });
  admitted.session.release();
  return { ok: false, reason: 'audit-failed', detail };
}

/** Put the run where it belongs: launched at once when it names no lane, otherwise
 *  queued on its lane, whose advance decides whether it launches (sec-4). */
function place(state: RegistryState, record: RunRecord): void {
  if (record.lane === null) {
    run(state, record);
    return;
  }
  const lane = laneOf(state, record.lane);
  lane.queue.push(record);
  // The predecessor was fixed when this run was published, before this line.
  lane.lastStarted = record;
  advance(state, record.lane);
}

/** A lane, created by the first start that names it: no declaration, no state
 *  beyond its queue and the last run started into it. */
function laneOf(state: RegistryState, name: string): Lane {
  const existing = state.lanes.get(name);
  if (existing !== undefined) { return existing; }
  const created: Lane = { queue: [], lastStarted: null };
  state.lanes.set(name, created);
  return created;
}

/**
 * Launch one run through the one guard (sec-3): the state flips first, so a cancel
 * arriving after this finds it running and reaches its ladder, and the launch runs
 * in a microtask so a synchronous throw is a rejection like any other. No path out
 * of a launch avoids `settle`.
 */
function run(state: RegistryState, record: RunRecord): void {
  const held = state.live.get(record.run);
  if (held === undefined) { return; }
  const queued = !state.admitting;
  record.state = 'running';
  Promise.resolve()
    .then(() => state.launch(record, held.admitted, queued, (ts) => { record.updatedAt = ts; }))
    .then(
      (outcome) => { ended(state, record, outcome); },
      (error: unknown) => { crashed(state, record, error); },
    )
    .catch((error: unknown) => { report(state, `run ${record.run} could not record its ending: ${messageOf(error)}`); });
}

/** A launch's answer: the run's own document, or the refusal re-admission decided,
 *  which is recorded as a `refused` record before the run settles as it. */
function ended(state: RegistryState, record: RunRecord, outcome: { refused: Refused } | { result: AgentResult }): void {
  if ('refused' in outcome) {
    audit(state, record, { record: 'refused', reason: outcome.refused.reason, detail: outcome.refused.detail });
    settle(state, record, refusedResult(outcome.refused.reason, outcome.refused.detail));
    return;
  }
  settle(state, record, outcome.result);
}

/** A launch that threw or rejected: the run is settled failed with cause `error`,
 *  which is the row a run established and then broken by the server takes. */
function crashed(state: RegistryState, record: RunRecord, error: unknown): void {
  report(state, `run ${record.run} threw after launch: ${messageOf(error)}`);
  settle(state, record, failedResult('error', ['error'], record.session, EMPTY_STATUS, record.layout));
}

/**
 * The one save sequence (sec-3), called by every way a run ends and nothing else:
 * the file, then the session, then the state, then the document a caller was
 * promised, then the lane. Exactly once per run; nothing here can throw.
 */
function settle(state: RegistryState, record: RunRecord, document: AgentResult): void {
  if (terminal(record)) { return; }
  const writtenAt = writeResult(record.layout, document);
  noteOutcome(state, record, document, writtenAt);
  const held = state.live.get(record.run);
  state.live.delete(record.run);
  held?.admitted.session.release();
  record.state = writtenAt === null ? 'lost' : 'settled';
  held?.hand(writtenAt === null ? failedArm(record, document) : document);
  held?.done();
  advance(state, record.lane);
}

/** What the settlement recorded: the written result's state and causes, or the
 *  published loss that lets every later server read the run as lost too. */
function noteOutcome(state: RegistryState, record: RunRecord, document: AgentResult, writtenAt: string | null): void {
  if (writtenAt === null) {
    audit(state, record, { record: 'lost' });
    return;
  }
  record.outcome = { state: document.state, causes: document.causes };
  record.updatedAt = writtenAt;
}

/**
 * Advance a lane (sec-4). One loop, not a recursion, so a long `needs_success`
 * cascade cannot grow the stack: a call made while the loop runs only adds its
 * lane to those due, and the running loop honours it.
 */
function advance(state: RegistryState, lane: string | null): void {
  if (lane === null) { return; }
  state.due.add(lane);
  if (state.advancing) { return; }
  state.advancing = true;
  try {
    for (const next of state.due) {
      state.due.delete(next);
      turn(state, next);
    }
  } finally {
    state.advancing = false;
  }
}

/** One turn of a lane: drop what is done, then launch the head unless the server
 *  is closing or a run is still executing there. */
function turn(state: RegistryState, name: string): void {
  const lane = state.lanes.get(name);
  if (state.closed || lane === undefined) { return; }
  dropDone(lane);
  if (lane.queue.length === 0) { return; }
  const head = lane.queue[0];
  if (head.state === 'running') { return; }
  launchHead(state, head);
}

/** Whether a lane entry is behind the lane for good: settled, lost, or marked
 *  cancelled while still queued (the cancel path settles it, it never launches). */
function isDone(record: RunRecord): boolean {
  return terminal(record) || (record.state === 'queued' && record.cancelled);
}

/** Drop the lane's finished runs from the front of its queue. */
function dropDone(lane: Lane): void {
  while (lane.queue.length > 0 && isDone(lane.queue[0])) {
    lane.queue.shift();
  }
}

/** Launch the lane's head, unless it needs its predecessor's success and did not
 *  get it: then it is refused without ever launching (sec-4). */
function launchHead(state: RegistryState, head: RunRecord): void {
  if (!head.needsSuccess) {
    run(state, head);
    return;
  }
  const before = predecessorOf(state, head);
  if (completed(before)) {
    run(state, head);
  } else {
    refuseOnPredecessor(state, head, before);
  }
}

/** Whether the run a `needs_success` run waits on completed, or there is none:
 *  the first run a lane holds has nothing to wait for. */
function completed(before: RunRecord | null): boolean {
  return before === null || (before.state === 'settled' && before.outcome?.state === 'completed');
}

/** The record a run's predecessor names, if the registry still holds it. */
function predecessorOf(state: RegistryState, record: RunRecord): RunRecord | null {
  return record.predecessor === null ? null : (state.records.get(record.predecessor) ?? null);
}

/** Settle a `needs_success` run whose predecessor did not complete: recorded in
 *  its audit and in the attempts ledger, then written as the refusal it is. A
 *  refusal is not `completed` either, so failure cascades down the lane. */
function refuseOnPredecessor(state: RegistryState, record: RunRecord, before: RunRecord | null): void {
  const detail = `the lane's predecessor ${before?.run ?? 'none'} did not complete: ${stateOf(before)}`;
  audit(state, record, { record: 'refused', reason: 'lane-predecessor-failed', detail });
  const held = state.live.get(record.run);
  if (held !== undefined) {
    appendAttempt(held.admitted.runDir, {
      callId: held.admitted.callId,
      reason: 'lane-predecessor-failed',
      detail,
      policyDigest: held.admitted.policyDigest,
    });
  }
  settle(state, record, refusedResult('lane-predecessor-failed', detail));
}

/** Cancel the named runs (sec-6): every mark is taken before anything is awaited,
 *  then each run's ending starts; the promise is every target's `settled`. */
function cancel(state: RegistryState, ids: string[]): Promise<void> {
  const marked = ids.map((id) => state.records.get(id)).filter(isRun);
  for (const record of marked) { record.cancelled = true; }
  for (const record of marked) { cancelEnding(state, record); }
  return waitFor(marked);
}

/** Start one marked run's ending: a running run through its ladder, a queued one
 *  settled without launching. A run that already settled is reported as it is. */
function cancelEnding(state: RegistryState, record: RunRecord): void {
  if (record.state === 'running') {
    record.controller.abort('cancelled');
  } else if (record.state === 'queued') {
    cancelQueued(state, record);
  }
}

/** Settle a queued run cancelled before it launched: the audit says so, then the
 *  one save sequence writes the cancelled result. */
function cancelQueued(state: RegistryState, record: RunRecord): void {
  audit(state, record, { record: 'cancelled' });
  settle(state, record, failedResult('cancelled', ['cancelled'], record.session, EMPTY_STATUS, record.layout));
}

/** EOF's counterpart: a queued run is dropped with a `dropped` record and an `eof`
 *  cause, so a later server reports it settled rather than lost (sec-6). */
function dropQueued(state: RegistryState, record: RunRecord): void {
  audit(state, record, { record: 'dropped' });
  settle(state, record, failedResult('eof', ['eof'], record.session, EMPTY_STATUS, record.layout));
}

/** EOF: abort every running run and drop every queued one, then resolve once
 *  nothing the registry holds is still unsettled. */
async function close(state: RegistryState): Promise<void> {
  state.closed = true;
  const all = [...state.records.values()];
  for (const record of all) {
    if (record.state === 'running') { record.controller.abort('eof'); }
  }
  for (const record of all) {
    if (record.state === 'queued') { dropQueued(state, record); }
  }
  await waitFor(all);
}

/** Acknowledge terminal runs (C3): all or nothing, so one id that cannot name a
 *  run applies none of them. Idempotent, and an acknowledged run stays addressable. */
function ack(state: RegistryState, ids: string[]): AckEntry[] {
  if (ids.some(unknownId)) { return ids.map(unacknowledged); }
  return ids.map((taskId) => ackOne(state, taskId));
}

/** One id's acknowledgement: applied only to a settled or lost record. */
function ackOne(state: RegistryState, taskId: string): AckEntry {
  const record = state.records.get(taskId);
  if (record === undefined) { return { taskId, acknowledged: false, reason: 'unknown' }; }
  if (!terminal(record)) { return { taskId, acknowledged: false, reason: 'not-settled' }; }
  record.acknowledged = true;
  return { taskId, acknowledged: true };
}

/** The runs an implicit wait targets (sec-5): read from the records, not the lane
 *  queues, so a settled run stays selectable by its lane after the queue drops it. */
function implicit(state: RegistryState, only?: string[]): RunRecord[] {
  return [...state.records.values()].filter((record) => selectable(record, only));
}

/** Resolves once every one of RUNS has settled or been lost. */
async function waitFor(runs: RunRecord[]): Promise<void> {
  await Promise.all(runs.map((record) => record.settled));
}
