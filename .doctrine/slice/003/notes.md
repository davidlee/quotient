# Notes SL-003: Optional jail.nix form builder

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-26 · PHASE-05 · 1efd918

### Produced
- slice scoped + research round (edbae66); design run inq-1..inq-10 disposed; review RV-010 (pi, three rounds), 18 findings answered
- minted: DEC-014..DEC-022 — form-builder design decisions; IMP-007 — gate builds the Nix server package (accepted into SL-003)
- PHASE-01..04 implemented: 4c3152e, cf3cf74, a2e9fcd, ef83954+cce3d80; Codex round 3 follow-up 9adcf9a (phase sheets hold reds, renders, review adjudications)
- minted: DEC-023..DEC-028 — operator-accepted amendments to design sec-2/sec-3 (committed 54ca07a)
- PHASE-05 done — docs/nix-forms.md, README/setup/policy wording (dc46a9e); VH-1 hostile-audit PASS for read and write against a real-pi family built from 54ca07a
- minted: ISS-002 — hostile-audit's ambient QUOTIENT_* guard fails open without `compgen` (1efd918); QUE-001 — F-28

### Learned
- quotient delegates: no write in repo root; jailed without nix/bwrap-userns/git/shellcheck — see Execution notes
- mem.fact.doctrine.design-apply-payload — design apply --input shape; same-batch needs edge refusal

### Open
- QUE-001 — literal `$` in an env value or protect path fails the build (F-28); operator decision; undocumented
- DEC-023..DEC-028 — reconcile must fold into design.md sec-2/sec-3
- DEC-020 — env-leak claim proven by form-probe canary rows (PHASE-02); confirm at audit
- DEC-017 — residual: --args / add-runtime binds unchecked by checkFormFamily
- IMP-003 — answer the selection-gap note at close (design inq-9 disposition)
- PHASE-04 N1 residue — quoted multi-word env value can pose as a bwrap option (check.sh; printed as residue by the check)
- PHASE-04 Codex round-2 and rounds 4–6 fixes not re-reviewed; x86_64-linux only
- PHASE-05 — empty `.local/state/quotient` in a persisted home is documented but not observed by any probe row

## Further review

What a further pass over the SL-003 design would probe (written after RV-010's third round):

- The deferred tail's text position in a real built launcher. jail.nix composes deferred permissions last (lib/jail.nix:57-60), but nothing has been built yet. The first phase should build the default family and read its bwrap line before the check is written against it.
- The check's positional rules against jail.nix's actual rendering: quote stripping, the `${quotient_mask[@]}` and `${RUNTIME_ARGS[@]}` tokens, and `--args` placement.
- Whether `persistHome` plus the state mask behaves as stated (an empty `.local/state/quotient` in the persisted home).

None of these needs another design pass. Each is settled by the first build and by the negative controls (route: demonstrate/control). A further adversarial pass is not needed before planning.

## Execution notes (orchestrator)

- quotient delegates cannot write in the repo root (`.quotient/profiles` is a protected layer) and run in a jail without nix, bwrap userns, git or shellcheck. Execution uses worktree `.worktrees/sl-003`; the orchestrator runs host commands and leaves full logs in `.doctrine/state/host/`.
- PHASE-02 carried into PHASE-03: G6 is vacuous until `P/world` is bound (show G6 fails with the mask removed); mask paths from `protect` must be shell-escaped.
- Audit evidence: mask-before-root relies on the server refusing roots that contain an evidence store; a session dir that is an ancestor of the root would make a read root writable (server-chosen, not checked by the form).
- PHASE-04: DEC-023..DEC-028 amend design sec-2/sec-3 (reconcile must fold them into design.md). Open for audit: N1 residue (quoted multi-word env value posing as a bwrap option); Codex round-2 fixes not re-reviewed; only x86_64-linux checked. PHASE-05 docs must say protect takes directories and has no effect inside the root.
