# Notes SL-004: Concurrent runs: start and wait tools

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-27 · PHASE-09 completed; PHASE-10 next · 6faf117

### Produced
- design locked rev 79 (run dr-01a17694); plan 10 phases (38b2b07, 66c493b, 529846e) — history in git
- PHASE-01 done — evidence foundations, reducer guard, lane refusal reason (f9944c6; delta recorded); Codex pass 6 findings fixed; choices in § PHASE-01 execution
- PHASE-02 done — owner identity, ownerLiveness, shared fakeProc (9ccee47; delta recorded); Codex pass: 3 minor fixed, 2 major raised (§ PHASE-02 execution)
- PHASE-03 done — callTool extracted to tools/admission/execute/documents (656c57b, cb45a56; delta 9f4d8b1..cb45a56); Codex pass 4 minor fixed (§ PHASE-03 execution)
- PHASE-04 done — runs.ts registry, fakeLaunch, runs.test.ts (175442c, 032df24; delta 3060d07..032df24); Codex pass 1 high + 1 medium + 1 minor fixed (§ PHASE-04 execution)
- isRecord consolidated into src/json.ts (ceb2ce3; user request; outside phase range)
- PHASE-05 done — views.ts, documents.ts + suites (6322f83, fa36bf7, 4b48ddf; delta ceb2ce3..4b48ddf); Codex 2 high + 2 medium fixed (§ PHASE-05 execution)
- PHASE-06 done — waiting.ts + suite, shared run fixtures in test-rig (4e3fe68, b8f6950, e5c1b3b; delta e3fb817..e5c1b3b); Codex 3 medium (2 fixed, F1 accepted) + 1 low fixed (§ PHASE-06 execution)
- PHASE-07 done — blocking pi_agent through the registry; call driver + reply gate; EOF at the trigger (3095a6f, 70e02a4; delta 5d8e37c..70e02a4); Codex 1 medium fixed (§ PHASE-07 execution)
- PHASE-08 done — five tools, readers + argsDigest, start/wait/ack/cancel handlers, readmit, tool help sections, sleeper form (b1c9981; delta recorded); Codex 3 fixed + 1 contested (§ PHASE-08 execution)
- PHASE-09 done — protocol.ts (eras, server/discover, tasks/*), era routing, task-answering pi_agent, taskOf, modernLine (6bfb2f8, 6faf117; delta recorded); Codex 1 medium fixed (§ PHASE-09 execution)

### Learned
- mem.fact.doctrine.verify-vt-needs-record-delta — hand-committed phases need `slice record-delta` before verify-vt attributes them (f955e40)
- mem.fact.quotient.client-concurrency-readonlyhint — clients overlap calls only with readOnlyHint
- mem.fact.quotient.readable-end-before-dispatch — input `end` can precede dispatch of lines already read (70e02a4)
- mem.fact.quotient.symlink-root-test-vacuity — a roots entry equal to the admitted root follows the same symlink (b1c9981)
- EVD-001..004 — scheduling probe; Claude Code and Codex limits; 2026-07-28 + tasks wire format

### Open
- next: PHASE-10 (/phase-plan first)
- D-12..D-14 — discoverResult(instructions, serverInfo); runCall `present`; legacy id-bearing notifications stay notifications; /reconcile amends sec-7 (§ PHASE-09 execution)
- D-9..D-11 — HANDLERS shape, sec-5 refused-wait ledger line (Codex F1 contested), handle/wait/ack help sections to PHASE-10; /reconcile amends (§ PHASE-08 execution)
- M4 (at-trigger closing) accepted at runs.test level; closingRefusal unreachable through serve (C13) (§ PHASE-08 execution)
- open user decision (PHASE-07 close): a client that writes and closes stdin at once may get some or none of its replies — unanswered
- D-6 — Context.admission is `AdmissionContext | StartupFailure`; D-7 — runCall handler is `(signal) => Answer`; D-8 — EX-6's auditKinds(runDir, run) kept as auditKinds(layout) (C5); /reconcile amends (§ PHASE-07 execution)
- PHASE-06 drift — sec-5 `awaitTargets` returns Promise<boolean> vs sec-7 Promise<void>; code follows sec-7; /reconcile amends sec-5 (§ PHASE-06 execution)
- PHASE-06 F1 — wait reactions retained on live `settled` until settle; accepted (bounded); /reconcile: add to sec-9 Risks
- D-4 — `here` on viewFromDisk/resolveRun; D-5 — failed audit/dir read → `unreadable`; /reconcile amends (§ Divergences)
- D-2 — `here` on AdmissionContext; /reconcile amends sec-7 (§ Divergences)
- D-3 — matchKey in runs.ts; start refuses while closing; /reconcile amends sec-7 (§ Divergences)
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

- **D-3 runs.ts additions beyond sec-7's `Registry` (2026-10-27, PHASE-04).**
  Agent's choice; user assented 2026-10-27 ("agreed"), carry to /reconcile. (a) `matchKey(found,
  argsDigest)` exported from runs.ts: sec-7 puts the key lookup in server's
  `startRun` (before admission, which must not run for a reuse), yet sec-9
  lists "different arguments refuse" under runs.test.ts; the rule now has one
  pure home that `startRun` calls as `matchKey(registry.findKey(key), digest)`.
  `Registry` is unchanged. (b) After Codex F1: `start()` on a closing registry
  refuses `server-error` and releases the session, and a launch whose
  microtask fires after `closing()` is dropped (`dropped` record, `eof`)
  rather than launched. Sec-6 says the server admits no line after `closed`;
  this makes the registry hold that invariant itself, so `close()` never
  misses a record. (c) `AckEntry` lives in runs.ts (sec-7's documents.ts
  `ackDocument` will import it). Reconcile must amend: sec-7 `runs.ts` type
  block and its Publish/launch-guard prose; sec-9 Keys bullet.

- **D-4 `here` on viewFromDisk and resolveRun (2026-10-27, PHASE-05
  planning).** Agent's proposal; user assented 2026-10-27 ("agreed"). What
  diverges: sec-7 gives `viewFromDisk(runDir, run, procDir)` and
  `resolveRun(registry, runDir, procDir, run)`; code adds `here: HostIdentity`
  after `procDir` in both, because `ownerLiveness(procDir, here, owner)` needs
  the reader's identity, which sec-3 says is read once at start-up. Reading it
  per resolution would break that, and takes the hostname from the OS, so a
  fixture owner (`host-a`) could never be judged `stale`. Same reason as D-2.
  Reconcile must amend: sec-7 `views.ts` type block (and sec-7 `waiting.ts`'s
  `resolve` closures, which bind it).

- **D-5 a failed read of the audit or the run directory reads `unreadable`
  (2026-10-27, PHASE-05 Codex F1/F3).** Agent's proposal; user assented
  2026-10-27 ("agreed"). What diverges: sec-3's flowchart sends "result absent,
  audit unreadable" to `foreign`, and "no directory" to unknown for any stat
  failure. A published `lost` run whose audit then hits a transient read error
  would read `working` after `failed` (terminal status changed); an EIO on the
  directory would read unknown, which wait counts as done. Now: result absent +
  audit unreadable → `unreadable`; directory stat failing other than absence
  (paths.ts `absent`) → `unreadable`; a file at the run's path → unknown. A torn
  audit with no `admitted` record still reads `foreign` (it was read). Same
  rationale as DEC-068's amendment (a failed observation reports no status).
  EX-4's second case now fails only the `lost` append (fs.appendFileSync hook),
  so the audit stays readable and the run reads `foreign` with the owner's pid,
  as EX-4 states. Reconcile must amend: sec-3 flowchart + "lost requires
  positive evidence" bullet, sec-7 `views.ts` prose, sec-9 views.test bullet
  ("an audit that cannot be read → foreign"), DEC-068 (`unreadable` widens to
  the audit and the directory).

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

## PHASE-04 execution (2026-10-26/27)

Two pi runs (implement), $0.188 total. T1 wrote fakeLaunch and runs.test.ts
from the spec (red: ERR_MODULE_NOT_FOUND for runs.ts; recorded in the phase
sheet); T2 wrote runs.ts (17 requests, one write). runs.ts, runs.test.ts lint
0; test-rig.ts 27 (baseline); reduce.ts 125 (baseline). Gate green, 507 tests.

Choices (phase sheet C1–C7): EMPTY_STATUS moved to reduce.ts; matchKey (D-3);
ack with any malformed id applies none and answers `unknown` for all;
`queued` = launched outside the admitting start(); EX-4's depth measured as
stack frames at the release spy (launch runs in a microtask, release is
synchronous inside settle), no production hook; unwritable files made by
replacing the path with a non-empty directory (works as root). Private
functions live at module level over a RegistryState (max-lines-per-function);
advance's pending flag is a `due` Set of lanes plus one `advancing` flag.
`now` stays in createRegistry's deps unused (appendAudit/writeResult own the
clock).

What pi got wrong (T1): release-state 'running' for never-launched runs
(they are 'queued'); an updatedAt assertion contradicting "the result write
wins"; key tests driving start() with a duplicate key (contradicts C2); no
abort-reason assertions on cancel; stamps checked only on admitted/refused
records. Fixed by me before T2. T2 correctly reported my C6 was unachievable
for audit.jsonl (already a file); block() now replaces the path.

Mutation controls: 24 mutants. 22 killed. 2 survivors, both equivalent:
interleaving mark and ending in cancel (inside the registry a queued settle's
advance stops at the running head, and an abort settles only via the async
launch promise), and removing settle's terminal guard (no public path
re-settles a terminal record; kept as the design's exactly-once line).

Codex pass (gpt-6.1-sol, high), 3 findings, all fixed in 032df24:
- F1 high: closing() did not stop a launch already queued as a microtask (run
  left `running` with no ladder, close() hangs); a start after closing()
  escaped close()'s snapshot. Fixed per D-3(b); two tests.
- F2 medium: messageOf threw on an unprintable rejection value, so the run
  never settled. messageOf is total; one test.
- F3 minor: the double-settlement test re-resolved a settled promise. Now
  drives cancel() and close() on a terminal record.

## PHASE-05 execution (2026-10-27)

Pre-phase: ceb2ce3 (isRecord → src/json.ts, all nine copies incl. reduce's
isEventObject; user: "DRY that up"). Three pi runs (implement), ~$0.19 total:
views.test.ts ($0.087), documents.test.ts ($0.045, one gateway 500 → session
continued), views.ts + documents.ts ($0.058, 29 req). Reds recorded in the
phase sheet. Tests: views 31, documents 27.

What pi got wrong: views.test blocked result.json (unreadable) to simulate an
unwritable result, then called EX-4's foreign case a flowchart contradiction
and proposed reordering the flowchart — fixture fault; fixed with
blockResultWrite (blocks `.result.json.tmp`, result stays absent). Asserted
updatedAt === mtime (coarse fs clocks; now latest()). Missed resolveRun's
disk fall-through and the live-settled-unreadable case. documents.test leaked
a mkdtemp. views.ts read the audit before the first result read (reordered to
match the flowchart). documents.ts duplicated the "first fault" loop.

Mutation controls: 26 + 7 targeted mutants; all killed but two equivalents
(live non-settled record reading result.json — none exists while observable;
the settled-only result check — subsumed by the status agreement check).

Codex pass (gpt-6.1-sol, high), 4 findings:
- F1 high: published lost → transient audit EIO → foreign (working). D-5.
- F2 high: malformed owner (pid -1, 4242.5, garbage starttime, boot "")
  judged stale → lost. Fixed: session.ts parseRunOwner (shares isPid/
  isStartTime with the lock reader; a non-positive-pid lock is now an
  unreadable record, fail-closed).
- F3 medium: directory stat EIO → unknown. D-5.
- F4 medium: settled wait entry could contradict its result; STATUSES_OF
  duplicated the table. Fixed: one statusOf; agreementFault; isAgentResult
  moved to result.ts.
Gate green 563 at 6322f83; 565 at 412f01a (code = 4b48ddf). Delta ceb2ce3..4b48ddf; verify-vt VT-1, VT-2 pass; completed 2026-10-27.

## PHASE-06 execution (2026-10-27)

Four pi runs (implement), ~$0.18 total: T0 test-rig refactor ($0.050, 38 req),
T1 waiting.test.ts ($0.093 + $0.001 failed start), T3 waiting.ts ($0.039,
11 req). Red recorded in the phase sheet. Tests: waiting 28; evidence +1 case.

Pre-code refactor 4e3fe68 (T0): runs.test and views.test each carried
DEFAULT_START, startRun, tick, launchFor, registryFor, block and a result
reader; views.test's OWNER duplicated FIXTURE_OWNER. One copy each now lives
in test-rig.ts (counts 41/31 unchanged).

Choices C1–C13 (phase sheet extract; told to the user): timeout and budget
as pure functions of the request and the read maxima; the first-whole rule
passes to the first *readable* settled result; `truncated` only for a
readable result left out; no targets → condition holds; lanes lane by lane
via `implicit([lane])`. Design-internal drift for /reconcile: sec-5's inline
`awaitTargets(...): Promise<boolean>` vs sec-7's `Promise<void>` with
reread/pollMs; code follows sec-7 (timed_out from re-resolved states).

What pi got wrong: T1 — nothing wrong, but weak: a guard equal to the waits'
timeout (a timer-only awaitTargets passed), an order fixture that could not
tell named-first from lanes-first, unreadable never shown not-done in
awaitTargets, budget boundary slack. My brief had an unsatisfiable budget
case; pi split it and said so. T3 — duplicated the 'pi-agent-wait/1' literal
(the brief forbade touching documents.ts); I exported WAIT_SCHEMA instead.
Briefs in Claude's scratchpad are invisible to the pi sandbox: put them
under .doctrine/state.

Mutation controls: 26 + 7 mutants on waiting.ts; all killed after pinning
the budget boundary, abort-listener removal and the poll timer's lifecycle.

Codex pass (gpt-6.1-sol, high), 0 high, 3 medium, 1 low:
- F1 medium: each wait leaves a reaction on a live record's `settled`
  promise until the run settles. Accepted: bounded by the run's lifetime
  (wall_clock_s ceiling; a queued run waits only on bounded predecessors),
  small, released at settle; removable subscriptions would need a Registry
  API beyond sec-7.
- F2 medium: a done foreign target kept polling during a mixed wait; one
  interval per target. Fixed: one shared poller; a target leaves it on done.
- F3 medium: a conforming result nested too deep to re-serialise made
  waitEnvelope throw (constructed input). Fixed at the shared boundary:
  readResult reads it `unreadable` (evidence.ts).
- F4 low: UTF-8 byte accounting and exactly-once resolution unpinned. Fixed
  (tests).

Gate green 593 at e5c1b3b. Delta e3fb817..e5c1b3b; verify-vt VT-1, VT-2 pass; completed 2026-10-27.

## PHASE-07 execution (2026-10-27)

T1 red by an Opus subagent (~229k tokens; regression-net rewrites + new cases,
rig: resultJson, waitForResult, runOf, admittedCall, admissionContext); T2 review
and red (26 failing of 177); T3 green in-session; T4 mutation controls; T5 Codex.
Tests: 605 (593 at PHASE-06 + 12 new server cases).

Choices C1–C8 (phase sheet): launch = executeRun for a never-queued run; blocking
handler admitAndStart → document promise; cancel forwarded on abort reason
`cancelled` only; one call driver `runCall` exported with `abortNamed` for a
direct test of the catch arm; catch-arm detail "the server failed while handling
this call"; EOF closing at signal/end/error; runChild keeps the directory on a
failed spawn record; auditFailed says nothing was launched.

Divergences for /reconcile:
- D-6: sec-7 says Context gains `admission: AdmissionContext`; a start-up-refused
  server has no snapshot to build one from, so it is
  `AdmissionContext | StartupFailure` (narrowed by `'ok' in`).
- D-7: sec-7's handler shape is `(args, call: CallContext) => Answer`; runCall
  takes `(signal) => Answer` and the server closes over args. PHASE-08's HANDLERS
  table adapts at the call site.
- D-8: PHASE-07 EX-6 names `auditKinds(runDir, run)`; C5 kept the one existing
  `auditKinds(layout)` and callers pass `layoutFor(runDir, run)`.

Interim: `argsDigest: ''` for a blocking start (no key, so matchKey never reads
it); PHASE-08's tools.ts argsDigest replaces it.

Mutation controls (9 + 1): reply gate (silenced, closed), abortNamed silencing,
cancel forwarding, registry.close() awaited (killed by hang), runChild removeRun
all killed. Post-loop close survived → new case "an input destroyed without an
error" (destroy() emits neither end nor error). At-trigger closing (M4)
survives: nothing in PHASE-07 acts between trigger and loop unwind; PHASE-08's
lanes make it observable.

Codex pass (gpt-6.1-sol, high): 0 high, 1 medium, 0 low.
- F1 medium: records already read were still dispatched after the trigger
  (ping replies after EOF; a buffered tools/call admitted, then a closing
  refusal with no ledger line). Verified by probe. Fixed 70e02a4:
  dispatchLines stops once closed (design sec-6 step 1). Proven via the signal
  path; an EOF-ordering case passed vacuously (whether `end` precedes a
  buffered line is environment-timed) and was dropped. Consequence: a client
  that writes and closes stdin at once may get some or none of its replies.

Sharp edge: a Readable's `end` event can fire before the async-iterator
consumer has dispatched the chunk it already yielded — "observed at `end`" is
earlier than "the reader reached EOF".

Lint (HEAD → after): server.ts 9 → 7 (serve's complexity error gone),
server.test 32 → 31, spawn.test 38 → 34, test-rig 27 → 27, spawn.ts 20 → 20.
Gate at 70e02a4: 605/605, pack-check 4/4. VT-1..3 pass; VA-1 grep: removeRun's
one call is runs.ts publishFailed.

## PHASE-08 execution (2026-10-27)

Red by two parallel Opus subagents (pure suites: tools/admission/help; server
suite + rig: start/wait/ack/cancel lines, envelopeDocument/refusalDocument,
sleeper form named by its prompt, released by a renamed file). Green: an Opus
subagent took tools.ts, readmit and the four help sections; server.ts in-session.
Tests: 672 (605 at PHASE-07). Commit b1c9981.

Choices C1–C14 (phase sheet), the ones that fill gaps in the design text:
- C4: on a start-up-refused server every call that is not wait/ack/cancel by
  name — malformed params and unknown names included — answers profile-invalid
  before its request is read.
- C5: Context gains `here` read at start-up whatever start-up's verdict
  (wait/ack/cancel resolve disk runs on a refused server).
- C9: readmit keeps the admitted runDir (the run is published there; execute.ts
  feeds it to the child env and the audit-failed line). A refusal authorise
  decides is recorded in the current policy's run dir, as admit's are.
- C11: a refused server's wait/ack/cancel descriptions are their built-in
  sections (loadHelp([])), since the operator layers may be what failed; the
  pi_agent/start descriptions and the agent instructions name the refusal.
- Asked.ceilings is `(maxima) => …` (readmit's per-unit min needs the policy
  read inside authorise); Asked.exact asks for the canonical-identity check.

Divergences for /reconcile:
- D-9: sec-7 HANDLERS is `(args, call: CallContext)`; implemented as
  `(args, call, context)` with an `admitting(handler)` wrapper for the two
  starting tools (the start-up check before the request is read).
- D-10: sec-5 "changes no state anyone can observe" — a refused wait still
  appends its attempts line (every refusal is recorded where decided). Codex F1,
  contested; the text should say so.
- D-11: help sections `handle`, `wait`, `ack` (sec-8) not added — PHASE-10 with
  the contracts (EX-3 says so).

Mutation controls (11): readmit when queued, needs_success, cancel marking, key
replay, refused server serving, exact root, ceiling and budget narrowing, lane
— killed. Survivors fixed with new assertions: a wait that acknowledges (the
listing must read the same twice); a wait that ignores its call signal (new
case: EOF ends a wait on a foreign run at once, timeout 30 s). M4 (at-trigger
closing) not provable through serve — the only head that settles after the
trigger is one EOF aborts, and close() drops the successor in the same sweep;
covered at runs.test level; accepted.

Codex pass (gpt-6.1-sol, high): 0 high, 3 medium, 2 low.
- F1 contested (D-10). F2 fixed: readmit widened a reducer-default budget to a
  later policy maximum; now clamps `admitted ?? DEFAULT_BUDGET_BYTES` (constant
  now exported by reduce.ts, used by reduce + cli). F3 fixed: `ceilings: {}`
  digests as none. F4 fixed: a root moved behind a symlink to outside the roots
  refused root-not-allowlisted; the exact check now runs before the allowlist.
  F5 fixed: the wall-clock case gains an enforcement control (state `timeout`).

Sharp edge: a symlink test whose roots entry IS the admitted root passes
vacuously — the entry canonicalises through the same symlink. Admit a
subdirectory of the entry.

Lint (PHASE-07 → after): server.ts 7 → 7, server.test 31 → 28, test-rig 27 → 27,
help.ts 12 → 11, reduce.ts 125 → 124, tools.ts/admission.ts and new tests 0.

## PHASE-09 execution (2026-10-27)

Red by two parallel Opus subagents (pure: protocol.test.ts + documents taskOf
case; server: modernLine/modernAnswer/rpcError in test-rig, "protocol:" and
"tasks:" groups incl. the one-write CreateTaskResult + notifications/cancelled
case). Green in-session; protocol.ts adapted from T1a's scratch self-check
implementation. Tests: 738 (672 at PHASE-08). Commits 6bfb2f8, 6faf117.

Choices C1–C14 (phase sheet), the ones that fill gaps in the design text:
- C4: one Task serialiser — documents.ts `Task` type + `taskOf(view)`;
  `RunDocument = Task & extras`. CreateTaskResult is flat (Task fields beside
  `resultType`), per sec-2's example.
- C6: tasks/get answers -32603 for any settled run whose document cannot be
  read (whatever its status), and for `unreadable`.
- C7: tasks/cancel calls cancel only for queued/running views.
- C9: runCall gains `present` (legacy as-is, modern decorated) applied inside the
  one reply gate, so the server-error refusal is decorated too; a task answer is
  a `{ task }` value, so it is written before the next line is read.
- C10: a record settled at placement (lane-predecessor-failed) still answers a
  task, with its terminal status: the run exists.
- Error messages and the absence of `data` on -32602/-32603 are pinned by tests
  (T1a's reading of C1/C5/C6); modern tools/list keys are exactly
  {tools, resultType, ttlMs, cacheScope}.

Divergences for /reconcile:
- D-12: sec-7 `discoverResult(instructions)`; implemented
  `discoverResult(instructions, serverInfo)` — protocol.ts may not import
  server.ts (SERVER_NAME) and stays pure.
- D-13: sec-7 says modern results "go through modernResult"; the mechanism is a
  `present` step on runCall (default as-is) — sec-7 server.ts should name it.
- D-14: sec-7 routes "every request with an id" through classifyEra (Codex
  F1, fixed). The design is silent on a legacy message named notifications/*
  that carries an id: it stays a notification (no reply; cancelled still
  cancels), as before; a modern one is -32601.

Mutation controls (11): era order, declaresTasks, modern undecorated, cancel on
terminal runs, CreateTaskResult deferred one tick (killed by the one-write
case), LIST_CACHE, legacy decorated, tasks/cancel no-op, createdAt, legacy
id-bearing notification arm — killed. Equivalent survivor: wiring the blocking
abort→cancel listener on the task arm — the call deregisters when its value is
answered, before the next line, so no notification can reach it (the property
sec-6 relies on). Accepted.

Codex pass (gpt-6.1-sol, high): 1 medium. F1 fixed (6faf117): id-bearing
notifications/* were dispatched before classifyEra, so one with an unknown
version could cancel a call; now only messages without an id are
notifications. Weak spot kept: the tasks/cancel-before-end case rests on a
TERM-ignoring sleeper and a 1.5 s grace margin.
