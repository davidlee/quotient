# Notes SL-001: Measure peak request context for token ceilings

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-23 · PHASE-01 · 1f0ac6a

### Produced

- SL-001 — design and initial plan in 551d87a; exact package measurement criterion in 0d9af3b; review alias in 7c44f09.
- RV-001 — external quotient/pi design review and focused repair recheck.
- SL-001 — plan approval and continuation instructions in 7f05b91.
- PHASE-01 — internal context tally, tests, and RV-002 code review in 1f0ac6a.

### Learned

- RV-001 F-1 — installed-package verification uses a clone of committed HEAD.
- RV-001 F-3 — accounting and context gap counters overlap rather than partition requests.

### Open

- ASM-001 — launched-pi normalization and resumed-event compatibility.
- CON-001 — version 0.2.0 release requirement.
- DEC-001 through DEC-006 — governing measurement, migration and accounting choices.

## Further review

PHASE-01 establishes reducer arithmetic with fixtures; it does not establish
launched-pi normalization or resumed-session event shape. The later
implementation phases and audit must preserve that limit under ASM-001. The
remaining implementation and release evidence includes independent cost/context
validity, buffered shutdown accounting, and the installed 0.2.0 package.

## Release sequencing

User instruction during design: remind the user to run `npm publish` for
version 0.2.0 after audit and before reconciliation. At that boundary, give
the reminder and wait for the user's publication outcome before proceeding
to reconciliation. The user owns publication; this is not authorization for
the agent to publish.

## Implementation authorization and next entry

The user approved the current plan after the 0d9af3b refinement: “yes, approve.
then pull up for handover”. PHASE-01 is implemented and committed in 1f0ac6a.

The next unit is PHASE-02. Expand its runtime sheet from the approved plan and
design sections 2-4, then use phase-plan and execute. Preserve the settled
decisions absent new evidence or a material plan change. PHASE-03's package
verification, the 0.2.0 publication checkpoint, audit, and reconciliation remain
ahead.

## Environment for continuation

In this environment, `command -v doctrine` resolves to
`/home/david/.local/bin/doctrine`, a symlink to
`/home/david/.local/share/doctrine/bin/doctrine`. Bare `doctrine` commands work
from the primary checkout.

This checkout has no `just gate` or `just prove` recipe, so Doctrine's gate/prove
commands cannot run. PHASE-01 used the direct suite, typecheck, and build checks;
they passed, but the Doctrine cadence gate is not claimed. The user's earlier
`.codex/config.toml` and `.gitignore` changes were committed separately from the
phase code.
