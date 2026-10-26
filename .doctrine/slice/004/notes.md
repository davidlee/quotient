# Notes SL-004: Concurrent runs: start and wait tools

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-26 · PHASE-03 completed · 151099d

### Produced
- design locked rev 79 (run dr-01a17694); plan 10 phases (38b2b07, 66c493b, 529846e) — history in git
- PHASE-01 done — evidence foundations, reducer guard, lane refusal reason (f9944c6; delta recorded); Codex pass 6 findings fixed; choices in § PHASE-01 execution
- PHASE-02 done — owner identity, ownerLiveness, shared fakeProc (9ccee47; delta recorded); Codex pass: 3 minor fixed, 2 major raised (§ PHASE-02 execution)
- PHASE-03 done — callTool extracted to tools/admission/execute/documents (656c57b, cb45a56; delta 9f4d8b1..cb45a56); Codex pass 4 minor fixed (§ PHASE-03 execution)

### Learned
- mem.fact.doctrine.verify-vt-needs-record-delta — hand-committed phases need `slice record-delta` before verify-vt attributes them (f955e40)
- mem.fact.quotient.client-concurrency-readonlyhint — clients overlap calls only with readOnlyHint
- EVD-001..004 — scheduling probe; Claude Code and Codex limits; 2026-07-28 + tasks wire format

### Open
- next: PHASE-04 (run registry)
- D-2 — `here` on AdmissionContext; /reconcile amends sec-7 (§ Divergences)
- isRecord: now 7 private copies (tools.ts added one); consolidation candidate, not filed
- PHASE-02 Codex F1 — recorded on RSK-003 (user: record, don't chase); /reconcile: add to design sec-9 Risks
- DIVERGENCE (F2, timens) — implementation adds a 4th identity component; /reconcile amends DEC-067 + design (§ Divergences)
- IMP-004 — satisfied by PHASE-03 (Step<T>, recording at the boundary); resolve at close
- inq-19 (deferred) — recovering a lost CreateTaskResult; revisit with a non-stdio transport
- RSK-002 — 30-min stdio idle abort of long blocking pi_agent
- RSK-003 — session locks judge liveness by pid+starttime across pid namespaces
- DEC-045, DEC-048..050, DEC-053..070 — the governing decisions (design sec-1 table)

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

## Divergences (pending /reconcile)

- **D-1 timens in the run owner's identity (2026-10-26).** User, after the
  PHASE-02 Codex pass F2: "ok, I'll take F2 now", then "record the divergence
  now and amend the design in reconcile". Implemented ahead of PHASE-04 (which
  first persists `owner` in the `admitted` record), because a record written
  without it could never be judged dead later.
  What diverges: `HostIdentity` gains `timens` (`readlink <procDir>/self/ns/time`,
  null when unreadable; no NSpid-style gate — start times are offset by the
  *reader's* time namespace, and `self` is the reader). `ownerLiveness`:
  `timens` joins the any-null → `unknown` check, and a differing `timens` (same
  host and boot) → `unknown`. Different boot stays `stale` whatever `timens`.
  Reconcile must amend: DEC-067 (identity tuple + rule), design sec-3 Start
  step 4 and the `ownerLiveness` bullet, sec-7 `session.ts` paragraph,
  sec-9 `fakeProc` / `session.test.ts` / `views.test.ts` bullets, plan
  PHASE-02 objective/EX text (immutable ids: append, don't renumber).
  Landed in 4459ed8, after PHASE-02's recorded delta (9ccee47) and
  outside any phase range; gate green, 451 tests; 4 mutation controls killed.
  No Codex pass on this follow-up (small, test-pinned).

- **D-2 `here` on AdmissionContext (2026-10-26, PHASE-03 planning).** User
  chose "Add `here`" when asked whether admit's host identity should ride
  AdmissionContext. What diverges: sec-7's `AdmissionContext` is
  `{ startup, locations, launchDir, procDir }`; code adds
  `here: HostIdentity` beside `procDir`, because admit calls acquireSession,
  which requires the identity read once at start-up. Reconcile must amend:
  design sec-7 `admission.ts` type.

## Plan amendments

- **VT-1 keyword (2026-10-26, PHASE-03 planning).** `request-invalid` →
  `session-invalid`: admit cannot produce `request-invalid` (readToolCall
  decides it in server.ts before admit runs). User: "Swap to session-invalid".
- **PHASE-03 VT-3 keyword (2026-10-26, PHASE-03 close).** `export function
  executeRun` → `async function executeRun`: the literal missed `async`. User:
  "Amend keyword".

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

## PHASE-01 execution (2026-10-26)

Orchestrated with quotient pi workers (implement profile, deepseek-flash): four
runs, $0.089 total — evidence.test.ts, reduce.test.ts cases, evidence.ts,
spawn.test.ts cases. Small edits (reducer guard, spawn.ts, result.ts, contract)
done directly: briefing would have cost more. Then one Codex pass
(gpt-6.1-sol, high): 3 medium, 3 low, all verified and fixed with tests.

What pi got wrong: duplicated a parse-then-guard helper and a private
`errorCode` that `paths.ts` already owns; one test (onAudit) covered only the
happy path. Briefs that point at existing helpers would avoid the first.

Decisions carried forward:
- `isEventObject` (reduce.ts) returns `boolean`, not a type guard: as a guard it
  narrows the reducer's deliberately-`any` events and breaks typechecking.
- `readResult` uses `absent()` (paths.ts): a dangling `result.json` symlink reads
  `unreadable`, not `absent` — the stricter reading of "only absence is evidence".
- `appendAudit` prefixes a newline whenever the tail cannot be proven clean (not
  only when the last byte is not LF); readers skip blank lines.
- `observe` detects `agent_settled` before the guarded count, so a throwing
  `onRecord` cannot hide a settle.
- `runName` is exported; `writeResult` creates the run directory.


## PHASE-02 execution (2026-10-26)

EN-2 host probe matched § Plan baselines (own-/proc NSpid printed `1`, not `2`:
node ran as the namespace's first process; still one field). Two pi runs
(implement), $0.066 total: fakeProc + tests (red recorded), then session.ts +
server.ts. I added one liveness row and refactored two small things; five
mutation controls each turned a test red. Codex pass (gpt-6.1-sol, high).

What pi got wrong: nothing functional. Dead code (`readlink` empty check) and
a helper named for less than it did (`sameHost` also checked completeness).

Choices carried forward:
- `AcquireOptions.here: HostIdentity` is required; `serve()` reads
  `readHostIdentity('/proc')` once into `Context.here`. PHASE-03 moves it
  under `AdmissionContext` beside `procDir`.
- ownerLiveness precedence: any null → unknown; host → unknown; boot → stale
  (table not read); pidns → unknown; else observeLiveness.
- fakeProc copies `/proc/self/stat` (not `/proc/<process.pid>/stat`) and
  `nspid: []` stages a status with no NSpid line.

Codex findings:
- F3 (fixed) fakeProc copied another process's stat under an ancestor /proc.
- F4 (fixed) the real-host test demanded a non-null pidns; now asserts it
  tracks NSpid's field count. Whole suite passes under
  `unshare --user --map-root-user --pid --fork`.
- F5 (fixed) no row pinned boot-before-pidns; added, with a mutation control.
- F1 (raised) equal hostnames do not prove one machine: two hosts named
  `localhost` sharing a run dir, or an nspawn container (own boot_id) sharing
  a hostname, read a live owner `stale` → false `lost`. Challenges DEC-067.
- F2 (raised) /proc/<pid>/stat start time is offset by the reader's time
  namespace; same host/boot/pidns with different time namespaces reads a live
  owner `stale`. Also applies to session locks today. Inference; the
  nonzero-offset case was not executed.
- Observation (mine, pre-existing): `acquireSession` reads
  `<procDir>/<process.pid>/stat`; under an ancestor's /proc that is another
  process, so the lock records the wrong start time. RSK-003 family.


## PHASE-03 execution (2026-10-26)

Two pi runs (implement), $0.141 total: admission.test.ts from the spec (red:
module missing), then the moves. Suites unchanged but server.test.ts's import
line; new files lint 0/0; server.ts lint 13 → 9. Gate green, 466 tests.

What pi got wrong: named the step-8/probe function `runnable`/`launch`, not the
design's `checkLaunchable`, and decided recordability by testing
`reason === 'audit-unavailable'`; built Admitted inside the probe step; one
comment claimed tests replace /proc in serve. The test writer asserted "some
line" for steps 1-2, leaving double-recording unpinned. The T2 run used its
whole 60-request cap; split such moves in two next time.

Choices carried forward:
- readToolCall stays in server.ts (tools/call unwrapping; becomes dispatch by
  name later). readAgentRequest keeps its Record signature until PHASE-08.
- AdmissionContext is built per call in callTool from Context (startup is
  narrowed there); Context gained `procDir` ('/proc'). PHASE-06 adds
  `Context.admission` and `ServeOptions.procDir`.
- Startup/StartupFailure types moved to admission.ts so nothing imports
  server.ts.
- A throw inside admit after step 7 releases the session and reaches the
  tools/call catch arm as `server-error` (was failedResult('error')); the gate
  is built inside executeRun, after step 8.
- server passes a no-op onAudit; the registry wires it.

Mutation controls: 14 mutants, 13 killed; the survivor (recording the probe
refusal) is equivalent — the append targets the ledger that failed.

Codex pass (gpt-6.1-sol, high), 4 findings, all fixed in cb45a56:
- F1 admit released the session before recording a step-8 refusal (parent
  recorded first). Not test-pinned (in-process ordering).
- F2 executeRun built the gate outside its try (pre-existing shape), so it
  could reject; now inside.
- F3 tests ignored ledger detail and digest; now pinned.
- F4 no first-failure precedence; three competing-failure cases added.

