# ISS-007: Reduced transcript pairs a tool call only with the next entry; parallel or unanswered calls lose their result

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

Source: field notes from Nemesis SL-024 and Malebolge (`nemesis-meta.local.md` § Tooling improvements); code checked at 0.6.1 on 2026-11-21 (recon `run-20261121T031456215Z-1-1772b2f8f56b`, key lines re-read by the orchestrator).

`units()` (`src/reduce/reduce.ts:438`) folds a tool call only with the entry
immediately after it. Inferred from the code, not yet reproduced: two parallel
calls (start, start, end, end) leave the first call unpaired and its result
rendered as a loose line; a call requested in an assistant message but never
started leaves no trace, since `renderProse` drops non-text blocks
(`reduce.ts:283`).

## Proposal

Red test with parallel tool calls first. Pair results to calls by tool-call id.
Related: IMP-016.
