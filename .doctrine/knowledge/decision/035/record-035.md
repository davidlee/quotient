# DEC-035: options cannot use add-cleanup

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->
## Decision
The combinator set mkFormFamily hands to `options` has an `add-cleanup` that throws, saying the form must exec bwrap directly.
## Context
RV-011 F-15: `add-cleanup` makes jail.nix run bwrap without exec under an EXIT trap; the check then failed (b) with cascading, unexplained failures.

## Basis
Operator, in session 2026-10-26: chose option A for RV-011 (fix inside SL-003), then "agreed" to the proposed amendments D1–D9 (D1 in its bash-as-parser form; D3 "yeah makes sense", with `/`).
