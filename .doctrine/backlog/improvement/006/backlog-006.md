# IMP-006: README surfaces the design's reasoning (threat model, trust boundary, invariants)

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Operator request, 2026-10-24, at SL-002 close: the design documents hold a lot
of reasoning that a README reader never sees, so they risk underestimating how
much thought has gone into quotient.

Candidate material: `docs/design.md` and the contracts in `docs/contract/`
(the published ones). The SL-002 design and its reviews (RV-006, RV-008) have
more, but those are private doctrine artefacts. Shipped text must not cite
private ids (SL-002 PHASE-06 EX-6). Likely themes:
- the trust boundary: who can write what, and why a delegate cannot change
  which form runs;
- the admission order and its first-failure-wins rule;
- invariants: approval is the selection, with no fallback; one form identity
  per call, resolved once; fail-closed stores;
- residuals stated honestly: relocation, hash scope, operator obligations.

Shape: a short "Design and guarantees" section in the README that links to
the contracts, not a copy of them.
