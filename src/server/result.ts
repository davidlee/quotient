// The `pi-agent-result/1` envelope — the one payload every `tools/call` answers
// with, refusal and failure alike. Design sec-5 is the contract; this module owns
// the document's shape and its constructors, and decides nothing about a run.
//
// PHASE-08 extends this file with the cause precedence, the abort latch and the
// success predicate. Nothing here reads a stream, spawns a process or claims a
// verdict beyond the two arms PHASE-02 can reach: a refusal (nothing ran) and a
// pre-spawn failure.

export const RESULT_SCHEMA = 'pi-agent-result/1';

/** sec-5's state vocabulary. */
export type ResultState =
  | 'completed'
  | 'failed'
  | 'incomplete'
  | 'timeout'
  | 'cancelled'
  | 'ceiling_exceeded'
  | 'accounting_unknown'
  | 'audit_failed'
  | 'refused';

/** sec-5's termination/cause vocabulary: one spelling, so the wire and the
 *  matcher cannot disagree. */
export type Termination =
  | 'stop'
  | 'length'
  | 'error'
  | 'aborted'
  | 'toolUse'
  | 'deferred'
  | 'eof'
  | 'exit'
  | 'spawn'
  | 'timeout'
  | 'cancelled'
  | 'switch'
  | 'ceiling'
  | 'accounting'
  | 'audit'
  | 'refused';

/** Where a spawned run's evidence lives. Null until a run directory exists. */
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
  /** Always present for a run; null when no session was minted (a refusal). */
  session: string | null;
  final: boolean;
  truncated: boolean;
  result: string | null;
  transcript: string;
  /** `pi-run-status/2`, embedded verbatim from pi/reduce once a run exists. */
  status: Record<string, unknown> | null;
  artifacts: Artifacts | null;
  /** Present only for a refusal: nothing ran, and this says why. */
  refusal: { reason: string; detail: string } | null;
};

/** The refusal arm: nothing ran, so status, artifacts and result are null. */
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
 * The failure arm: a pre-spawn process failure, or (PHASE-06 on) a run that
 * failed. `causes[0]` is the termination, per sec-5's precedence rule.
 *
 * The caller-facing explanation travels in `transcript`: a non-refused result has
 * no `refusal` slot, and sec-5 gives it no other text field. PHASE-06 replaces it
 * with the run's own transcript.
 */
export function failedResult(termination: Termination, causes: Termination[], detail: string): AgentResult {
  return {
    schema: RESULT_SCHEMA,
    state: 'failed',
    termination,
    causes,
    session: null,
    final: false,
    truncated: false,
    result: null,
    transcript: detail,
    status: null,
    artifacts: null,
    refusal: null,
  };
}
