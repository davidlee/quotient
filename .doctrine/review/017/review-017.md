# Review RV-017 — reconciliation of SL-005

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Conformance audit of SL-005 (lint burn-down) in the primary tree, against
design.md sec-2 D1–D5, plan.toml EX/VT criteria, and SPEC-002/003 plus
docs/contract for behaviour the refactors touched. Subject: working tree at
a902e77 + delta, then commit b2c183b.

Lines of attack:
- VT: `just lint` exits 0; `just gate` includes lint and is green; test count
  ≥ 741 (observed 748).
- D4 diff scan of added lines in src/: new `as`, non-null `!`, `any`,
  `eslint-disable`.
- Behaviour: every divergence notes.md records, checked against specs and
  contracts; the regression the differential review caught, and its pin.
- Mechanics: `slice conformance`, phase tracking, IMP-002 status.

## Synthesis

The slice delivered what it set out to: `npx eslint .` reports 0 (526 on the
main tree before), `lint` is the first prerequisite of `just gate`, the gate
is green at b2c183b with 748 tests (start 741), and IMP-002 is resolved.

D1–D3 held. The added-line scan finds one `eslint-disable-next-line`
(result.test.ts, one rule, reason given: a forged `LatchCause[]` the type
cannot hold), one `as unknown as` beneath it, no new `any`, no non-null `!`.
Untyped sources were fixed at the source: `at`/`isMember` in src/json.ts and
contract-validated parsers in the test rig, so tests now check the result
contract on every read — a net gain in drift detection. One `messageOf`
(src/errors.ts) replaces 3 copies and 9 inline sites.

D4's ratchet and gate held each phase, but the gate alone was not enough:
the policy.ts split reordered checks and changed a refusal reason, invisible
to the suite and caught only by the differential review (old vs new code on
the same inputs). That fix is pinned by a test. The reduce.ts rewrite showed
0 mismatches over ~500k differential cases.

Findings: F-1 (plan.toml lost PHASE-01's table header) fixed in the audit;
F-2 (design claims no behaviour change; deliberate out-of-contract
divergences exist) and F-3 (selector registry under-declares top-level
src files) go to reconcile; F-4 (one shared delta range with knowledge paths)
tolerated.

Standing risks:
- The deliberate divergences are only differential-reviewed, not all pinned
  by tests (policy order is; JSON-RPC null id, bindingOf, reduce block skip
  are covered by the reviews named in notes.md). Low impact: each is on input
  the system never produces.
- pack-check verifies committed HEAD by design (scripts/pack-check header),
  so a gate run on an uncommitted tree pack-checks the previous commit. The
  gate was re-run after commit.

Tradeoffs accepted: stricter handling of out-of-contract inputs over strict
behavioural identity; one commit for five phases (F-4).

## Reconciliation Brief

### Per-slice (direct edit)
- F-2 — design.md sec-2 D4 and slice-005.md Scope ("No behaviour change"):
  restate as "no behaviour change on inputs the system produces;
  out-of-contract inputs may become stricter or total, each listed in
  notes.md and differential-reviewed against the previous commit".
- F-3 — selector registry (load-bearing, read by `slice conformance`):
  `doctrine slice selector add` design-target `src/*.ts`;
  `doctrine slice selector rm` `src/server/test-rig.ts` (subsumed by
  `src/server/**`). design.md has no selector mirror section to update.

### Governance/spec (REV)
- None. No spec or contract is contradicted (F-2 checked SPEC-002, SPEC-003,
  docs/contract pi-agent-result-2 step 7, JSON-RPC 2.0 id rules).

## Reconciliation Outcome

User agreed the edits in-session ("agreed").

### Direct edits applied
- slice-005.md Scope: "No behaviour change" restated as no change on inputs
  the system produces; out-of-contract divergences allowed when listed in
  notes.md and differential-reviewed (F-2).
- design.md sec-2 D4: same rule appended (F-2).
- Selector registry (F-3): added design-target `src/*.ts`; removed
  `src/server/test-rig.ts` (subsumed by `src/server/**`) and, by the same
  rule, `src/json.ts` (subsumed by `src/*.ts`, surfaced once the first two
  landed). `slice conformance 5`: 37 conformant, 0 undelivered; the 16
  undeclared are .doctrine records (F-4).

### REVs completed
- None; the brief had no governance/spec items.

### Withdrawn / tolerated
- F-4: tolerated — single shared phase delta including knowledge paths;
  rationale in the finding disposition.
- F-1: fixed in the audit (plan.toml header).

Reconcile pass complete — handoff to /close.
