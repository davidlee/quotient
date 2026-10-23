# Notes SL-001: Measure peak request context for token ceilings

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-24 · audit · 45187c3

### Produced

- SL-001 — phases 01–03 committed in 1f0ac6a, 7a37daa and 61fd1a9; installed 0.2.0 pack-check passed on the candidate HEAD.
- RV-005 — conformance audit; F-1/F-2 and their design/selector reconciliation brief.

### Learned

- mem.pattern.quotient.delegated-write-verification — verify delegated writes in the shared tree before relying on a worker report; use the authorized fallback after refusal or no-op.
- RV-001 F-1 — installed-package verification uses a clone of committed HEAD.
- RV-001 F-3 — accounting and context gap counters overlap rather than partition requests.

### Open

- ASM-001 — launched-pi normalization and resumed-event compatibility.

## Further review

The audit confirmed the installed stub package passed the committed 0.2.0 gate,
including result/2, status/3, peak 16 and zero context gaps. This does not
establish real-form confinement, launched-pi normalization or resumed-session
event shape. The hostile-audit and live pi/provider/session probes remain
unperformed because their real form/model/provider and supported-runtime trace
prerequisites were not supplied. Preserve those limits under ASM-001 through
reconciliation.

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

All three implementation phases and the slice audit are complete. Before
reconciliation, remind the user to run `npm publish` for 0.2.0 and wait for their
publication outcome. Do not enter reconciliation until the user reports it.

## Environment for continuation

In this environment, `command -v doctrine` resolves to
`/home/david/.local/bin/doctrine`, a symlink to
`/home/david/.local/share/doctrine/bin/doctrine`. Bare `doctrine` commands work
from the primary checkout.

This checkout has no `just gate` or `just prove` recipe, so Doctrine's gate/prove
commands cannot run. Direct full-suite, typecheck, build, script syntax, package
dry-run, and installed-pack checks passed, but the Doctrine cadence gate is not
claimed. `doctrine check gate` failed with `justfile does not contain recipe
'gate'`. The default `/home/david/.npm` cache was read-only in the sandbox; the
pre-PHASE-02 regression pack-check used `/tmp/quotient-phase03-npm-cache`.
