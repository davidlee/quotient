# Notes SL-001: Measure peak request context for token ceilings

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-24 · done · b2eb34c

### Produced

- SL-001 — phases 01–03 committed in 1f0ac6a, 7a37daa and 61fd1a9; installed 0.2.0 pack-check passed on the candidate HEAD.
- RV-005 — F-1/F-2 reconciled in design §4 and the selector registry; 34 conformant paths and no undelivered selectors.
- 0.2.0 — user confirmed the published npm package and global install; npm reports `latest` at 0.2.0.
- Gate — root `justfile` committed at 939b93c; user reports `just gate` green, clearing the close pre-check.
- SL-001 — reconciled and closed after the audit ledger concluded and all three implementation phases completed.

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

All three implementation phases, audit, reconciliation and lifecycle closure
are complete. The user-owned npm publication checkpoint was completed before
reconciliation; the package registry and global install both reported 0.2.0.

## Environment for continuation

In this environment, `command -v doctrine` resolves to
`/home/david/.local/bin/doctrine`, a symlink to
`/home/david/.local/share/doctrine/bin/doctrine`. Bare `doctrine` commands work
from the primary checkout.

The audit originally ran before a repository `gate` recipe existed; the user
later added and committed the root `justfile`, then reported `just gate` green.
This close relies on that reported result and does not rerun the gate. The
default `/home/david/.npm` cache was read-only in the sandbox; the pre-PHASE-02
regression pack-check used `/tmp/quotient-phase03-npm-cache`.
