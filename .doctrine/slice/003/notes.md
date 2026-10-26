# Notes SL-003: Optional jail.nix form builder

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-26 · reconcile (RV-011 concluded, 3 rounds) · 1347f3b

### Produced
- PHASE-01..05: 4c3152e, cf3cf74, a2e9fcd, ef83954+cce3d80, 9adcf9a, dc46a9e; VH-1 PASS read+write
- audit RV-011 opened; operator chose option A (fix in slice): DEC-029..037 agreed; plan appended PHASE-06..08 (0f8d132)
- PHASE-06 check parses with bash, overlay exposure, (j) aliases: 7cea541, 421a132
- PHASE-07 builder refusals, piFiles in tail, eval-refusal table: e4e8b58
- PHASE-08 docs examples as fixtures, read-root text fixed: 8fc5495
- post-phase hardening: 3f50a48 (unquoted $, \$, no \001), 701c96d (.. resolution, \037 separator)
- RV-011 round 2 fixes: af01198 (F-20..F-26), 443f5f5 (residue/docs text); gate rv011-r2-gate.log
- RV-011 round 3 fixes: 1347f3b (F-27, F-30, F-31, F-33, F-34; worker agent); gate rv011-r3-gate.log
- DEC-029 Amendments 2–3, DEC-033 Amendment, DEC-036 Amendments 1–2
- minted: ISS-002 — hostile-audit QUOTIENT_ guard fails open without compgen; QUE-001 (answered by DEC-036)

### Learned
- mem.fact.quotient.no-doctrine-ids-in-shipped-text — drift test fails the gate on ids in nix/ docs/ etc; print the gate's own exit when backgrounding
- Codex (OpenAI) cyber filter kills turns briefed as "attack"/"make eval execute"; frame as correctness/equivalence review (round 3 brief, scratchpad codex-brief-r3.md, ran clean)
- bash-as-parser desyncs come from quoting contexts the inert parse cannot see: $(…), ${…}, backticks inside double quotes, tilde provenance (DEC-029 Amendments 2–3); probe by comparing shell_words with bash eval word-for-word
- builder/checker input contract: anything jail.nix quotes that the checker refuses is a false refusal; refuse it at evaluation (DEC-036) or read it
- nixfmt over whole files reformats unrelated code here (repo not nixfmt-clean); format only touched lines
- mem.fact.doctrine.design-apply-payload — design apply --input shape

### Open
- RV-011 Reconciliation Brief — design.md sec-2/3/5 fold-in of DEC-023..037 (+amendments); residues; x86_64-only Risks line; F-16 notes line; policy contract step-8 sentence (F-17)
- DEC-017 — --args / add-runtime binds unchecked (declared residue); host symlinks in bound trees (runtime residue)
- IMP-003 — selection-gap note at close
- ISS-002 — outside slice

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
