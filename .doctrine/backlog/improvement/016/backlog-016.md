# IMP-016: Reduced transcript marks a tool call that got no result

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

Source: field notes from Nemesis SL-024 and Malebolge (`nemesis-meta.local.md` § Tooling improvements); code checked at 0.6.1 on 2026-11-21 (recon `run-20261121T031456215Z-1-1772b2f8f56b`, key lines re-read by the orchestrator).

A call whose result never arrived renders as a bare `→ name(args)`
(`src/reduce/reduce.ts:292`), the same as one still in flight. Exit 0 carries
no marker; nonzero shows `[exit N]`. At a ceiling stop the orchestrator
cannot tell from the transcript whether an edit or test completed.

## Proposal

Mark an unanswered call (`no tool result observed`). Keep the wording about
observed tool evidence, not workspace state. Consider a completed/failed split
in `status.tool_calls`. Depends on ISS-007's pairing fix.
