// The run documents quotient emits besides the result itself (design sec-2, sec-7):
// the Task status every one carries, the handle start answers, the ack envelope, and
// the validators that hold each emitted document to its shape.
//
// `taskStatus` is the single place a quotient state becomes a Task status, so
// `tasks/get`, a handle and every wait entry agree by construction. A handle and a
// wait entry are the same run document — a Task's fields verbatim, plus quotient's
// extras in snake_case — so they share one check here, and every check follows
// `validateAgentResult`'s style: an early return naming the defect it found.
import { isRecord, isMember } from '../json.ts';
import { RUN_NAME_GRAMMAR } from './evidence.ts';
import { isAgentResult, validateAgentResult, type AgentResult, type Validation } from './result.ts';
import type { AckEntry } from './runs.ts';
import type { RunView, ViewState } from './views.ts';

/** The interval a task may be polled at (design sec-2); the task's own ttl is null. */
export const POLL_INTERVAL_MS = 2000;

/** What start's handle is (design sec-2). */
const HANDLE_SCHEMA = 'pi-run-handle/1';
/** What wait and cancel answer (design sec-2). */
export const WAIT_SCHEMA = 'pi-agent-wait/1';
/** What ack answers (design sec-2). */
const ACK_SCHEMA = 'pi-agent-ack/1';
/** The two `until` conditions a wait may name (design sec-5). */
const UNTIL = ['all', 'any'] as const;
/** The reasons an ack declines a run: not terminal here, or no record at all. */
const ACK_REASONS = ['not-settled', 'unknown'] as const;

/** The Task status a run reports: four values, no others. */
export type TaskStatus = 'working' | 'completed' | 'cancelled' | 'failed';

/** One status row of sec-2's table: the collapsed status and the message beside it. */
type TaskStatusRow = { status: TaskStatus; statusMessage: string };

/** A Task (design sec-2): the extension's field names verbatim. */
export type Task = {
  taskId: string;
  status: TaskStatus;
  statusMessage: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: null;
  pollIntervalMs: number;
};

/**
 * One run document (design sec-2): a Task, plus quotient's extras in snake_case,
 * `state` being the finer quotient state that `status` collapses.
 */
export type RunDocument = Task & {
  state: ViewState;
  lane: string | null;
  key: string | null;
  session: string | null;
  artifacts: { dir: string };
};

/** What start answers (design sec-2): a run document, marked as the handle. */
export type HandleDocument = RunDocument & { schema: typeof HANDLE_SCHEMA };

/** One run inside a wait document: a run document, a status-only flag and the
 *  result when one was asked for and is there (design sec-2). */
export type WaitEntry = RunDocument & { status_only: boolean; result: AgentResult | null };

/** What wait and cancel answer (design sec-2): the entries, and the ids that are
 *  not runs at all — reported apart because neither has a status to report. */
export type WaitDocument = {
  schema: typeof WAIT_SCHEMA;
  until: (typeof UNTIL)[number];
  timed_out: boolean;
  truncated: boolean;
  runs: WaitEntry[];
  unknown: string[];
  unreadable: string[];
};

/** What ack answers (design sec-2): one verdict per id. */
export type AckDocument = { schema: typeof ACK_SCHEMA; runs: AckEntry[] };

export type ToolResult = { content: { type: 'text'; text: string }[]; isError: boolean };

/** One `pi-agent-result/2` framed for the wire. `tools/call` always answers a tool
 *  result — a refusal is a successful call that ran nothing, never a JSON-RPC error
 *  (design sec-5) — and the document is an error unless the run completed. */
export function toolResult(document: AgentResult): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(document) }],
    isError: document.state !== 'completed',
  };
}

/**
 * A call's answer (design sec-2): a handle, a wait envelope or an ack answer is
 * never an error because of the runs inside it — `isError` is true only when the
 * call itself was refused.
 */
export function envelopeResult(document: object, refused: boolean): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(document) }], isError: refused };
}

/** Every ViewState, in sec-2's table order. */
const VIEW_STATES: readonly ViewState[] = ['queued', 'running', 'foreign', 'settled', 'lost'];

/** The two outcomes a settled run's status can come from: a cancellation, or not. */
const SETTLED_OUTCOMES: RunView['outcome'][] = [null, { state: 'cancelled', causes: ['cancelled'] }];

/**
 * Sec-2's status table, the only copy: a quotient state collapsed to the Task status
 * a tasks client reads, with the message quotient reports beside it. A cancel mark
 * never decides a status — only a queued or running run may say `cancelling`, and a
 * terminal status stays what the committed outcome says it is.
 */
export function taskStatus(view: RunView): TaskStatusRow {
  return { status: statusOf(view.state, view.outcome), statusMessage: messageOf(view) };
}

/** The status column: what STATE reports, a settled run's decided by its outcome. */
function statusOf(state: ViewState, outcome: RunView['outcome']): TaskStatus {
  switch (state) {
    case 'settled':
      return outcome?.state === 'cancelled' ? 'cancelled' : 'completed';
    case 'lost':
      return 'failed';
    case 'queued':
    case 'running':
    case 'foreign':
      return 'working';
  }
}

/** The message column. */
function messageOf(view: RunView): string {
  switch (view.state) {
    case 'queued':
      return queuedMessage(view);
    case 'running':
      return view.cancelled ? 'cancelling' : 'running';
    case 'foreign':
      return foreignMessage(view.foreignPid);
    case 'settled':
      return settledMessage(view.outcome);
    case 'lost':
      return `lost: inspect ${view.layout.dir}`;
  }
}

/** A queued run's message: the lane it waits on and the run ahead of it, unless it
 *  is already marked for cancellation. */
function queuedMessage(view: RunView): string {
  if (view.cancelled) {
    return 'cancelling';
  }
  if (view.lane === null) {
    return 'queued';
  }
  return view.predecessor === null ? `queued in lane ${view.lane}` : `queued in lane ${view.lane} behind ${view.predecessor}`;
}

/** A foreign run's message: the owning server's pid when one was recorded. */
function foreignMessage(pid: number | null): string {
  return pid === null
    ? 'owned by another quotient server'
    : `owned by another quotient server (pid ${String(pid)})`;
}

/** A settled run's message: a cancellation's causes, else the result's state. */
function settledMessage(outcome: RunView['outcome']): string {
  if (outcome === null) {
    return 'settled';
  }
  return outcome.state === 'cancelled' ? outcome.causes.join(', ') : outcome.state;
}

/** One run as a Task (design sec-2): the seven Task fields, which a created task,
 *  `tasks/get` and every run document share. */
export function taskOf(view: RunView): Task {
  const { status, statusMessage } = taskStatus(view);
  return {
    taskId: view.run,
    status,
    statusMessage,
    createdAt: view.createdAt,
    lastUpdatedAt: view.updatedAt,
    ttlMs: null,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

/** One run's document (design sec-2): the Task fields and quotient's extras, exactly. */
export function runDocument(view: RunView): RunDocument {
  return {
    ...taskOf(view),
    state: view.state,
    lane: view.lane,
    key: view.key,
    session: view.session,
    artifacts: { dir: view.layout.dir },
  };
}

/** What start answers for a run: its document, marked as the handle. */
export function handleDocument(view: RunView): HandleDocument {
  return { schema: HANDLE_SCHEMA, ...runDocument(view) };
}

/** What ack answers: one verdict per id, in request order. */
export function ackDocument(entries: AckEntry[]): AckDocument {
  return { schema: ACK_SCHEMA, runs: entries };
}

// ── Conformance ────────────────────────────────────────────────────────────

const invalid = (detail: string): Validation => ({ ok: false, detail });

/** The verdict a first defect asks for: `{ ok: true }` when there is none. */
const verdictOf = (fault: string | null): Validation => (fault === null ? { ok: true } : invalid(fault));

/** VALUE is a string or an explicit null: a run document's optional extras. */
function isTextOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

/** VALUE is a whole number above zero, which a poll interval must be. */
function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Check one handle (design sec-2): its schema, then the run document it marks. */
export function validateHandle(doc: unknown): Validation {
  if (!isRecord(doc)) {
    return invalid('a handle must be an object');
  }
  if (doc.schema !== HANDLE_SCHEMA) {
    return invalid(`schema must be ${HANDLE_SCHEMA}`);
  }
  return verdictOf(runDocumentFault(doc));
}

/** Check one wait document (design sec-2): its schema, its flags, one entry per run,
 *  and both id lists — an unknown or unreadable id is reported, never dropped. */
export function validateWait(doc: unknown): Validation {
  if (!isRecord(doc)) {
    return invalid('a wait document must be an object');
  }
  const frame = waitFrameFault(doc);
  if (frame !== null) {
    return invalid(frame);
  }
  if (!Array.isArray(doc.runs)) {
    return invalid('runs must be a list');
  }
  return verdictOf(
    firstFault(doc.runs, entryFault) ?? listFault(doc.unknown, 'unknown') ?? listFault(doc.unreadable, 'unreadable'),
  );
}

/** A wait document's frame: what it is, and how its until condition came out. */
function waitFrameFault(doc: Record<string, unknown>): string | null {
  if (doc.schema !== WAIT_SCHEMA) {
    return `schema must be ${WAIT_SCHEMA}`;
  }
  if (!isMember(UNTIL, doc.until)) {
    return `until must be one of ${UNTIL.join(', ')}`;
  }
  if (typeof doc.timed_out !== 'boolean') {
    return 'timed_out must be a boolean';
  }
  if (typeof doc.truncated !== 'boolean') {
    return 'truncated must be a boolean';
  }
  return null;
}

/** Check one ack document (design sec-2): its schema, and one well-formed verdict per
 *  run, so a malformed request is refused whole rather than half applied. */
export function validateAck(doc: unknown): Validation {
  if (!isRecord(doc)) {
    return invalid('an ack document must be an object');
  }
  if (doc.schema !== ACK_SCHEMA) {
    return invalid(`schema must be ${ACK_SCHEMA}`);
  }
  if (!Array.isArray(doc.runs)) {
    return invalid('runs must be a list');
  }
  return verdictOf(firstFault(doc.runs, ackEntryFault));
}

/** The first defect in a run document, or null: what a handle and every wait entry
 *  are held to. */
function runDocumentFault(doc: unknown): string | null {
  return isRecord(doc) ? fieldsFault(doc) : 'a run document must be an object';
}

/** The first defect in a run document's fields, or null. */
function fieldsFault(doc: Record<string, unknown>): string | null {
  return identityFault(doc) ?? timeFault(doc) ?? extrasFault(doc);
}

/** A run document's identity: the handle it names, the state it is in and a status
 *  that state allows (design sec-2's table). */
function identityFault(doc: Record<string, unknown>): string | null {
  if (typeof doc.taskId !== 'string' || !RUN_NAME_GRAMMAR.test(doc.taskId)) {
    return 'taskId must be a run handle';
  }
  if (!isMember(VIEW_STATES, doc.state)) {
    return `state is not a quotient state: ${String(doc.state)}`;
  }
  if (!isMember(statusesOf(doc.state), doc.status)) {
    return `a ${doc.state} run does not report status ${String(doc.status)}`;
  }
  return null;
}

/** The statuses STATE may report, by the one table: a settled run's depends on an
 *  outcome a run document does not carry, so it may report either. */
function statusesOf(state: ViewState): TaskStatus[] {
  return state === 'settled' ? SETTLED_OUTCOMES.map((outcome) => statusOf(state, outcome)) : [statusOf(state, null)];
}

/** A run document's times: stamped text, no ttl, and a poll interval above zero. */
function timeFault(doc: Record<string, unknown>): string | null {
  if (typeof doc.createdAt !== 'string') {
    return 'createdAt must be a timestamp';
  }
  if (typeof doc.lastUpdatedAt !== 'string') {
    return 'lastUpdatedAt must be a timestamp';
  }
  if (doc.ttlMs !== null) {
    return 'ttlMs must be null: the result lives as long as its evidence';
  }
  if (!isPositiveInteger(doc.pollIntervalMs)) {
    return 'pollIntervalMs must be a positive integer';
  }
  return null;
}

/** A run document's quotient extras: the message, the run's lane, key and session,
 *  and the directory its artifacts sit in. */
function extrasFault(doc: Record<string, unknown>): string | null {
  if (typeof doc.statusMessage !== 'string') {
    return 'statusMessage must be a string';
  }
  for (const field of ['lane', 'key', 'session'] as const) {
    if (!isTextOrNull(doc[field])) {
      return `${field} must be a string or null`;
    }
  }
  const artifacts = doc.artifacts;
  if (!isRecord(artifacts) || typeof artifacts.dir !== 'string') {
    return 'artifacts must name the run directory';
  }
  return null;
}

/** The first defect CHECK finds among ITEMS, or null. */
function firstFault(items: unknown[], check: (item: unknown) => string | null): string | null {
  for (const item of items) {
    const fault = check(item);
    if (fault !== null) {
      return fault;
    }
  }
  return null;
}

/** One wait entry: a run document, plus the result arm hanging off it. */
function entryFault(entry: unknown): string | null {
  if (!isRecord(entry)) {
    return 'a wait entry must be a run document';
  }
  return fieldsFault(entry) ?? armFault(entry);
}

/** One wait entry's result arm (design sec-2): a valid `pi-agent-result/2` exactly
 *  when results were asked for and the entry is settled, and null otherwise. */
function armFault(entry: Record<string, unknown>): string | null {
  if (typeof entry.status_only !== 'boolean') {
    return 'status_only must be a boolean';
  }
  const result = entry.result;
  if (entry.status_only) {
    return result === null ? null : 'a status-only entry carries no result';
  }
  if (result === null) {
    return 'an entry that is not status-only carries its result';
  }
  if (!isAgentResult(result)) {
    const verdict = validateAgentResult(result);
    return `result: ${verdict.ok ? 'not a pi-agent-result/2' : verdict.detail}`;
  }
  return entry.state === 'settled' ? agreementFault(entry, result) : 'only a settled entry carries a result';
}

/** A settled entry's status and message are its result's, by the one table. */
function agreementFault(entry: Record<string, unknown>, result: AgentResult): string | null {
  const status = statusOf('settled', result);
  const message = settledMessage(result);
  return entry.status === status && entry.statusMessage === message
    ? null
    : `a settled entry must report its result: ${status} (${message})`;
}

/** One of a wait document's id lists: required, and every id names a run. */
function listFault(list: unknown, name: string): string | null {
  if (!Array.isArray(list)) {
    return `${name} must be a list of run handles`;
  }
  return firstFault(list, (id) =>
    typeof id === 'string' && RUN_NAME_GRAMMAR.test(id) ? null : `${name} carries an id that names no run`,
  );
}

/** One ack verdict: an acknowledged run carries no reason; a declined one names one. */
function ackEntryFault(entry: unknown): string | null {
  if (!isRecord(entry)) {
    return 'an ack entry must be an object';
  }
  // Not grammar-checked: runs.ts answers `unknown` for every id when any is malformed.
  if (typeof entry.taskId !== 'string' || entry.taskId.length === 0) {
    return 'taskId must name a run';
  }
  if (entry.acknowledged === true) {
    return entry.reason === undefined ? null : 'an acknowledged run carries no reason';
  }
  if (entry.acknowledged !== false) {
    return 'acknowledged must be a boolean';
  }
  return isMember(ACK_REASONS, entry.reason) ? null : `reason must be one of ${ACK_REASONS.join(', ')}`;
}
