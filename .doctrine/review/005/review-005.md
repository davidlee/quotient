# Review RV-005 — reconciliation of SL-001

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Conformance audit of all three committed phases against the locked design,
approved plan and DEC-001..DEC-006/CON-001. Verify reducer classification and
independent cost/context arithmetic, gate and audit-prefix behavior, policy /2
and result/status schema migration, every active contract/help/example, version
ownership, committed installed-package evidence, and the explicit unperformed
runtime probes. Disposition each conformance candidate rather than treating its
path list as a verdict. Identify any reconciliation work on the design or
selector registry; preserve plan criteria and the user-owned publish boundary.

## Synthesis

### Overall

acceptable

### Synopsis

The implementation follows the accepted split: the reducer owns each request's
context footprint and independent cost/token observations; the gate compares
the shared peak under the admission snapshot; status /3 and result /2 disclose
measurement gaps; policy /2 requires an explicit context threshold. The 328-test
suite, typecheck, build, script syntax checks and package dry run passed. The
installed tarball from commit `61fd1a9513fb7904e5e1b82a1fbce3c81e851a4b`
passed all four pack-check checks, including a 16-token peak and zero context
gaps. Source and stub tests establish quotient behavior, not real provider
normalization, resumed-session event shape or real-form confinement; those
probes remain unperformed under ASM-001. The Doctrine gate remains unavailable
because this checkout has no `just gate` recipe.

The conformance ledger's phase-review files and slice lifecycle TOML are
expected Doctrine process outputs. Four active policy-reference documents were
changed outside the declared design-target set, and `src/root.test.ts` was
overdeclared as a change target despite its existing source/build version tests.
These are design/selector reconciliation items, not implementation defects.

The reducer, gate, policy contract and emitted result are the route through the
behavior: reducer tests cover cost/context gaps and overlap; fake-child tests
show that the abort record retains the crossing prefix while the final peak can
rise during drain; pack-check validates the installed 0.2.0 stub path. DEC-006
defines independent cost/context validity (`doctrine knowledge inspect
DEC-006`); CON-001 owns the 0.2.0 release requirement (`doctrine knowledge
inspect CON-001`); RV-001 F-1 requires pack-check against committed HEAD
(`doctrine review show RV-001 -f F-1`). The user-owned publish checkpoint remains
after this audit and before reconciliation.

### Haiku

Peak stops the stream
Buffered records lift the view
The publish waits still

## Reconciliation Brief

### Per-slice (direct edit)

- F-1 — `design.md` §4 code-impact table: include `docs/contract/form-1.md`
  and `examples/profiles/*.md` as active policy-reference documentation; add
  verification text that current policy references track policy/2.
- F-2 — `design.md` §4 verification-test row: remove `src/root.test.ts` from
  paths expected to change, or identify it explicitly as existing evidence that
  was inspected without modification. Preserve the approved phase criteria.

### Selector registry (load-bearing conformance correction)

- F-1 — `doctrine slice selector add 1 --intent design-target
  docs/contract/form-1.md examples/profiles/*.md`.
- F-2 — change the existing selector intent with
  `doctrine slice selector add 1 --intent scope-relevant src/root.test.ts`.

### Governance/spec (REV)

- None.

## Reconciliation Outcome

### Direct edits applied

- `design.md` §4 code-impact commitments: added `docs/contract/form-1.md` and
  `examples/profiles/*.md` as active policy-reference documentation, and added
  verification that active policy references track policy/2 (F-1).
- `design.md` §4 test commitments: removed `src/root.test.ts` from changed test
  targets and recorded its existing package-version coverage as inspected
  evidence (F-2).

### Selector registry

- F-1: added `docs/contract/form-1.md` and `examples/profiles/*.md` as
  `design-target` selectors.
- F-2: changed `src/root.test.ts` from `design-target` to `scope-relevant`.
  Conformance now reports 34 conformant paths and no undelivered selectors.
  Seven undeclared paths remain: the phase review outputs and slice lifecycle
  metadata, which the audit classified as expected Doctrine process outputs.

### Governance/spec (REV)

- None required.

Reconciliation complete; handoff to `/close`.
