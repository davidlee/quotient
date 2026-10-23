# Notes SL-001: Measure peak request context for token ceilings

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-23 · plan · 551d87a

### Produced

- SL-001 — design, review and initial plan captured in 551d87a; plan verification refined afterward.
- RV-001 — external quotient/pi design review and focused repair recheck.

### Learned

- RV-001 F-1 — installed-package verification uses a clone of committed HEAD.
- RV-001 F-3 — accounting and context gap counters overlap rather than partition requests.

### Open

- ASM-001 — launched-pi normalization and resumed-event compatibility.
- CON-001 — version 0.2.0 release requirement.
- DEC-001 through DEC-006 — governing measurement, migration and accounting choices.

## Further review

After the external review and focused recheck, no additional broad design pass
is needed for the repaired prose. A further targeted pass would examine the
implementation's independent validity paths, buffered shutdown accounting and
the installed 0.2.0 package. Those are implementation/audit evidence, not
design-text checks. Exact supported-runtime resume and normalization claims
remain bounded by ASM-001.

## Release sequencing

User instruction during design: remind the user to run `npm publish` for
version 0.2.0 after audit and before reconciliation. At that boundary, give
the reminder and wait for the user's publication outcome before proceeding
to reconciliation. The user owns publication; this is not authorization for
the agent to publish.
