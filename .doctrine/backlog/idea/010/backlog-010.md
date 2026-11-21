# IDE-010: Handback reserve: nearing-ceiling wrap-up and a partial-result label

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

Source: field notes from Nemesis SL-024 and Malebolge (`nemesis-meta.local.md` § Tooling improvements); code checked at 0.6.1 on 2026-11-21 (recon `run-20261121T031456215Z-1-1772b2f8f56b`, key lines re-read by the orchestrator).

The gate acts only after a bound is crossed (`src/server/gate.ts:117`) and
never warns the child. A ceiling stop returns `result: null`, so whatever the
worker had already earned is lost; only prose in `help/orchestrate.md`
advises briefing an "answer by request N" deadline.

## Proposal

Opt-in soft threshold (e.g. a fraction of `requests` or `context_tokens`)
at which the worker is told to finish its current deliverable and answer with
files edited, last test and exit status, remaining work. The hard ceiling
stays. A result produced under the reserve is labelled partial.

## Open points

- How to inject a mid-run message into pi (steer/follow-up support?).
- Result-shape change: see ISS-006.
