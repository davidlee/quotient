# Review RV-004 — code-review of SL-001

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Review PHASE-03 package metadata and script changes against CON-001, plan
EX-1..EX-7 and VT-1..VT-4. Verify the single package version source and the
three mirrored 0.2.0 fields; generated policy/2 context ceilings in both
scripts; pack-check's exact nested result/status/context assertions and four
installed-bin checks; shell syntax and package contents; and the committed-HEAD
boundary. Keep the stub package test distinct from the unrun real-form/provider
probe. Do not treat precommit runs as release-gate evidence.

## Synthesis

### Overall

solid

### Synopsis

The package version and both lockfile mirrors agree on 0.2.0 with lockfile
format 3 unchanged. The CLI and MCP continue to read the single package version
owner. Both generated policies use policy/2; the installed pack-check asserts
result/2, status/3 and the exact 16-token context footprint with no context
gaps. The committed-HEAD pack-check passed all four installed checks on
61fd1a9. The hostile-audit live form/provider probe and real installed-pi
normalization/resume trace remain unperformed because their real form, model,
provider and supported-runtime trace prerequisites were not supplied; the stub
does not validate them. The Doctrine gate recipe is absent, and direct checks
were used. No package publication occurred.

### Haiku

Tarball meets the gate
Sixteen tokens meet the peak
No model was called
