# DEC-033: piFiles values must be paths or derivations, imported into the store

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->
## Decision
A `piFiles` value must be a Nix path or a derivation; it is interpolated (`"${source}"`), which imports a path into the store. Any other value is refused at evaluation with a message naming the entry.
## Context
RV-011 F-12: `toString source` kept a host path when evaluated outside flake source, contrary to G10.

## Basis
Operator, in session 2026-10-26: chose option A for RV-011 (fix inside SL-003), then "agreed" to the proposed amendments D1–D9 (D1 in its bash-as-parser form; D3 "yeah makes sense", with `/`).
