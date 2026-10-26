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


## Amendment (2026-10-26, operator chose option (a) for RV-011 F-25)
The builder also refuses, at evaluation, a newline in an `env` value or in a `persistHome`, `exposure` or `protect` path, with a message naming it (`mkFormFamily: env values and host paths cannot contain a newline: <arg>`); docs/nix-forms.md states the limit. The check reads the launcher a line at a time, so such a value split the bwrap line and was refused with the misleading reason "quoting that does not close". The alternative, a multi-line reader, would end the one-word-per-line words file.


## Amendment 2 (2026-10-26, RV-011 F-33, F-34; in the direction the operator chose for F-25)
The newline refusal widens to any control character other than tab (which the check reads), and covers piFiles keys as well as env values and host paths: `mkFormFamily: env values, host paths and piFiles keys cannot contain a control character other than tab: <arg>`.
