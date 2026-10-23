# Notes SL-001: Measure peak request context for token ceilings

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-24 · PHASE-02 · 7a37daa

### Produced

- PHASE-02 — context enforcement, policy/2, status/3, result/2, active contracts and caller guidance; 328/328 suite, typecheck and build passed in 7a37daa.
- RV-003 — PHASE-02 code review concluded with no findings in 7a37daa.

### Learned

- mem.pattern.quotient.delegated-write-verification — verify delegated writes in the shared tree before relying on a worker report; use the authorized fallback after refusal or no-op.
- RV-001 F-1 — installed-package verification uses a clone of committed HEAD.
- RV-001 F-3 — accounting and context gap counters overlap rather than partition requests.

### Open

- ASM-001 — launched-pi normalization and resumed-event compatibility.
- CON-001 — version 0.2.0 release requirement.

## Further review

PHASE-02 establishes reducer arithmetic, enforcement, audit-prefix behavior and
contract migration with source and fixture evidence; it does not establish
launched-pi normalization or resumed-session event shape. Preserve that limit
under ASM-001. PHASE-03 still owns the committed 0.2.0 package metadata and
installed-package verification.

## Release sequencing

User instruction during design: remind the user to run `npm publish` for
version 0.2.0 after audit and before reconciliation. At that boundary, give
the reminder and wait for the user's publication outcome before proceeding
to reconciliation. The user owns publication; this is not authorization for
the agent to publish.

## Implementation authorization and next entry

The user approved the current plan after the 0d9af3b refinement: “yes, approve.
then pull up for handover”. PHASE-01 is committed in 1f0ac6a and PHASE-02 in
7a37daa.

The next unit is PHASE-03. Expand its runtime sheet from the approved plan and
design release section, then use phase-plan and execute. Preserve the settled
decisions absent new evidence or a material plan change. The 0.2.0 publication
checkpoint, audit, and reconciliation remain ahead.

## Environment for continuation

In this environment, `command -v doctrine` resolves to
`/home/david/.local/bin/doctrine`, a symlink to
`/home/david/.local/share/doctrine/bin/doctrine`. Bare `doctrine` commands work
from the primary checkout.

This checkout has no `just gate` or `just prove` recipe, so Doctrine's gate/prove
commands cannot run. PHASE-01 and PHASE-02 used direct suite, typecheck, and
build checks; they passed, but the Doctrine cadence gate is not claimed. The
PHASE-02 `doctrine check gate` attempt failed with `justfile does not contain
recipe 'gate'`.
