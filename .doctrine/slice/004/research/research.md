# SL-004 research — concurrent runs: start and wait tools

## Header

- Thread 1 (governance applicability): orchestrating agent (Claude Opus 5.5),
  run directly. No research agents are defined for this project.
- Thread 2 (code map): quotient `pi_agent`, `research` profile
  (deepseek-flash), run `run-20261026T044536417Z-4-990c601b9931`, verbatim in
  `raw/code-map.md`.
- Prior art: two web searches by the orchestrating agent, 2026-10-26 (sources
  at the end).
- Probes: the two client-scheduling probes recorded in IMP-011.
- Baseline: `baseline.toml` (stamped 2026-10-26).
- User leanings going in (2026-10-26): OQ-4 no in-flight bound for now; OQ-1
  keep blocking `pi_agent`; OQ-2 a wait timeout with a non-final answer is
  likely.

## Verification legend

✓ = re-read at the cited site by the orchestrating agent. Unmarked = cited by
the researcher, not re-checked. Design may load-bear only ✓ rows, or verify at
point of use.

## Thread 1 — governance applicability

No accepted ADRs, policies, standards or specs exist in this repo
(`doctrine adr list` empty; no `.doctrine/spec/`). Binding authority is the
accepted decisions, the contracts in `docs/contract/`, and `docs/design.md`
(rationale; "where the two seem to disagree, the contract wins",
`docs/design.md:3-4` ✓).

### Binding constraints

| # | constraint | source |
|---|---|---|
| G1 | "Every call starts a fresh pi process and ends it before answering." Start/wait breaks this directly. | `docs/design.md:13-14` ✓ |
| G2 | One termination ladder: every stop (cancel, client gone, ceiling, wall clock, switch, signal) goes through the same sequence. A new stop route (cancel by run) must hand the same ladder a cause, not add a path. | `docs/design.md:98-110` ✓ |
| G3 | Client gone ⇒ abort every in-flight run, write no result; the audit records why. Runs started by `start` must stay covered. | `docs/design.md:107-110` ✓; `docs/contract/pi-agent-result-2.md:29-30` ✓; `server.ts:764-770` ✓ |
| G4 | Sessions: one owner at a time; a second call on a busy session refuses, never waits or interleaves. | `docs/design.md:116-119` ✓; `session.ts:328` ✓ |
| G5 | Result document invariants: only `completed` is final; only a completed run carries `result`; a spawned run carries `status` and `artifacts`. No non-terminal document exists. | `result.ts:393-404` ✓ |
| G6 | Versioned contract tokens; changing a document's shape mints a new version with explicit migration (DEC-004, DEC-005 precedent for policy/2 and status/3). | DEC-004, DEC-005 |
| G7 | Shipped text (`docs`, `help`, `README.md`, …) cites no doctrine ids; enforced by `src/drift.test.ts`. | mem.fact.quotient.no-doctrine-ids-in-shipped-text |

### Checked, not applicable

- DEC-001–003, DEC-006 (context/cost accounting): per-run accounting is
  unchanged; start/wait does not alter how a run is metered.
- DEC-007–013 (forms, approvals, policy layering): admission is reused as-is;
  start runs the same admission steps.
- DEC-014–037 (Nix form builder): confinement out of scope.
- CON-001 (SL-001 version bump): closed slice.

### Revision candidates

- `docs/design.md` "One process per call, one root per call" and the
  one-tool opening line (`:6` ✓): reword so a run may outlive the call that
  started it, and keep the reasons (no long-lived delegate; nothing outlives
  the server).
- `README.md:3` ✓ ("one tool, `pi_agent`").
- `docs/contract/pi-agent-result-2.md`: EOF paragraph and states; likely a
  new result version or a separate handle document (see deltas).

## Thread 2 — code map

Full map: `raw/code-map.md`. Load-bearing rows:

### Hotspots

- `src/server/server.ts`: tool table (`:38` ✓), `tools/list` (`:534-538` ✓),
  `tools/call` arm and in-flight index (`:540-581` ✓), `callTool` admission →
  run → commit (`:257-480`), cancellation `abortNamed` (`:684-691` ✓), EOF
  sweep (`:764-770` ✓).
- `src/server/spawn.ts` `runChild` (`:225-507`): one function launches and
  owns termination. Waiting begins at `await exited` (`:462` ✓). Split there,
  without forking the ladder.
- `src/server/session.ts`: ownership record carries `call_id` (`:99` ✓);
  release is the call's `finally` (`server.ts:476-479` ✓). Ownership must
  belong to the run, released when the run settles.
- `src/server/result.ts`: sole verdict builder `resultFor` (`:254`) and
  validator (`:360`); no non-terminal shape (`:393-404` ✓).
- `src/server/evidence.ts` `runName` (`:81-89` ✓):
  `run-<stamp>-<call-id slug>-<12 hex>`, already unique per run — natural
  handle.
- Help: tool description is the `tool` help section (`help.ts:38`,
  `help/tool.md`); a second tool needs its own section.
- Tests that pin one tool: `server.test.ts:117-130` ✓ (exactly one tool,
  exact key set `name, description, inputSchema`); `server.test.ts:752-762`;
  `help.test.ts:369-377`, `:423-428`.

### Per-call state that must outlive the call

From `raw/code-map.md` § State that is per-call today: the abort controller
and in-flight registration (keyed by JSON-RPC id, `server.ts:113`, `:124`),
the gate and its `close()` (`:356`, `:477`), the session lock's release, the
reduce/commit/result tail (`server.ts:445-467`). The reply path is gated on
`context.closed` (`:556`).

### Cancellation today

`notifications/cancelled` → `abortNamed` aborts every call under the
request id with `'cancelled'` (`server.ts:684-691` ✓). Once `start` has
answered, its request id is spent, so cancelling a started run needs another
address (the handle).

### Naming precedents

- Tool name `pi_agent` (`server.ts:39`); snake_case wire fields
  (`call_id`, `transcript_budget_bytes`).
- Schema tokens `<kebab-noun>/<n>`: `pi-agent-result/2`, `pi-run-status/3`.
- Session id: 32 lowercase hex (`session.ts:138-140`).

### Test rig

`test-rig.ts`: `openServer`/`converse`/`waitForReplies`, stub launchers,
`rigForm` for arbitrary stub bodies. Concurrency precedent:
`spawn.test.ts:421-470` (two overlapping calls, one cancelled).

## Prior art

- **MCP tasks.** The MCP 2025-11-25 spec adds experimental *tasks*: a
  `tools/call` can be task-augmented, answered with a task id, then polled
  (`tasks/get`) and fetched (`tasks/result`); `tasks/cancel` cancels. A later
  revision (2026-07-28) moved tasks into an extension
  (`io.modelcontextprotocol/tasks`) and dropped `tasks/result`, so `tasks/get`
  returns the result. Sources disagree in places; not checked against the
  spec page directly.
- **Client support for tasks.** No evidence found that Claude Code supports
  task-augmented calls as a client. A feature request for async MCP calls was
  closed 2026-03-10; how it was resolved is unknown.
- **`readOnlyHint` scheduling is not Claude-Code-specific.** Codex CLI also
  runs `readOnlyHint` tools concurrently and others serially (one secondary
  source). The MCP spec says clients must treat annotations as untrusted
  unless the server is trusted.
- **Community precedent.** At least one third-party MCP server
  (cc-multi-process-mcp) uses a start-task / poll pattern so a client can fire
  several long runs without hitting tool timeouts.
- **Client timeouts.** Codex's default MCP tool timeout is 60s; the README
  already tells operators to raise it (`README.md:192-201` ✓).

## Cross-thread findings

- **X1. Start/wait is the portable form of MCP tasks.** Both major clients
  schedule by `readOnlyHint`, and neither is known to support tasks. Tools
  work today in every client. Shape them so a later task-extension binding
  maps one-to-one: start ↔ task-augmented call, wait ↔ `tasks/get`, cancel ↔
  `tasks/cancel`.
- **X2. The split point is inside `runChild`, not at `callTool`.** Admission
  and launch end at `spawn.ts:314`; waiting starts at `:462`. The commit tail
  (reduce, transcript, status, result) must run when the run settles, not
  when someone waits, or a run nobody waits on leaves no status.
- **X3. G1 is the governing rule to revise, and its reasons still hold.**
  "Nothing outlives the server" (G3) survives unchanged; only "nothing
  outlives the call" goes. The design should restate the invariant as
  "nothing outlives the server; every run reaches the ladder".
- **X4. Session lock ownership by `call_id`** (`session.ts:99` ✓) makes the
  record name the starting call. Liveness is by pid + start time, so the lock
  stays correct while the run outlives that call; `call_id` becomes
  descriptive only.
- **X5. OQ-2 interacts with G5.** A "still running" answer is not a result
  document (no non-terminal state). It wants either its own schema token or a
  new result version with a `running` state; the cause→state table
  (`result.ts:68-85`) is all terminal.
- **X6. Cancellation by run is required by construction:** the starting
  request id is spent once `start` answers (`server.ts:684-691` ✓). Whether
  cancel is its own tool or an argument to wait is a design choice; it is a
  write (it stops a run), so it cannot carry `readOnlyHint`.

## Design-input deltas

- D-1. Keep `pi_agent`, and implement it as start + wait in-process so there
  is one run path (OQ-1, user leaning).
- D-2. Wait takes a timeout and answers non-final for runs still going
  (OQ-2, user leaning); decide the document shape (X5) and whether the
  result can be collected more than once.
- D-3. No in-flight bound now (OQ-4, user); record as a follow-up.
- D-4. OQ-3 (all vs first) is open. With a timeout, "return when all settle
  or the timeout passes, reporting each" may cover both uses.
- D-5. Add a cancel route by handle (X6).
- D-6. Commit tail moves to run settlement (X2).
- D-7. Revise `docs/design.md` G1 and the one-tool lines (Thread 1 revision
  candidates); new help sections per tool.
- D-9. Sequential runs (added to scope by the user after the round,
  2026-10-26; not researched). Bears on: G4 (sessions refuse rather than
  queue — this is opt-in queueing of runs, not of sessions, so no conflict,
  but the design should say so); X2 (a queued run has admission done and no
  process, a third lifecycle point); X5 (a `queued` state joins `running` as
  non-final); G3 (EOF must also drain the queue, with an audit record per
  dropped run); `docs/design.md` "Profiles are live authority" (queued runs
  may outlive a policy change — re-check at launch). Open points in
  SL-004's OQ-6.
- D-8. Keep the shapes mappable to MCP tasks (X1); binding to the extension
  is a follow-up, pending client support.

## Sources

- [MCP spec 2025-11-25 — tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [AAIF — long-running MCP tool calls with the tasks extension](https://aaif.io/blog/handle-long-running-mcp-tool-calls-with-the-mcp-tasks-extension)
- [MCP Python SDK — experimental tasks](https://py.sdk.modelcontextprotocol.io/experimental/tasks/)
- [MCP C# SDK — tasks](https://csharp.sdk.modelcontextprotocol.io/concepts/tasks/tasks.html)
- [Codex CLI readOnlyHint concurrent execution](https://codex.danielvaughan.com/2026/05/27/codex-cli-mcp-readonlyhint-concurrent-tool-execution-annotations-parallelism/)
- [Claude Code feature request: async MCP tool calls](https://claudeissues.com/issue/31427-feature-async-background-mode-for-mcp-tool-calls)
- [cc-multi-process-mcp](https://github.com/L-x-C/cc-multi-process-mcp)
