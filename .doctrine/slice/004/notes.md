# Notes SL-004: Concurrent runs: start and wait tools

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-26 · design:drafting (rev 53) · committed: "doctrine(SL-004): bind MCP tasks" (parent e165dc6)

### Produced
- design run dr-01a17694: reopened scope minted as inq-10..17 → DEC-055..062; DEC-058 supersedes DEC-052, DEC-062 supersedes DEC-051
- Codex informal pass 1 (thread 01a176e3-7cea-7782-866b-c01fdcbe5640, gpt-6.1-sol) → inq-18..26 → DEC-063..070 (inq-19 deferred); DEC-058 isError reworded, DEC-070 wording corrected (user)
- graph-reviewed (rev 34), sufficiency-accepted (rev 44), stage drafting (rev 45)
- `design.md` sec-1, sec-2 (now protocol + tools + documents; no separate protocol section), sec-3, sec-5, sec-6 redrafted; Codex pass 2 (same thread) folded in; DEC-063 and DEC-066 amended by the user from that pass
- IDE-003 resolved (promoted into SL-004)

### Learned
- mem.fact.quotient.client-concurrency-readonlyhint — clients overlap calls only with readOnlyHint
- EVD-001..004 — scheduling probe; Claude Code and Codex limits; 2026-07-28 + tasks wire format
- spec facts used by sec-2 (cited there): clientCapabilities required (-32602 if missing); caching ttlMs/cacheScope; stdio cancellation MUST NOT reply; tasks terminal states immutable, tasks/cancel cooperative

### Open
- sec-7 (code structure), sec-8 (docs), sec-9 (impact/verification/risks) still the pre-reopen draft — redraft against DEC-055..070 and sec-1..6; then Codex pass on them; sec-4 stands
- inq-19 (deferred) — recovering a lost CreateTaskResult; revisit with a non-stdio transport
- RSK-002 — 30-min stdio idle abort of long blocking pi_agent
- DEC-045, DEC-048..050, DEC-053..070 — the governing decisions (sec-1 table)
- ASM-002 — invalidated; kept for the record

## Reopened scope: tasks binding (2026-10-26)

Superseded 2026-10-26: answers 1–8 below were minted as inq-10..17 →
DEC-055..062 and later refined (DEC-063..070). The decisions govern; this
section is kept for provenance only.

User assent, this session: "I'm inclined b) … In any case we should hew as
close as possible to the tasks wire format", then "agreed" to answers 1–8
below and to the governance re-confirmation over the widened context
(EVD-002..004 linked). These are agreed answers, not yet minted decisions:
the next agent turns each into an inquiry disposed as a DEC on the design
run (superseding DEC-052's shapes and DEC-051's default timeout), then
seeks sufficiency and redrafts.

1. **Dual-era protocol.** Serve 2026-07-28 statelessly (`server/discover`,
   per-request `_meta` version and capabilities, `resultType: "complete"` on
   results, `ttlMs`/`cacheScope` on `tools/list`, `-32022` for an
   unsupported version) beside legacy `initialize` / 2025-06-18 (keeps
   `ping`). Codex and older clients stay legacy.
2. **Which calls become tasks.** `pi_agent` answers a `CreateTaskResult`
   when the request declares `io.modelcontextprotocol/tasks`; otherwise it
   blocks as today. start/wait/ack/cancel stay for subagents and Codex.
3. **Status mapping.** queued/running → `working` (statusMessage says
   which); settled → `completed`, `result` = the CallToolResult `pi_agent`
   returns today (isError as today); cancelled → `cancelled`; lost →
   `failed` with an error pointing at the evidence dir; unknown → JSON-RPC
   `-32602`.
4. **Documents use Task field names verbatim** (`taskId`, `status`,
   `statusMessage`, `createdAt`, `lastUpdatedAt`, `ttlMs`, `pollIntervalMs`)
   plus extras (lane, key, session, artifacts, queued vs running). Wait
   entries are tasks with the `pi-agent-result/2` object as `result` (not a
   string-encoded CallToolResult). Mixed camelCase/snake_case accepted.
5. **Lifetime fields.** `ttlMs: null`; timestamps from the record, or from
   the evidence dir after a restart; `pollIntervalMs: 2000`.
6. Task-created runs are owned: not in wait's default unacknowledged set.
7. `tasks/update` answers an empty ack and does nothing (never
   `input_required`). Not implemented: `notifications/tasks`,
   `subscriptions/listen`, MRTR.
8. **Wait default `timeout_s` = 45 s**, still capped by the policy's
   `wall_clock_s` (fits Codex's 60 s `tool_timeout_sec`; far inside Claude
   Code's 30 min stdio idle window). Help states both clients' limits.

Sections to redraft: sec-2, sec-3, sec-5, sec-7, sec-8, sec-9, plus a new
protocol section. sec-4 (lanes) and sec-6 (cancellation) stand, with
`tasks/cancel` added to sec-6's table.
