// The `pi-agent-result/2` envelope — the one payload every `tools/call` answers
// with, refusal and failure alike — and the state/cause semantics over it.
//
// Design sec-5 is the contract and DEC-093's table is normative here: this module
// owns the two vocabularies, the cause → state table, the success predicate, the
// abort latch and its commit point, the refusal arm and the enum-reachability
// claim. It reads no stream, spawns nothing and appends no
// evidence: the reducer supplies the stream-side facts, the spawn supplies the
// child's, and `resultFor` is the ONLY place a verdict is derived (EX-8).
import type { Reduced } from '../reduce/reduce.ts';
import { isRecord } from '../json.ts';

export const RESULT_SCHEMA = 'pi-agent-result/2';

/**
 * sec-5's state vocabulary: the reducer's three stream verdicts (`completed`,
 * `failed`, `incomplete`) unioned with the server's own. `status.state` judges the
 * stream and `state` judges the call; they diverge only where the deciding cause
 * arose outside the stream, and `causes` names it (EX-5).
 */
export const RESULT_STATES = [
  'completed',
  'failed',
  'incomplete',
  'timeout',
  'cancelled',
  'ceiling_exceeded',
  'accounting_unknown',
  'audit_failed',
  'refused',
] as const;
export type ResultState = (typeof RESULT_STATES)[number];

/**
 * sec-5's termination/cause vocabulary — ONE enum for both fields, so the wire and
 * a matcher cannot disagree. Model reasons are pi's stop reasons verbatim
 * (`stop|length|error|aborted|toolUse|deferred`; never `tool_use`), and every other
 * token names an outcome rather than the mechanism that produced it: the wall-clock
 * backstop's cause is `timeout`, and `backstop` is prose, not a token (RV-046 F-6).
 */
export const TERMINATIONS = [
  'stop',
  'length',
  'error',
  'aborted',
  'toolUse',
  'deferred',
  'eof',
  'exit',
  'spawn',
  'timeout',
  'cancelled',
  'switch',
  'ceiling',
  'accounting',
  'audit',
  'refused',
] as const;
export type Termination = (typeof TERMINATIONS)[number];

/**
 * DEC-093's table: one cause, one state. `causes[0]` is the reported cause and its
 * row is the state, so the two fields cannot tell different stories.
 *
 * `stop` and `length` reach `completed` only through the success predicate: the
 * latch's vocabulary (`LatchCause`) excludes them, and the derived path returns one
 * only when the predicate held. `refused` is likewise an arm, not a latch entry.
 */
export const CAUSE_STATE: Record<Termination, ResultState> = {
  stop: 'completed',
  length: 'completed',
  error: 'failed',
  aborted: 'failed',
  toolUse: 'incomplete',
  deferred: 'incomplete',
  eof: 'incomplete',
  exit: 'failed',
  spawn: 'failed',
  timeout: 'timeout',
  cancelled: 'cancelled',
  switch: 'cancelled',
  ceiling: 'ceiling_exceeded',
  accounting: 'accounting_unknown',
  audit: 'audit_failed',
  refused: 'refused',
};

/**
 * The refusal reasons this module declares valid (EX-3): a refusal token, or a
 * failure to record one. Steps 1-8 own the tokens they raise (`disabled`,
 * `profile-invalid`, `session-busy`, …) and name them where they are raised;
 * `server-error` is the outer `tools/call` catch's, for a throw that landed before
 * any run was established. `lane-predecessor-failed` is a laned run settled at
 * launch because the run before it in its lane did not complete.
 */
export const RESULT_REFUSAL_REASONS = [
  'request-invalid',
  'audit-failed',
  'audit-unavailable',
  'server-error',
  'lane-predecessor-failed',
] as const;

/** Where a spawned run's evidence lives. Null for a refusal: nothing ran. */
export type Artifacts = {
  dir: string;
  events: string;
  transcript: string;
  status: string;
  audit: string;
};

export type AgentResult = {
  schema: typeof RESULT_SCHEMA;
  state: ResultState;
  termination: Termination;
  /** The reported cause first; the whole ordered list is always returned. */
  causes: Termination[];
  /** Always present for a spawned run; null when no session was minted (a refusal). */
  session: string | null;
  final: boolean;
  truncated: boolean;
  result: string | null;
  transcript: string;
  /** `pi-run-status/3`, embedded verbatim from pi/reduce once a run exists. */
  status: Record<string, unknown> | null;
  artifacts: Artifacts | null;
  /** Present only for a refusal: nothing ran, and this says why. */
  refusal: { reason: string; detail: string } | null;
};

// ── The latch ──────────────────────────────────────────────────────────────

/**
 * The latch's vocabulary: the causes the server discovers while a run is in flight,
 * which is every token except the three that are not discoveries. `stop`/`length` are
 * the success predicate's *conclusion*, never an input — a caller that hands one over
 * is asking for `completed` without the predicate — and `refused` is an arm
 * (`refusedResult`), not a run.
 */
export type LatchCause = Exclude<Termination, 'stop' | 'length' | 'refused'>;

/** The runtime half of `LatchCause`. A type does not survive a cast, so `resultFor`
 *  drops any cause the latch could not have recorded. */
function isLatchCause(cause: unknown): cause is LatchCause {
  return (
    (TERMINATIONS as readonly string[]).includes(cause as string) && cause !== 'stop' && cause !== 'length' && cause !== 'refused'
  );
}

export type Latch = {
  /** Record a cause at the point it is discovered. Recording a cause that is
   *  already latched is a no-op: the same failure seen by two paths is one cause
   *  (the ladder records an evidence failure as its cause, and the append reports
   *  the same failure). */
  record(cause: LatchCause): void;
  /** The commit point: the ordered snapshot, after which nothing may change it.
   *  A record after this point is ignored — the result is immutable and its return
   *  is the last step of the call, so there is no later reader to surprise. */
  commit(): LatchCause[];
};

/**
 * The abort latch. `completed` is provisional until the commit point — after the
 * ladder, the reap, the stream drain, the final accounting and the `exit`/abort
 * evidence appends — so no ordering reports success while the reason the run
 * stopped was an accounting or audit failure (DEC-093, EX-2).
 */
export function createLatch(): Latch {
  const causes: LatchCause[] = [];
  let committed: LatchCause[] | null = null;
  return {
    record(cause: LatchCause): void {
      if (committed !== null) {return;}
      if (!causes.includes(cause)) {causes.push(cause);}
    },
    commit(): LatchCause[] {
      committed ??= [...causes];
      return committed;
    },
  };
}

// ── The builder ────────────────────────────────────────────────────────────

/**
 * What the spawn reports about the child: facts, never a verdict (`RunOutcome` in
 * `pi/mcp/spawn.ts` satisfies this shape).
 */
export type RunFacts = {
  /** The child's exit status; `null` when it never exited at all. */
  exitCode: number | null;
  /** The launcher could not be executed: nothing ran, though the run directory
   *  exists (a pre-spawn process failure, not a refusal). */
  spawnFailed: boolean;
  /** The run's evidence, mapped straight into `artifacts`. */
  layout: Artifacts;
};

export type ResultInput = {
  /** The stream, reduced by `pi/reduce/reduce.ts` — the only source of the
   *  stream-side facts the verdict is built from. */
  reduced: Reduced;
  /** The child's own facts. */
  outcome: RunFacts;
  /** The latch's committed snapshot (its vocabulary is `LatchCause`): every cause
   *  the server discovered, in discovery order. The audit arm is one of them,
   *  recorded where `!wrote` or the run's own audit append failed; there is no
   *  second writer of `audit`. */
  causes: LatchCause[];
  /** The id this call minted or named. A run always has one. */
  session: string;
};

/**
 * DEC-093's success predicate: the whole of `completed`, in one place. An
 * answer-bearing terminal message, `agent_settled` observed, child exit 0, and
 * known cost accounting. Context measurement gaps are disclosed but do not
 * independently change completion. Exit 0 alone is never evidence of success — json mode exits 0
 * on a model error — and a valid answer with a nonzero exit is `failed`.
 */
function succeeded(reduced: Reduced, outcome: RunFacts): boolean {
  const reason = reduced.terminalReason;
  return (
    (reason === 'stop' || reason === 'length') &&
    reduced.settled &&
    outcome.exitCode === 0 &&
    reduced.accounting === 'known'
  );
}

/**
 * The cause when the latch is empty: what the stream and the child already say.
 * `spawn` first, because nothing ran; `exit` covers `null` and nonzero alike;
 * then accounting; then the stream's terminal reason; then `eof` — which is also
 * what a `pending` message, a reason pi adds later, and an unsettled stream leave.
 */
function derivedCause(reduced: Reduced, outcome: RunFacts): Termination {
  if (outcome.spawnFailed) {return 'spawn';}
  if (succeeded(reduced, outcome)) {return reduced.terminalReason as Termination;}
  if (outcome.exitCode !== 0) {return 'exit';}
  if (reduced.accounting !== 'known') {return 'accounting';}
  const reason = reduced.terminalReason;
  if (reason === 'error' || reason === 'aborted' || reason === 'toolUse' || reason === 'deferred') {return reason;}
  return 'eof';
}

/**
 * The one builder for a spawned run: precedence, `final`, the withheld `result`,
 * `truncated`, the transcript, `status` verbatim and the artifacts map.
 *
 * `termination` is always `causes[0]`; when no latch cause survives the filter the
 * derived cause is the list. Everything the reducer said travels unchanged:
 * `truncated` in every arm, `status` by reference — the call's verdict never
 * rebuilds the stream's.
 *
 * The invariant: a latched list can never produce `completed`. The filter is the
 * runtime half of `LatchCause` (a type does not survive a cast), so an answering
 * reason handed in as a cause is dropped and the stream decides; `succeeded()`
 * inside `derivedCause` is the only door to `completed` and to `final: true`.
 */
export function resultFor(input: ResultInput): AgentResult {
  const { reduced, outcome, session } = input;
  const latched = input.causes.filter(isLatchCause);
  const causes: Termination[] = latched.length > 0 ? [...latched] : [derivedCause(reduced, outcome)];
  const termination = causes[0];
  const state = CAUSE_STATE[termination];
  // `completed` is reachable only through the predicate: no latch cause maps to it,
  // and the answering reasons reach the table through `succeeded()` alone.
  const final = state === 'completed';
  return {
    schema: RESULT_SCHEMA,
    state,
    termination,
    causes,
    session,
    final,
    truncated: reduced.truncated,
    result: final ? reduced.result : null,
    transcript: reduced.transcript,
    status: reduced.status,
    artifacts: {
      dir: outcome.layout.dir,
      events: outcome.layout.events,
      transcript: outcome.layout.transcript,
      status: outcome.layout.status,
      audit: outcome.layout.audit,
    },
    refusal: null,
  };
}

/** The refusal arm: nothing ran, so status, artifacts, result and session are null. */
export function refusedResult(reason: string, detail: string): AgentResult {
  return {
    schema: RESULT_SCHEMA,
    state: 'refused',
    termination: 'refused',
    causes: ['refused'],
    session: null,
    final: false,
    truncated: false,
    result: null,
    transcript: '',
    status: null,
    artifacts: null,
    refusal: { reason, detail },
  };
}

/**
 * The failure arm for a call the server itself could not finish after the run was
 * established: the session and the run directory exist, so the envelope is a
 * conforming `failed` one rather than a verdict derived from a stream. `state` is
 * the row of the cause that ended the call.
 *
 * The stream was never read, so `transcript` is empty: the diagnostic detail is
 * not reduced markdown and belongs to the diagnostics sink, not to the envelope.
 * The status handed in is the honest verdict on an unread stream. A throw that
 * landed before anything ran is a refusal — `refusedResult('server-error', …)` —
 * not this arm.
 */
export function failedResult(
  termination: Termination,
  causes: Termination[],
  session: string,
  status: Record<string, unknown>,
  layout: Artifacts,
): AgentResult {
  return {
    schema: RESULT_SCHEMA,
    state: CAUSE_STATE[termination],
    termination,
    causes,
    session,
    final: false,
    truncated: false,
    result: null,
    transcript: '',
    status,
    artifacts: {
      dir: layout.dir,
      events: layout.events,
      transcript: layout.transcript,
      status: layout.status,
      audit: layout.audit,
    },
    refusal: null,
  };
}

// ── Conformance ────────────────────────────────────────────────────────────

export type Validation = { ok: true } | { ok: false; detail: string };

const invalid = (detail: string): Validation => ({ ok: false, detail });

/**
 * Check a document against design sec-5's shape and DEC-093's precedence rule, in
 * the vocabularies above as the single source of truth. A cause token outside the
 * enum, a `termination` that is not `causes[0]`, a state that is not that cause's
 * row, and an arm that leaks across the refusal boundary are all defects a suite
 * catches here rather than a reader discovering on the wire.
 */
export function validateAgentResult(doc: unknown): Validation {
  if (!isRecord(doc)) {return invalid('the result must be an object');}
  if (doc.schema !== RESULT_SCHEMA) {return invalid(`schema must be ${RESULT_SCHEMA}`);}
  if (!RESULT_STATES.includes(doc.state as ResultState)) {return invalid(`state is not a member of the state enum: ${String(doc.state)}`);}
  if (!TERMINATIONS.includes(doc.termination as Termination)) {
    return invalid(`termination is not a cause token: ${String(doc.termination)}`);
  }
  const causes = doc.causes;
  if (!Array.isArray(causes) || causes.length === 0) {return invalid('causes must be a non-empty list');}
  for (const cause of causes) {
    if (!TERMINATIONS.includes(cause as Termination)) {return invalid(`a cause is not a cause token: ${String(cause)}`);}
  }
  const state = doc.state as ResultState;
  const termination = doc.termination as Termination;
  if (causes[0] !== termination) {return invalid('causes[0] must be the reported termination');}
  if (CAUSE_STATE[termination] !== state) {return invalid(`state ${state} is not the row of cause ${termination}`);}
  if (typeof doc.final !== 'boolean') {return invalid('final must be a boolean');}
  if (typeof doc.truncated !== 'boolean') {return invalid('truncated must be a boolean');}
  if (typeof doc.transcript !== 'string') {return invalid('transcript must be a string');}
  if (doc.result !== null && typeof doc.result !== 'string') {return invalid('result must be a string or null');}

  if (state === 'refused') {
    if (doc.session !== null) {return invalid('a refusal minted no session');}
    if (doc.status !== null) {return invalid('a refusal has no status: nothing ran');}
    if (doc.artifacts !== null) {return invalid('a refusal has no artifacts: nothing ran');}
    if (doc.result !== null) {return invalid('a refusal carries no result');}
    const refusal = doc.refusal;
    if (!isRecord(refusal)) {return invalid('a refusal must carry refusal { reason, detail }');}
    if (typeof refusal.reason !== 'string' || refusal.reason.length === 0) {return invalid('refusal.reason must name the refusal');}
    if (typeof refusal.detail !== 'string') {return invalid('refusal.detail must be a string');}
    return { ok: true };
  }

  if (doc.refusal !== null) {return invalid('only a refusal carries refusal');}
  if (typeof doc.session !== 'string' || doc.session.length === 0) {return invalid('a spawned run carries its session');}
  if (!isRecord(doc.status)) {return invalid('a spawned run carries its status');}
  if (!isRecord(doc.artifacts)) {return invalid('a spawned run carries its artifacts');}
  for (const field of ['dir', 'events', 'transcript', 'status', 'audit'] as const) {
    if (typeof doc.artifacts[field] !== 'string') {return invalid(`artifacts.${field} must be a path`);}
  }
  // DEC-093 withdraws exactly `result` and `final` on a non-completed run.
  if (state === 'completed' && !doc.final) {return invalid('a completed run is final');}
  if (state !== 'completed' && doc.final) {return invalid('only a completed run is final');}
  if (state !== 'completed' && doc.result !== null) {return invalid('only a completed run carries a result');}
  return { ok: true };
}

/**
 * VALUE is a `pi-agent-result/2` document: `validateAgentResult` is the one
 * conformance check, so a reader and a writer cannot disagree about the shape.
 */
export function isAgentResult(value: unknown): value is AgentResult {
  return validateAgentResult(value).ok;
}

// ── Reachability (EX-9) ────────────────────────────────────────────────────

/** Whether this build produces the member, and by which path — or why it does not. */
export type Reachability = { producedBy: string } | { unreachable: string };

/**
 * Every member of both enums, each with the path that produces it in this build or
 * an explicit statement that it is unreachable. A member with neither is the silent
 * hole RV-043 F-12 raised; the table test asserts the hole list is empty, so
 * "unreachable" is always a stated choice.
 */
export const REACHABILITY: {
  states: Record<ResultState, Reachability>;
  terminations: Record<Termination, Reachability>;
} = {
  states: {
    completed: { producedBy: 'resultFor: an answering terminal message with agent_settled, exit 0 and known cost accounting' },
    failed: { producedBy: 'resultFor: an `error`/`aborted` terminal reason, a nonzero (or absent) exit, or a failed spawn' },
    incomplete: { producedBy: 'resultFor: `toolUse`/`deferred`, or a stream that ended without a terminal answer or without settling' },
    timeout: { producedBy: 'resultFor: the wall-clock backstop aborted the run with cause `timeout`' },
    cancelled: { producedBy: 'resultFor: a cancellation notification (`cancelled`), or the switch (`switch`); a queued run cancelled before it launched, with no process' },
    ceiling_exceeded: { producedBy: 'resultFor: the gate measured a ceiling crossing and aborted with cause `ceiling`' },
    accounting_unknown: { producedBy: 'resultFor: an ordinary response or compaction result with absent or invalid cost (cause `accounting`)' },
    audit_failed: { producedBy: 'resultFor: an evidence append failed on a run that spawned (cause `audit`)' },
    refused: { producedBy: 'refusedResult: nothing spawned (steps 1-8, a pre-spawn audit failure, an unallocatable run directory), or a run settled at launch (re-admission, a failed lane predecessor)' },
  },
  terminations: {
    stop: { producedBy: 'the terminal assistant message stopped for `stop` and the success predicate held' },
    length: { producedBy: 'the terminal assistant message stopped for `length` and the success predicate held' },
    error: { producedBy: 'the terminal assistant message stopped for `error`' },
    aborted: { producedBy: 'the terminal assistant message stopped for `aborted`' },
    toolUse: { producedBy: 'the terminal assistant message stopped for `toolUse`: paid for, not an answer' },
    deferred: { producedBy: 'the terminal assistant message stopped for `deferred`: paid for, not an answer' },
    eof: { producedBy: 'the stream ended with no answer-bearing terminal message, `pending`, or without settling; or the client went away (stdin EOF, SIGTERM, SIGINT) and the run was aborted, with no result written; or a queued run settled at shutdown without a process' },
    exit: { producedBy: 'the child exited nonzero, or never exited at all' },
    spawn: { producedBy: 'the launch form could not be executed: nothing ran' },
    timeout: { producedBy: 'the gate\'s wall-clock backstop aborted the run' },
    cancelled: { producedBy: 'a cancellation notification aborted the run, or a queued run was cancelled without a process' },
    switch: { producedBy: 'the gate re-read the policy switch (or lost its source) and aborted the run' },
    ceiling: { producedBy: 'the gate measured a requests/context_tokens/cost crossing and aborted the run' },
    accounting: { producedBy: 'an ordinary response or compaction result with absent or invalid cost marked accounting unknown' },
    audit: { producedBy: 'an evidence append failed on a run that spawned' },
    refused: { producedBy: 'refusedResult: the call ran nothing, or a run was settled at launch' },
  },
};
