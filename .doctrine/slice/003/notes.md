# Notes SL-003: Optional jail.nix form builder

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-24 · design inquiring (run rev 21) · HEAD+pending commit

### Produced
- slice scoped + research round (commit edbae66); design run inq-1..inq-10 all disposed
- minted: DEC-014..DEC-022 — the form-builder design decisions; IMP-007 — gate builds the Nix server package (accepted into SL-003)
- research/research.md: persisted-home G5 claim corrected (declared in exposure on this host)

### Learned
- mem.fact.doctrine.design-apply-payload — design apply --input shape; same-batch needs edge refusal

### Open
- IMP-003 — answer the selection-gap note at close (design inq-9 disposition)
- DEC-020 — env-leak claim rests on jailed-agents.nix:61-68, to be proven by the DEC-022 probe
- DEC-017 — residual: --args / add-runtime binds unchecked by checkFormFamily
