# IMP-015: Ceiling stop reports the binding dimension, limit and observed value

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

Source: field notes from Nemesis SL-024 and Malebolge (`nemesis-meta.local.md` § Tooling improvements); code checked at 0.6.1 on 2026-11-21 (recon `run-20261121T031456215Z-1-1772b2f8f56b`, key lines re-read by the orchestrator).

A ceiling stop answers `state: ceiling_exceeded`, `causes: [ceiling]`
(`src/server/result.ts:270`). Request, context-token and cost crossings are
indistinguishable on the wire. The gate already knows which one bound:
`GateTrigger {cause, unit, observed, limit}` (`src/server/gate.ts:40`), but
it reaches only `audit.jsonl` (`src/server/spawn.ts:581`). The run's
clamped ceilings and elapsed wall-clock are not reported. The wait entry
(`src/server/documents.ts:51`) carries nothing more.

## Proposal

Thread the trigger into the result and wait entry, e.g.
`ceiling: {unit, limit, observed}`, alongside the run's clamped ceilings.
Measurement completeness is already reported (`requests_unmeasured`).
Consider a retained-context figure (last request's context) so a caller can
choose a viable `context_tokens` cap for a continuation.

## Open points

- Additive field within `pi-agent-result/2`? Blocked on ISS-006.

## Evidence (2026-11-21)

Run `run-20261121T032856897Z-76-4e28bfb03f62` stopped with `ceiling_exceeded` under the caps `requests: 30` and `context_tokens: 60000`. The envelope alone did not say which cap bound. The orchestrator had to work it out from `status.requests` (31) against `status.context.peak_tokens` (52349).
