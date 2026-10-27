# IDE-007: Better in-flight observability of runs

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

User, 2026-10-27, during the README rewrite: observability is a reason to use
quotient over calling pi directly, but it is "not yet sure what's valuable".

Today, while a run works, a handle / wait entry carries only `state`
(`queued`, `running`, ...), `statusMessage` and `lastUpdatedAt`
(`docs/contract/pi-run-handle-1.md`). The reduced transcript, status
(context peak, usage, cost, counts) and verdict arrive only once the run
settles. The evidence dir (`src/server/evidence.ts`, `RUN_EVIDENCE_FILES`)
holds `events.jsonl`, `stderr.log`, `transcript.md`, `status.json`,
`audit.jsonl`, `result.json`; the caller is not pointed at any of them
mid-run. The README claims only "reports its state while it works".

## Candidates (unranked, unvalidated)

- Live counters on the run document: requests so far, current context peak,
  cost so far, last tool called, elapsed vs wall-clock ceiling.
- A bounded tail of the reduced transcript on a wait entry for a running run.
- MCP progress notifications / task `statusMessage` updated from events.
- An operator view (`quotient runs`/`quotient tail <id>`) over the evidence
  dir, for humans rather than the calling agent.

## Questions to settle first

- Who is the consumer: the calling agent (deciding to cancel / re-brief) or
  the human operator (watching spend)? They want different things.
- What decision would live data change? Value only where it changes a
  cancel/continue choice or spend control.
- Cost: wait answers share a byte budget; live data competes with results.
- Contract impact: run document fields are normative (`pi-run-handle/1`);
  additions need a schema decision.
