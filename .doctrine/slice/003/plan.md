# Implementation Plan SL-003: Optional jail.nix form builder

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. Use this for the plan's rationale and sequencing.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

Five phases, each ending with `just gate` green. The first is hygiene and
IMP-007 and adds no mechanism. The next two build the builder, proven by
behaviour. The fourth writes the text check against launchers that already
exist. The last is documentation and the real-pi audit.

```text
PHASE-01  drift scan + nix-build      src/drift.test.ts, flake.nix comment, justfile     ← DEC-116 citation is the red
PHASE-02  core family + probe         nix/form-family.nix (required args), nix/checks,    ← rendering recorded; F-5, F-6
                                      scripts/form-probe, lib.mkFormFamily
PHASE-03  caller arguments            every sec-2 argument; full probe family             ← F-2, F-3/F-14
PHASE-04  checkFormFamily             nix/check.sh, nix/check-family.nix, controls        ← F-1, F-4, F-13
PHASE-05  docs + real-pi audit        docs/nix-forms.md, README, setup, policy-2 (VH)
```

## Sequencing & Rationale

- **PHASE-01 stands alone.** Extending the doctrine-id scan to `flake.nix`
  fails at once on the existing DEC-116 comment, which gives the phase its
  red. The `nix-build` recipe (IMP-007) is independent of the builder and
  protects every later phase from a stale `npmDepsHash`.
- **Behaviour before text.** The design's check reads positions in jail.nix's
  rendered bwrap line, and no launcher has been built yet (slice notes,
  Further review). So the builder comes first, its rendering is recorded
  (PHASE-02 EX-6), and the check is written in PHASE-04 against launchers that
  exist. The probe is the builder's test: each row is written red before the
  builder code that makes it pass.
- **Core, then caller arguments.** PHASE-02 fixes what the builder guarantees
  (form script, tail, empty-environment bwrap) with only the required
  arguments. PHASE-03 adds what callers compose. A failure in PHASE-03 then
  points at the argument just added, not at the tail.
- **The check last among code phases.** Its negative controls are made either
  through the real builder or by `doctor` editing a built family. Both need
  the full builder.
- **Docs last.** `docs/nix-forms.md` describes the arguments and guarantees as
  built. The VH audit needs a real pi and a model, so it sits outside the gate.

## Routed design-review findings

RV-010's routed findings are transcribed into criteria, cited inline:

| finding | route | where |
|---|---|---|
| F-5 LANG/TERM override, HOME precondition | demonstrate | PHASE-02 EX-4 |
| F-6 G7 is the form's parent | control | PHASE-02 EX-8 |
| F-2 missing protect path under a read-only bind | probe | PHASE-03 EX-7 |
| F-3 / F-14 exposure inside the root | probe | PHASE-03 EX-7 |
| F-1 no secret fd in a secret-less family | control | PHASE-04 EX-4 |
| F-13 mask declaration shape | control | PHASE-04 EX-4 |
| F-4 bind after the session bind | control | PHASE-04 EX-5 |

F-17 (route review) was settled in the design.

## Risks carried into execution

- **Rendering differs from sec-2.** PHASE-02 EX-6 stops for `/consult` before
  anything relies on the order.
- **The bwrap line's shape is unverified.** jail.nix renders the launch as
  `${state.runtime}` then `exec ${state.cmd} "${RUNTIME_ARGS[@]}" -- <entry>`
  (`lib/jail.nix:96-110`). Whether `state.cmd` puts every bwrap argument on
  that one line, as check.sh's "the bwrap line" assumes, is what PHASE-02 EX-6
  records. Caller `add-runtime` code precedes the builder's deferred runtime
  in `state.runtime`, which the single-assignment invariants rely on.
- **jail.nix runs bwrap under a trap** when cleanup hooks exist
  (`lib/jail.nix:91-115`). The form would then not `exec` down to bwrap, and
  G7's parent argument would fail. EX-6 checks that the launcher execs bwrap,
  and check (b) refuses a launcher that does not.
- **The gate needs Linux, Nix, bwrap and user namespaces** (DEC-022). This
  host has all four (Lix 2.95.4, `unshare -U` succeeds).
- **New files are invisible to flake evaluation until `git add`ed.**

## Notes

- `lint` stays outside `gate` (IMP-002); each phase runs it on touched files.
- IMP-003's selection-gap answer is recorded at close, not in a phase.

## Amendment: RV-011 (PHASE-06..PHASE-08)

The audit's independent pass (RV-011) found the check accepting non-conformant
families built from ordinary arguments, and refusing valid ones. The operator
chose to fix inside the slice (option A) and agreed DEC-029..DEC-037.

Order and boundaries:

- **PHASE-06, the check first.** The parser change (DEC-029) moves every
  bwrap-line rule onto a new argv, so it lands before anything that adds rules
  on top of it. DEC-030 and DEC-031 are rules over that argv. The full fixture
  corpus is the regression net: a pre-existing verdict that flips is recorded,
  not silently re-expected.
- **PHASE-07, the builder.** Its refusals happen at evaluation, so they need a
  second kind of case (tryEval) beside the check-fixtures table. The piFiles move
  (DEC-032) changes the tail's shape, and with it the check's tail-order rule,
  which is why it follows PHASE-06.
- **PHASE-08, the docs last,** because they describe what PHASE-06/07 built, and
  their examples become fixtures the gate builds (DEC-037).

After PHASE-08 the audit (RV-011) resumes: the gate, a Codex re-review of the
check and builder, verification of F-2, F-4, F-5 and F-7..F-15, then the
reconciliation brief. design.md is not edited here; reconcile folds
DEC-023..DEC-037 in.

Risks:

- **The restricted shell's limits** (DEC-029): `bash -r` refuses output
  redirection and commands containing `/`, but builtins still run. The
  `declare -f` gate, which admits one simple `set` command only, is what makes
  the call safe; a fixture per refused shape keeps it honest.
- **Verdict churn.** Fixtures written against the normalised text may change
  verdict for the right reason. EX-3 makes each change explicit.
- **tryEval does not capture messages.** `builtins.tryEval` reports only failure
  for a `throw`; checking the message may need a build-time `nix eval` in a
  check or an `assert` with a known message shape. The phase sheet records the
  mechanism chosen.
