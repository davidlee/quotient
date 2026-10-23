# Notes SL-001: Measure peak request context for token ceilings

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-23 · ready · 7c44f09

### Produced

- SL-001 — design and initial plan in 551d87a; exact package measurement criterion in 0d9af3b; review alias in 7c44f09.
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

## Implementation authorization and next entry

The user approved the current plan after the 0d9af3b refinement: “yes, approve.
then pull up for handover”. This authorizes implementation from that plan in
the next context; the current context stops before code changes.

The next unit is PHASE-01. Read the plan and its runtime phase sheet through
the slice's `phases` symlink, then use the phase-plan and execute skills. Do not
reopen settled design choices or repeat plan approval absent new evidence or a
material plan change. Implementation and release checks are still unperformed.

## Environment for continuation

Shell calls require `PATH=/home/david/.local/share/doctrine/bin:"$PATH"` on each
command. An export in a separate tool shell does not persist. The absolute
Doctrine binary alone is insufficient for its internally spawned bare
`doctrine verify` command. The misleading verifier-launch error was reported
upstream by the user.

The pre-existing staged `.codex/config.toml` and `.gitignore` edits belong to
the user. Keep them out of task commits. No product source changes have been
made in this design/plan session.
