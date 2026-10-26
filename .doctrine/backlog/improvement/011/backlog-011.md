# IMP-011: Concurrent runs: split pi_agent into start and wait

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Let a caller run several `pi_agent` runs at once — including several
write-capable runs (different roots, or disjoint files in one tree).

## Evidence (probed 2026-10-26, Claude Code client, server 0.5.0)

The server already overlaps `tools/call` (`src/server/server.ts`, the
`tools/call` arm; covered by `spawn.test.ts` "two concurrent calls…"). The
client serialises: two `read`-profile calls sent in one message, each running
`sleep 20`:

| tool annotations | run 1 sleep | run 2 sleep | overlap |
|---|---|---|---|
| none (as shipped) | 919.77 → 939.77 | 943.36 → 963.36 | no — run 2's dir created 1.5s after run 1 ended |
| `readOnlyHint: true` (temporary patch of the installed `dist`) | 373.36 → 393.36 | 373.64 → 393.64 | yes — dirs created 4ms apart |

So Claude Code runs MCP calls concurrently only when the tool declares
`annotations.readOnlyHint: true`. `PI_AGENT_TOOL` declares no annotations.

## Constraint

`readOnlyHint` is false for write-capable profiles, and clients may use it to
skip approval as well as to schedule. Declaring it on a writer is a false
claim. A read/write tool split makes the hint honest but still serialises
writers, which is the case we want.

## Proposal

Separate launching a run from awaiting it:

```
pi_agent_start(prompt, profile, cwd…) → { run, session }  returns at once; writes
pi_agent_wait(run…)                   → pi-agent-result/2  blocks; observes only → readOnlyHint: true
```

- Starts serialise but cost milliseconds; waits are honestly read-only, so they
  overlap. A `wait` over several run ids avoids depending on the client at all.
- Reuses: per-run evidence dir and `status.json`, `session-busy`, the
  in-flight index and cancellation.
- New: a run handle that outlives its call; what EOF/disconnect does to
  started runs (today `serve` aborts in-flight calls at EOF — probably keep);
  cancellation addressed by run, not by request id; whether blocking
  `pi_agent` stays as a shortcut.
- File-disjointness and shared build locks remain the orchestrator's job
  (`help/orchestrate.md`).

## Rejected

- `readOnlyHint` on the writer: false claim; approval implications.
- Batch tool (`prompts[]` → `results[]`): honest, but nothing returns until
  the slowest run ends; no per-run continue/cancel.
- Fan-out via client subagents each calling `pi_agent`: unverified that it
  overlaps; client-specific; a client context per run.

Contract change (new tools, result/status docs, help sections): needs a slice
and design.
