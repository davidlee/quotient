# DEC-037: fixtures and probes double as documentation examples and assurances

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->
## Decision
Fixtures double as documentation and assurance, all scripted (no agent in the loop):
- every RV-011 reproduction becomes a permanent case: a sample family with a `fixture … refuse:(x)` row, or, for an evaluation refusal, a `tryEval` case in the test flake asserting the builder throws with its message;
- each `nix` example in docs/nix-forms.md is tagged and must equal a file under `nix/checks/examples/` (a drift test enforces it); `forms-check` builds each example family and runs checkFormFamily over it;
- scripts/form-probe gains a runtime row for DEC-032: a caller `defer` cannot cover `piFiles`.
## Context
Operator suggestion during RV-011: maintain fixtures and probes as both documentation examples and correctness assurances.

## Basis
Operator, in session 2026-10-26: chose option A for RV-011 (fix inside SL-003), then "agreed" to the proposed amendments D1–D9 (D1 in its bash-as-parser form; D3 "yeah makes sense", with `/`).
