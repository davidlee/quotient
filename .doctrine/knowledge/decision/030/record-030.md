# DEC-030: overlay upper and work directories count as read-write sources in rule (g)

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->
## Decision
Rule (g) counts an `--overlay`'s upper directory and work directory as read-write sources: each must be in EXPOSURE.
## Context
RV-011 F-9: `c.overlay-rw` made host directories writable with an empty exposure and the check passed (G5).

## Basis
Operator, in session 2026-10-26: chose option A for RV-011 (fix inside SL-003), then "agreed" to the proposed amendments D1–D9 (D1 in its bash-as-parser form; D3 "yeah makes sense", with `/`).
