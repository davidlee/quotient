# IMP-020: Reduced transcript shows a tool call requested but never started

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

Split out of ISS-007 by the user's choice (2026-11-21): ISS-007's fix pairs
results to calls by `toolCallId`, but tracks only calls pi *started*
(`tool_execution_start`). A call requested in an assistant message (a
`toolCall` block, which carries `id` and `name`) that never starts leaves no
trace: `renderProse` (`src/reduce/reduce.ts`) drops non-text blocks.

Evidence so far: ceiling stops observed abort after a start (e.g. run
`run-20261121T034331935Z-206-b557b1ca372c` ends on an unanswered
`tool_execution_start`), so this case is believed rare. Not reproduced.

## Proposal

Open a call from the assistant message's `toolCall` blocks, keyed by id, and
let `tool_execution_start` attach to it. Mind the candidate-replacement
semantics of `message_start`/`message_end`, partial blocks on an aborted
message, and whether `status.tool_calls` counts requests or starts.
Related: ISS-007, IMP-016.
