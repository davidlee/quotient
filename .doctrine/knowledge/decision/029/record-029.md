# DEC-029: check.sh reads the bwrap line with bash's parser, expansions neutralised

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->
## Decision
check.sh reads the bwrap line with bash's own parser, not by text normalisation. From the line minus `exec <BWRAP>`: every `$` becomes an inert sentinel byte and a backtick refuses the line; the line is parsed, not run, as a function body `f() { set -- <line>; }`; `declare -f f` must show exactly one simple `set -- …` command, else the line is refused; `f` is then called in a restricted shell with an empty environment, `set -f`, `set +B` and `HOME='~'`, and `printf '%s\0' "$@"` yields the argv, sentinels translated back to `$`. Every bwrap-line rule reads that argv; EXPOSURE is compared unnormalised. The builder's fixed line shapes (mask lines, form guards) keep their regexes.
## Context
RV-011 F-7/F-8 (Codex, reproduced): quote stripping erased empty arguments, so `env = { S_EMPTY = ""; QUOTIENT_DEBUG = "1"; }` passed (e); multi-word values and an apostrophe in a path were falsely refused. F-3's multi-word residue had the same cause.
## Alternatives
- A hand-written lexer in bash or awk: a second, partial model of shell quoting.
- Python shlex: adds Python to every consumer's check derivation.
- A builder-emitted argv manifest: the check would trust the builder's account of the bytes, and raw caller arguments would still need parsing.
## Consequences
Supersedes DEC-025's normalisation for the bwrap line. Expansions stay symbolic tokens (`$quotient_root`, `${quotient_mask[@]}`). The multi-word residue disappears from the printout.

## Basis
Operator, in session 2026-10-26: chose option A for RV-011 (fix inside SL-003), then "agreed" to the proposed amendments D1–D9 (D1 in its bash-as-parser form; D3 "yeah makes sense", with `/`).
