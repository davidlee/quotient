# DEC-036: a literal $ in an env value or protect path is refused at evaluation

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->
## Decision
mkFormFamily refuses, at evaluation, a literal `$` in an `env` value or a `protect` path, with a message naming it; docs/nix-forms.md states the limit. This answers QUE-001. Lifting the limit is a backlog idea, not this slice.
## Context
RV-011 F-4 / PHASE-04 F-28: such a value failed the build at writeShellApplication's shellcheck (SC2016) with an opaque error.

## Basis
Operator, in session 2026-10-26: chose option A for RV-011 (fix inside SL-003), then "agreed" to the proposed amendments D1–D9 (D1 in its bash-as-parser form; D3 "yeah makes sense", with `/`).
