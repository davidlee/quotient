# Concurrent runs: start and wait tools

## Context

From IMP-011. The server already overlaps `tools/call` requests
(`src/server/server.ts`, the `tools/call` arm; `spawn.test.ts` covers two
concurrent calls). The client is the bottleneck: on 2026-10-26 two
`read`-profile calls sent in one Claude Code message ran strictly one after
the other. With `annotations.readOnlyHint: true` patched into the installed
server's `tools/list` reply, the same two calls started 4ms apart and
overlapped fully (evidence table in IMP-011).

`readOnlyHint` cannot honestly be set on a tool that can run write-capable
profiles, and clients may also use it to skip approval. A read/write tool
split would make read runs concurrent but leave writers serial, and several
writers at once is a use we want: different roots, or disjoint files in one
tree.

```
today                                   this slice
─────                                   ──────────
pi_agent ── blocks for the whole run    pi_agent_start ── returns a run handle at once (writes)
  (no annotations → client serialises)  pi_agent_wait  ── blocks on run(s); observes only
                                                          (readOnlyHint: true → overlaps)
```

## Scope & Objectives

1. **Start.** A tool that admits and launches a run exactly as `pi_agent`
   does today (policy, profile, cwd, ceilings, session), and answers at once
   with a run handle, or the same refusal `pi_agent` would give.
2. **Wait.** A tool that blocks on one or more started runs and answers with
   their `pi-agent-result` documents. It changes nothing and declares
   `readOnlyHint: true`, so a client that serialises other tools still
   overlaps waits. A wait over several handles makes concurrency independent
   of client scheduling.
3. **Run lifetime.** A run handle outlives the call that started it, never
   the server. Results are collected at least once (repeatedly until
   acknowledged) and written atomically to the run's evidence directory as
   `result.json`, so a handle from before a restart or from another server
   sharing the run directory resolves from disk and its owner's liveness.
   Runs are cancelled by handle or by task; client EOF aborts running runs
   and drops queued ones, each settling with a result.
4. **Bounding.** Concurrency multiplies spend: per-run maxima stay per run.
   No policy bound on runs in flight for now (user, 2026-10-26); a follow-up
   if needed.
5. **Lanes: explicitly sequential runs** (user, 2026-10-26). A start may
   name a lane: at most one run per lane executes at a time, and a lane's
   runs execute in the order they were started. Unlaned runs are
   unaffected. A run marked `needs_success` does not launch if its lane
   predecessor did not complete. A queued run is visible to wait as not yet running, and can be
   cancelled before it launches.
6. **Contract and docs.** The tool list, the result contract
   (`pi-agent-result/2` keeps its shape; new handle, wait and ack documents),
   `quotient help` (per-tool, agent, orchestrate, setup sections) and the
   README say how to drive concurrent runs.
7. **MCP tasks binding** (user, 2026-10-26, widened from IDE-003 after
   EVD-002..004). Serve MCP protocol revision 2026-07-28 statelessly
   (`server/discover`, per-request `_meta`, `resultType`) beside the legacy
   `initialize` / 2025-06-18 path, and bind the
   `io.modelcontextprotocol/tasks` extension over the run registry:
   `pi_agent` answers a task when the request declares the extension;
   `tasks/get`, `tasks/cancel`, `tasks/update` are served. The wrapper
   documents follow the tasks wire format as closely as possible.

## Non-Goals

- Enforcing file-disjointness or serialising shared build locks between
  writers. That stays the orchestrator's job (`help/orchestrate.md`).
- Setting `readOnlyHint` on any tool that can start a write run.
- Client-specific workarounds (fan-out through client subagents).
- Changing confinement, forms, or the per-run gate.

## Affected surface

Coarse; design fixes the exact set.

- `src/server/server.ts`: tool definitions, `tools/list`, call dispatch,
  in-flight index, EOF sweep; `callTool` split into new modules (admission,
  execution, run registry, views, waiting, documents, protocol, tools).
- `src/server/spawn.ts`, `session.ts`, `evidence.ts`: run lifetime, run
  owner identity and liveness, `result.json`.
- `src/server/result.ts`: one new refusal reason.
- `src/help/**`, `help/*.md`, `README.md`.
- `docs/contract/**`: result and policy contracts.
- The JSON-RPC layer in `server.ts`: protocol era per request,
  `server/discover`, `tasks/*` methods.

## Open questions

All settled in design (2026-10-26). Governing decisions: tools DEC-048;
run records, disk-backed results, acknowledgement once terminal DEC-049;
lanes, re-admission at launch, `needs_success` DEC-050; cancellation and EOF
DEC-053; annotations DEC-054; docs DEC-045. Objective 7 (reopened
2026-10-26): dual-era protocol DEC-055, DEC-063; `pi_agent` as a task and
task methods DEC-056, DEC-057, DEC-059, DEC-061; run documents as Tasks
DEC-058 (supersedes DEC-052), DEC-068; owned runs DEC-060, DEC-070; wait
DEC-062 (supersedes DEC-051), DEC-069; no reply to a cancelled request and
the mark as intent DEC-064, DEC-065; the publication line and the published
`lost` record DEC-066; run owner identity and liveness across hosts, boots
and pid namespaces DEC-067. DEC-049, DEC-066 and DEC-067 were amended
2026-10-26. OQ-4 → not now (IDE-005). Deferred: listing acknowledged runs
(IDE-004); recovering a task whose creation reply never arrived (design
run inquiry inq-19). ASM-002 invalidated.

## Risks

- A run that nobody waits on keeps spending until its ceilings stop it.
- A dead server's unfinished run reads `working` (foreign) rather than
  `lost` when its owner cannot be judged dead: an unreadable pid table, or
  an owner on another host or in another pid namespace.
- Blocking `pi_agent` runs over 30 minutes are aborted by Claude Code's stdio
  idle timeout (RSK-002).
- Session locks keep today's pid-and-start-time liveness across pid
  namespaces (RSK-003).

## Verification intent

- Tests: two starts then one wait over both overlap (timestamps), including
  two write-profile runs under different roots; cancel-by-run leaves the
  other run alive; EOF behaviour as specified; refusals from start match
  `pi_agent`'s.
- Tests: three sequential starts run one at a time in start order while an
  unmarked run overlaps them; cancelling a queued run removes it without
  launching and lets the next one start.
- Tests: per-request era classification; legacy clients served as today; a
  task-declaring `pi_agent` answers a task that `tasks/get` follows to the
  blocking call's result; run resolution from disk and owner liveness.
- Probe: the IMP-011 two-call probe under Claude Code overlaps with waits,
  using write profiles.
- Gate green (`just gate`), lint zero warnings.

## Summary

## Follow-Ups

- IDE-004 listing acknowledged runs; IDE-005 a policy bound on runs in
  flight; RSK-002; RSK-003; recovering a lost task creation reply (inq-19).
