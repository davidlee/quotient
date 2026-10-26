# `pi-agent-result/2`

The document every `pi_agent` call answers with. Normative: a change that
breaks it mints `pi-agent-result/2`, and this contract stays alongside.

## The envelope

A `tools/call` of `pi_agent` always answers with an MCP tool result: one `text`
content item whose text is this JSON document. `isError` is `false` exactly
when `state` is `completed`.

- **A refusal is a successful MCP call that ran nothing.** It is a tool result
  with `state: "refused"`, never a JSON-RPC error. The same holds for a run that
  failed: the protocol layer reports only protocol faults (an unknown method, an
  unparsable line), never a verdict about a delegate.
- **One verdict.** `state` judges the call; `status.state` judges the stream
  alone. They differ only when the deciding cause arose outside the stream (a
  timeout, a cancellation, a ceiling, a failed audit), and `causes` names it.
- **`termination` is always `causes[0]`**, and `state` is that cause's row in
  the termination table below. `causes` is the whole ordered list, earliest
  discovery first; a later cause is never hidden behind an earlier one.
- **`final` is `true` exactly when `state` is `completed`.** Then, and only then,
  `result` may carry the delegate's answer. Trust `result` only when `final` is
  true.
- **`completed` is one predicate:** the last assistant message stopped for
  `stop` or `length`, the stream reported `agent_settled`, the child exited 0,
  and cost accounting permits success. Context-measurement completeness is
  independent and is not a success condition. Exit 0 alone is never success.
- When the client goes away (stdin EOF, or the server receives SIGTERM or
  SIGINT), every in-flight run is aborted with cause `eof`, and no result is
  written: there is nobody to read it.

## Fields

`<path>.<key>` is an object's member and `<path>[]` an array's element. Every
key listed is always present; `nullable` says whether its value may be `null`.

| path | type | nullable | meaning |
|---|---|---|---|
| `schema` | string | no | `"pi-agent-result/2"` |
| `state` | string | no | the call's verdict: a token of the States table |
| `termination` | string | no | the reported cause: a token of the Terminations table, equal to `causes[0]` |
| `causes` | array | no | every cause, in discovery order; never empty |
| `causes[]` | string | no | a token of the Terminations table |
| `session` | string | yes | the session this call minted or continued; pass it back as `session` to continue. `null` for a refusal |
| `final` | boolean | no | `true` exactly when `state` is `completed` |
| `truncated` | boolean | no | the transcript was cut to the transcript budget |
| `result` | string | yes | the last assistant message's text; `null` unless `final` is `true` and that message had text |
| `transcript` | string | no | the reduced transcript, as markdown; empty for a refusal |
| `status` | object | yes | the reducer's `pi-run-status/3` for the run's stream; `null` for a refusal |
| `status.schema` | string | no | `"pi-run-status/3"` |
| `status.state` | string | no | the stream's verdict: `completed`, `failed` or `incomplete` |
| `status.turns` | number | no | assistant turns |
| `status.tool_calls` | number | no | tool calls the delegate made |
| `status.requests` | number | no | provider requests, measured or not |
| `status.requests_unmeasured` | number | no | legacy count of requests in the existing accounting-gap increment set; see Usage counters |
| `status.tokens` | object | no | measured token usage |
| `status.tokens.input` | number | no | input tokens |
| `status.tokens.output` | number | no | output tokens |
| `status.tokens.cached` | number | no | cache-read tokens |
| `status.tokens.cache_write` | number | no | cache-write tokens |
| `status.context` | object | no | per-request context measurement summary |
| `status.context.peak_tokens` | number | yes | largest measured request footprint; `null` when no context footprint was measured |
| `status.context.requests_unmeasured` | number | no | counted requests without a valid context footprint; see Usage counters |
| `status.cost_usd` | number | yes | the sum of observed provider costs, in US dollars; `null` when none was observed |
| `status.accounting` | string | no | `known`, or `unknown` when an ordinary response or compaction result had missing or invalid cost |
| `status.session_id` | string | yes | pi's session id, from the stream |
| `status.cwd` | string | yes | the delegate's working directory, from the stream |
| `status.model` | string | yes | the model, from the stream |
| `status.last_stop_reason` | string | yes | the last assistant message's stop reason, verbatim |
| `status.alerts` | array | no | the reducer's alert matches, in stream order. The server sets no alert patterns, so it answers `[]`; the element shape is the reducer's |
| `status.alerts[]` | object | no | one match |
| `status.alerts[].pattern` | string | no | the pattern that matched |
| `status.alerts[].text` | string | no | a snippet of the matching text |
| `status.transcript` | object | no | what the reducer read and kept |
| `status.transcript.bytes` | number | no | bytes of transcript returned |
| `status.transcript.records` | number | no | JSON objects read from the stream |
| `status.transcript.malformed` | number | no | lines that were not a JSON object |
| `status.transcript.elided` | number | no | transcript entries cut by the budget |
| `artifacts` | object | yes | where this run's evidence lives; `null` for a refusal |
| `artifacts.dir` | string | no | the run directory |
| `artifacts.events` | string | no | the raw event stream, `events.jsonl` |
| `artifacts.transcript` | string | no | the full reduced transcript, `transcript.md` |
| `artifacts.status` | string | no | `status.json` |
| `artifacts.audit` | string | no | the run's audit log, `audit.jsonl` |
| `refusal` | object | yes | why nothing ran; `null` unless `state` is `refused` |
| `refusal.reason` | string | no | a token of the Refusals table |
| `refusal.detail` | string | no | prose naming what failed, for an operator |

## Usage counters and accounting

The request stream is classified once by the reducer. Each assistant
`message_end` is one request. A `compaction_end` counts only if it carries a
result object; `summarization_retry_scheduled` counts as a request without
usage. Partial updates, `agent_end` replays, non-assistant messages and
result-less compaction events do not count as requests.

For each counted request with valid normalized token components, the context
footprint is `input + output + cached + cache_write`. All four components and
the sum must be finite, non-negative numbers. Reasoning and cache-write detail
fields are subsets and are not added again. `context.peak_tokens` is the maximum
observed footprint, never a cumulative total. It is `null` when no valid
footprint has been observed. If `context.requests_unmeasured` is positive, the
peak is only a lower bound on the run's actual maximum.

For a successful assistant response or compaction result, a complete all-zero
vector is a measured zero. For a failed or aborted assistant message, absent or
all-zero usage is treated as an unmeasured placeholder; a complete vector with
positive token evidence is measured and contributes to the context peak.

The two unmeasured counters have different populations and may overlap:

- `status.requests_unmeasured` retains the legacy accounting-gap count. It
  increments once for each failed or aborted assistant send whose cost usage is
  absent, invalid or placeholder, and once for each
  `summarization_retry_scheduled` record. An ordinary assistant response or
  compaction result with missing or invalid cost makes accounting unknown but
  does not increment this legacy counter.
- `status.context.requests_unmeasured` increments once for every counted
  request that lacks a valid context footprint, including a missing vector, an
  invalid component or an overflowing sum.

These counts are not a partition and must not be added to infer a total.
Either may exceed the other. A failed send with valid positive token evidence
but no cost can increment only the legacy counter; an ordinary response with
valid cost but missing tokens can increment only the context counter. A request
may increment both.

`status.accounting` describes cost validity, not context completeness. `known`
means no disallowed cost-observation failure occurred; tolerated failed-send
and retry gaps remain disclosed by the legacy counter. Missing or invalid
context alone does not make accounting unknown and does not stop an otherwise
successful final answer. Conversely, a valid context footprint with missing or
invalid cost on an ordinary response can still make accounting unknown.

Cumulative `status.tokens` totals remain separate accounting totals. Complete
valid token vectors accumulate for ordinary assistant responses and
compaction results whether or not cost is valid. Failed or aborted assistant
sends remain excluded from cumulative token totals, although valid positive
usage from them still contributes to the context peak. Missing components are
never inferred from provider `totalTokens`.

The context peak starts afresh for each quotient call, including a call that
continues a pi session. Whether an installed pi version replays historical
assistant messages as new `message_end` events on resume is a separate runtime
question; this contract and fixture tests do not establish that behavior.

## States

| state | meaning |
|---|---|
| `completed` | the success predicate held: trust `result` |
| `failed` | the model errored or aborted, the child exited nonzero, or the launch failed |
| `incomplete` | the run ended without an answer: it stopped to use a tool, deferred, or the stream ended or was cut off before settling |
| `timeout` | the wall-clock backstop stopped the run |
| `cancelled` | a cancellation notification, or the operator switch, stopped the run |
| `ceiling_exceeded` | a request-count, context-token or cost ceiling was crossed |
| `accounting_unknown` | an ordinary request had missing or invalid cost, so the cost ceiling could not be enforced |
| `audit_failed` | an evidence append failed on a run that had started |
| `refused` | nothing ran: see `refusal` |

## Terminations

One token vocabulary serves `termination` and `causes`. The model's stop
reasons are pi's tokens, verbatim (`toolUse`, never `tool_use`).

| termination | state | produced by |
|---|---|---|
| `stop` | `completed` | the last assistant message stopped for `stop` and the success predicate held |
| `length` | `completed` | the last assistant message stopped for `length` and the success predicate held |
| `error` | `failed` | the last assistant message stopped for `error`, or the server failed after the run started |
| `aborted` | `failed` | the last assistant message stopped for `aborted` |
| `toolUse` | `incomplete` | the last assistant message stopped to use a tool: paid for, not an answer |
| `deferred` | `incomplete` | the last assistant message deferred: paid for, not an answer |
| `eof` | `incomplete` | the stream ended with no answer-bearing message or without settling; or the client went away and the run was aborted |
| `exit` | `failed` | the child exited nonzero, or never exited |
| `spawn` | `failed` | the launch form could not be executed: nothing ran |
| `timeout` | `timeout` | the wall-clock backstop aborted the run |
| `cancelled` | `cancelled` | a cancellation notification aborted the run |
| `switch` | `cancelled` | the policy's `enabled` was off, or unreadable, at a gate tick |
| `ceiling` | `ceiling_exceeded` | the gate measured a request-count, context-token or cost crossing |
| `accounting` | `accounting_unknown` | an ordinary response or compaction result had missing or invalid cost |
| `audit` | `audit_failed` | an evidence append failed on a run that had started |
| `refused` | `refused` | the call was refused: nothing ran |

## Refusals

A refusal names the first check that failed, in validation order: checks run
in the order below, and the first failure wins. The request shape is checked
before step 1.

| reason | raised at | meaning |
|---|---|---|
| `request-invalid` | request shape | the arguments are not a well-formed `pi_agent` call |
| `policy-unavailable` | step 1 | a location variable is unusable, or the policy file cannot be read |
| `policy-invalid` | step 1 | the policy is not JSON or fails the `quotient-policy/2` schema |
| `posture-unsupported` | step 1 | `mode` is not `per-call`, or a static-only field is present |
| `disabled` | step 2 | the policy's `enabled` is `false` |
| `profile-invalid` | start-up; step 3; step 5 | the profile snapshot failed to load, so every call refuses; the name fails the profile grammar; or the profile names an `mcp__*` tool its form cannot deliver |
| `profile-unknown` | step 3 | no profile of that name was loaded |
| `profile-not-allowed` | step 3 | the name is not in the policy's `profiles` |
| `profile-capability-mismatch` | step 3 | the profile's `filesystem` differs from the capability the policy pins for it |
| `root-missing` | step 4 | the call's root does not exist |
| `root-not-a-directory` | step 4 | the call's root is not a directory |
| `root-not-allowlisted` | step 4 | the canonical root is outside every `roots` entry |
| `wrapper-unavailable` | step 5 | the policy declares no form for the profile's capability |
| `form-invalid` | step 5 | the project form at the lookup base is missing while an approval governs, unreadable, not an executable regular file, inside a writable path, or substitutes an unconfined slot |
| `form-unapproved` | step 5 | a usable project form is not approved, differs from the governing approval's identity, or the approvals store cannot be read |
| `ceiling-above-maximum` | step 6 | a requested ceiling is above the policy's maximum |
| `tools-not-allowed` | step 6 | the call asked for a tool the profile does not grant |
| `session-invalid` | step 7 | the session id fails the session grammar |
| `session-root-mismatch` | step 7 | the session is bound to a different root |
| `session-capability-mismatch` | step 7 | the session is bound to a different capability |
| `session-busy` | step 7 | another live call, or an owner whose liveness cannot be known, holds the session |
| `view-overlaps-protected` | step 8 | the child could write to a store it must not |
| `audit-unavailable` | before the run | the attempts ledger cannot be appended to, so nothing is launched |
| `audit-failed` | before the run | the run's first audit record cannot be written, so nothing is launched |
| `lane-predecessor-failed` | at launch | a laned run with `needs_success` whose predecessor in the lane did not complete, so it is not launched |
| `server-error` | any step | the server failed before a run was established |

A later build may add a reason to this table without minting a new version: the
envelope's fields do not change. A consumer must therefore handle a refusal
reason it does not know as a refusal — nothing ran, and `refusal.detail` says
why — never as a protocol fault or as a completed run.
