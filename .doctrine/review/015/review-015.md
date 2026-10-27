# Review RV-015 — reconciliation of SL-004

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Mode: conformance (self-audit; one agent drives raiser and responder). Surface:
the primary checkout at `main` b174831 (code = 6dc49d7); not dispatched.

Lines of attack:

1. **Path conformance.** `doctrine slice conformance 4` against the
   design-target selectors; every undeclared path, and commits outside any
   recorded phase delta (ceb2ce3, 4459ed8), which the registry cannot see.
2. **Verification evidence.** `just gate` (741/741, pack-check 4/4 at
   b174831), `slice verify-vt 4` (every VT of PHASE-01..10 passes),
   `tsc --noEmit` clean, eslint per file at or under the plan baselines
   (notes.md § Plan baselines).
3. **Design vs shipped.** Every divergence recorded during execution
   (notes.md D-1..D-16, contracts-follow-code items, sec-5/sec-7 internal
   drift) carried to a reconcile write surface.
4. **Risks still hold.** design sec-9 "Risks and explicit limits" against the
   shipped behaviour, plus limits accepted during execution and not yet
   listed (PHASE-02 F1, PHASE-06 F1, M4, the EOF reply consequence,
   timing-margin tests).
5. **Open behaviour question.** `pi_agent_cancel` answers `timed_out: true`
   when a target is foreign or unreadable.
6. **Slice objective.** IMP-011's goal: write-capable runs overlap under a real
   client (PHASE-10 VH-1 evidence on IMP-011).

Invariants held: every terminal status is true and never changes (DEC-067,
DEC-068); canon (design.md, decisions) tells the truth about shipped code
after reconcile; plan criteria are immutable (no brief item edits plan.toml).


## Synthesis

**Closure story.** SL-004 shipped what it scoped: `pi_agent_start` /
`_wait` / `_ack` / `_cancel` beside blocking `pi_agent`, lanes, results on
disk, the 2026-07-28 protocol era with tasks, and the contracts and help to
match. The objective from IMP-011 holds under a real client: PHASE-10 VH-1
recorded write-capable runs overlapping for ~19.9 s of 20 under Claude Code
(evidence on IMP-011). Verification at b174831 (code = 6dc49d7): `just gate`
741/741 with pack-check 4/4; `slice verify-vt 4` passes every VT of
PHASE-01..10; `tsc --noEmit` clean; eslint per file at or under the plan
baselines (server.ts 7, server.test 28, test-rig 27, help.ts 11, reduce.ts
124; new modules 0). Every phase also had an independent Codex pass and
mutation controls (notes.md § PHASE-0N execution).

**What the audit found.** No code defect. The gap is canon lagging code:
two accepted decisions (DEC-067 timens, DEC-068 unreadable) and design
sections 2/3/5/6/7/9 describe the pre-execution shape. Each divergence was
recorded with its reason and assent as it happened, so reconcile has an
exact list (F-4..F-9). Conformance's undeclared paths are a stale selector
registry (F-1) plus two between-phase commits the delta registry cannot see
(F-2, tolerated).

**Standing risks** (after reconcile, all named in sec-9): no bound on runs
in flight (IDE-005); liveness across hosts that share a hostname (RSK-003);
EOF cancels runs in flight and a client that closes stdin at once may lose
replies (IDE-006); a wait's reaction on a live run is held until it settles;
two timing-margin tests (tasks/cancel before end; 1.5 s grace); the
2026-07-28 wire is new (EVD-004), confined to protocol.ts.

**Tradeoffs consciously accepted.** Cancel's `timed_out: true` over a
foreign or unreadable target (user, this audit: keep, document). Research
baseline left drifted rather than falsely restamped (F-10). Between-phase
commits left unattributed (F-2).

## Reconciliation Brief

### Per-slice (direct edit)

- **Selector registry (F-1, load-bearing):** `doctrine slice selector add 4`
  design-target: `src/reduce/reduce.ts`, `src/reduce/reduce.test.ts`,
  `src/reduce/cli.ts`, `src/server/profiles.test.ts`,
  `src/server/result.test.ts`, `src/json.ts`.
- **design.md sec-9 Code impact (F-1):** rows for reduce.ts (EMPTY_STATUS,
  DEFAULT_BUDGET_BYTES), cli.ts, src/json.ts (shared isRecord); the "not
  changed" sentence drops policy.ts and approvals.ts (isRecord import) and
  the reducer sentence names the two additions.
- **design.md sec-3 / sec-7 / sec-9 (F-4, D-1):** owner identity gains
  `timens`; ownerLiveness rule (any null → unknown; differing timens, same
  host and boot → unknown; different boot → stale). sec-3 Start step 4 and
  the ownerLiveness bullet; sec-7 session.ts; sec-9 fakeProc, session.test,
  views.test bullets.
- **design.md sec-3 / sec-7 / sec-9 (F-5, D-5):** flowchart: result absent +
  audit unreadable → unreadable; directory stat failing other than absence →
  unreadable; a file at the run's path → unknown; torn audit without
  `admitted` → foreign. Also the "lost requires positive evidence" bullet,
  sec-7 views.ts prose, sec-9 views.test bullet.
- **design.md sec-5 / sec-7 (F-6):** type blocks and prose for D-2
  (AdmissionContext.here), D-3 (matchKey, start refuses while closing,
  dropped launch, AckEntry in runs.ts), D-4 (`here` on viewFromDisk /
  resolveRun and waiting.ts resolve closures), D-6 (Context.admission union;
  Context.here), D-7 (runCall handler `(signal) => Answer`), D-9 (HANDLERS
  `(args, call, context)` + `admitting`), D-12 (discoverResult(instructions,
  serverInfo)), D-13 (runCall `present` inside the reply gate); sec-5
  awaitTargets aligned to sec-7's Promise<void> with reread/pollMs.
- **design.md sec-2 / sec-3 / sec-5 / sec-7 (F-7):** D-10 (a refused wait
  appends its attempts line); D-14 (legacy id-bearing notifications/* stay
  notifications; modern → -32601); D-15 (disk-resolved id with no record
  acks `unknown`); D-16 (loop pseudocode: named waits, no ack each pass);
  contract-follows-code items listed in F-7.
- **design.md sec-9 Risks (F-8):** add equal-hostname false-lost (RSK-003),
  retained wait reactions, EOF reply loss / cancellation (IDE-006), M4 pinned
  only at runs.test level, timing-margin tests; extend the session-lock
  bullet (timens; non-positive-pid lock fail-closed).
- **design.md sec-6 step 5 (F-9):** a cancel answer reports `timed_out:
  true` exactly when a target is foreign or unreadable.

### Governance/spec (REV)

- **DEC-067 (F-4):** amend the identity tuple and rule for `timens`. A
  knowledge record, not a spec: amend via `/knowledge` (decided_by user;
  basis: user, 2026-10-26, "record the divergence now and amend the design
  in reconcile").
- **DEC-068 (F-5):** amend `unreadable` to cover an unreadable audit (result
  absent) and a failed directory stat; via `/knowledge` (basis: user assent
  2026-10-27, notes.md D-5).

No plan.toml item: D-8 and the D-1 plan text are recorded history in
notes.md; criteria ids stay immutable.
