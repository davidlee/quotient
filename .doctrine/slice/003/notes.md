# Notes SL-003: Optional jail.nix form builder

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-24 · design inquiring (run rev 21) · 00cc7b5

### Produced
- slice scoped + research round (commit edbae66); design run inq-1..inq-10 all disposed
- minted: DEC-014..DEC-022 — the form-builder design decisions; IMP-007 — gate builds the Nix server package (accepted into SL-003)
- research/research.md: persisted-home G5 claim corrected (declared in exposure on this host)
- pi review of DEC-014..022 (research/raw/review-decs-014-022.md): F-1,F-4,F-5c contested; rest integrated by amending DEC-017,019,020,021,022 (operator-accepted)

- design drafted sec-1..sec-5; review pass RV-010 (pi, three rounds): 18 findings, all answered; F-5 unverifiable by the reviewer (jail.nix outside its jail), evidence in the response

### Learned
- mem.fact.doctrine.design-apply-payload — design apply --input shape; same-batch needs edge refusal

### Open
- IMP-003 — answer the selection-gap note at close (design inq-9 disposition)
- DEC-020 — env-leak claim rests on jailed-agents.nix:61-68, to be proven by the DEC-022 probe
- DEC-017 — residual: --args / add-runtime binds unchecked by checkFormFamily
- DEC-017 — state mask under persistHome leaves an empty quotient state dir in the persisted home; document
- PHASE-05 docs: `protect` has no effect inside the root (the mask precedes the root bind); say so.

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
