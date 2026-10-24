# DEC-012: Approvals store refuses non-canonical root and path (no normalisation)

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->

Context: SL-002 PHASE-02 review. The design keys approvals by canonical root
but did not say what the reader does with a non-canonical one. Two entries for
`/work/one` and `/work/one/` were both admitted, and the governing approval
then depended on file order.

Decision: `readApprovals` refuses any `root` or `path` where
`path.resolve(x) !== x` (trailing slash, `.`, `..`, `//`). It does not normalise
them. Duplicate detection runs on the canonical form. Stated in
`docs/contract/quotient-approvals-1.md`.

Why refuse rather than normalise: the store is written only by
`quotient allow`, which always writes canonical paths, so a non-canonical entry
is a hand edit or corruption, and the store fails closed. The audit should
reconcile the design (SL-002 design sec-2, "The approvals store") with this.
