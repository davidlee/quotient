# Notes SL-004: Concurrent runs: start and wait tools

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-26 · lifecycle plan · design locked (rev 72) · uncommitted on b6a1217 (design.md, slice-004.md, slice-004.toml, notes.md, RV-013, DEC-049/066/067, EVD-004, RSK-003)

### Produced
- design run dr-01a17694: reopened scope minted as inq-10..17 → DEC-055..062; DEC-058 supersedes DEC-052, DEC-062 supersedes DEC-051
- Codex informal pass 1 (thread 01a176e3-7cea-7782-866b-c01fdcbe5640, gpt-6.1-sol) → inq-18..26 → DEC-063..070 (inq-19 deferred); DEC-058 isError reworded, DEC-070 wording corrected (user)
- graph-reviewed (rev 34), sufficiency-accepted (rev 44), stage drafting (rev 45)
- `design.md` sec-1, sec-2 (now protocol + tools + documents; no separate protocol section), sec-3, sec-5, sec-6 redrafted; Codex pass 2 (same thread) folded in; DEC-063 and DEC-066 amended by the user from that pass
- IDE-003 resolved (promoted into SL-004)
- sec-7, sec-8, sec-9 redrafted against DEC-055..070; sec-3 RunRecord.outcome widened to state+causes and its fallback/cross-server wording corrected; Codex pass 3 (fresh thread, gpt-6.1-sol high) — 10 findings, all fixed within decisions, none on a ledger
- 11 design-target selectors added (protocol.ts, views.ts, spawn.ts, session.ts, test-rig.ts, 6 test files); stage reviewing (rev 56), pass ledger RV-013 opened, no findings yet
- RV-013 pass: 3 unanchored Opus reviewers (timing/races; protocol/interfaces; structure/failure/tests) → F-1..F-21 raised; F-1..F-11, F-13..F-21 answered fix-now (F-7 contested in substance, refresh EVD-004); F-12 left open, settled by the DEC-067 amendment
- Codex check of the redraft (thread 01a1778d-fd61-79b2-b539-30289b8d9cd2, gpt-6.1-sol high) — 13 findings: 11 fixed within decisions (F-6, F-14 responses amended), 2 raised to the user
- user replied '1a 2a 3a': DEC-066 (published `lost` audit record), DEC-067 (owner identity + ownerLiveness across hosts/boots/pid namespaces), DEC-049 (ack once terminal) amended; EVD-004 extended with SEP-2663 (no per-tool taskSupport)
- sec-1..9 redrafted and recorded (rev 57), design.md materialised (rev 58)
- RSK-003 — session locks keep pid+starttime liveness across namespaces (follow-up)
- Codex check of the amendment fold (thread 01a177ae-a0d3-7382-9729-d079b3e16b66, gpt-6.1-sol high): 5 findings fixed within DEC-049/066/067 (pidns via NSpid; readResult found/absent/unreadable; audit lines start fresh, torn lines skipped; lost-ordering and dual-failure tests; bookkeeping) — sec-3/7/8/9 at rev 62
- RV-013: F-12 disposed (DEC-067 amendment); F-1..F-21 verified against rev 64; concluded at rev 69
- DEC-068 amended (user reply 'a'): pi-agent-wait/1 gains an `unreadable` list; Codex rounds 2–3 on the same thread closed the NSpid and unreadable folds (rev 66–68)
- governance-confirmed re-recorded (rev 65, user: "governance: confirmed")
- review.passes discharged; RV-013 disposed conducted; all 9 sections attested; design accepted and locked (rev 72, user: "agreed, lock it and handover for plan"); slice status → plan
- runbook review.scope (slice-004.md reconciled; SL-004 references RSK-002, RSK-003) and review.selectors (+ ack contract, gate.test.ts, childview.test.ts) discharged

### Learned
- mem.fact.quotient.client-concurrency-readonlyhint — clients overlap calls only with readOnlyHint
- EVD-001..004 — scheduling probe; Claude Code and Codex limits; 2026-07-28 + tasks wire format
- spec facts used by sec-2 (cited there): clientCapabilities required (-32602 if missing); caching ttlMs/cacheScope; stdio cancellation MUST NOT reply; tasks terminal states immutable, tasks/cancel cooperative

### Open
- next: /plan — author plan.toml/plan.md and phases from the locked design.md (sec-7 modules, sec-9 code impact and verification)
- plan constraint: the first phase touching session.ts confirms NSpid / boot_id / ns-link behaviour on the target host (notes § Further review passes)
- inq-19 (deferred) — recovering a lost CreateTaskResult; revisit with a non-stdio transport
- RSK-002 — 30-min stdio idle abort of long blocking pi_agent
- DEC-045, DEC-048..050, DEC-053..070 — the governing decisions (sec-1 table)
- ASM-002 — invalidated; kept for the record

## Plan baselines (2026-10-26, at eb622b6)

Lint (`npx eslint src`), errors per file touched by this slice; every other
touched file is at zero. A phase may not end above these.

```
server.ts 13 · spawn.ts 21 · session.ts 17 · result.ts 10 · help/help.ts 11
test-rig.ts 27 · server.test.ts 32 · spawn.test.ts 38 · session.test.ts 36
result.test.ts 16 · gate.test.ts 56 · childview.test.ts 16 · evidence.ts 0
profiles.test.ts 49 · reduce/reduce.ts 125 · help.test.ts 0 · drift.test.ts 0
```

Host probe (PHASE-02 EN-2), this host, Node 22:

```
/proc/self/status        NSpid: <pid>           one field (host /proc)
/proc/sys/kernel/random/boot_id   readable
/proc/self/ns/pid        pid:[4026531836]       readable via readlink
unshare --user --pid --fork --mount-proc    NSpid: 2            one field (own /proc)
unshare --user --pid --fork (host /proc)    NSpid: <hostpid> 1  two fields → pidns null
```

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

## Further review passes (2026-10-26, after RV-013 concluded)

None needed before the lock. RV-013 and three Codex rounds covered timing and
races, the protocol surface, structure, failure paths and tests, and every
amendment fold was re-checked. What a further pass would probe, if wanted:
the Linux facts the liveness rule rests on (`NSpid` ordering,
`/proc/sys/kernel/random/boot_id`, pid-namespace links readable by the
process itself) are documented behaviour, not yet exercised; the first phase
that touches `session.ts` should confirm them on the target host. The
2026-07-28 wire details beyond EVD-004 rest on the server's own choices
(sec-2), which a client-interop probe after implementation would test.
