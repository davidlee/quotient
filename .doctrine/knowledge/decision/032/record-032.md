# DEC-032: piFiles binds move into the builder's deferred tail after the mask

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->
## Decision
The `piFiles` binds move into the builder's deferred tail, straight after the mask and before the root bind. The check's tail-order rule admits, between the mask and the root bind, only `--ro-bind /nix/store/… ~/.pi/agent/…`.
## Context
RV-011 F-11: piFiles sat in the caller's permissions, so a caller `defer` landed after them and could cover `~/.pi/agent`, contrary to sec-2.

## Basis
Operator, in session 2026-10-26: chose option A for RV-011 (fix inside SL-003), then "agreed" to the proposed amendments D1–D9 (D1 in its bash-as-parser form; D3 "yeah makes sense", with `/`).
