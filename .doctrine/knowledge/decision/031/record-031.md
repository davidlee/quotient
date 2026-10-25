# DEC-031: refuse binds that alias a protected path at another target

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->
## Decision
A new refusal: no bind or overlay source equals, contains, or lies inside a protected path unless its target is that same path. Protected paths are the PROTECT paths, the default state directory in each textual spelling (`~/…`, `$HOME/…`, `${HOME}/…`, the `${XDG_STATE_HOME:-$HOME/.local/state}/quotient` expression), and `/`. A literal absolute path under the host's real home is unknown at build time and is a declared residue.
## Context
RV-011 F-10: `ro-bind ~/.local/state/quotient /visible-state` (or a protect path) passed; the mask covers the source path only, so other sessions and the run evidence were readable at the alias (G6).

## Basis
Operator, in session 2026-10-26: chose option A for RV-011 (fix inside SL-003), then "agreed" to the proposed amendments D1–D9 (D1 in its bash-as-parser form; D3 "yeah makes sense", with `/`).
