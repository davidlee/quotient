# DEC-029: check.sh reads the bwrap line with bash's parser, expansions neutralised

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->
## Decision
check.sh reads the bwrap line with bash's own parser, not by text normalisation; the mechanism is in the Amendment below (it replaces the function-body, `declare -f` and restricted-shell steps first agreed). Every bwrap-line rule reads that argv; EXPOSURE is compared unnormalised. The builder's fixed line shapes (mask lines, form guards) keep their regexes.
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

## Amendment (2026-10-26, operator "yes")
Mechanism refined during PHASE-06 planning; the principle (bash is the parser, nothing executes) is unchanged. `declare -f` cannot show control operators (`&&`, `|`, `&` render on one line), and a restricted shell still runs builtins. Instead:
1. Each of `$ ~ ; & | < > ( ) #` becomes its own inert control byte; a backtick, `$'`, `$"` or a stray control byte refuses the line.
2. `eval "set -- <line>"` in a subshell with `set -f`, `set +B` yields the argv; the bytes map back, so expansions stay symbolic.
3. A second parse replaces each operator character with two inert bytes around a space: quoted, the space stays in the word; unquoted, it splits it. More words than the first parse means an unquoted operator, and the line is refused.
Cost: a caller's backslash-escaped operator (`\;`) is refused, not read; jail.nix escapes with single quotes.


## Amendment 2 (2026-10-26, RV-011 F-20, F-24, F-26)
Within the principle (a line bash reads otherwise than its words say is refused), as built at round 2. Basis: the responder's fixes to Codex round-2 findings; not put to the operator separately.
1. A backtick, `*`, `?`, `[` and `{` join the split operators, each with its own inert byte: an unquoted glob or brace is refused (bash would expand it at launch).
2. A backtick stands in the second parse as a quoted space then an unquoted one, so it splits the line unless single quotes hold it: a single-quoted backtick is text (F-24); a double-quoted one opens a command substitution and is refused.
3. A `$(` or `$[` anywhere refuses the line, and every `${…}` must be a name, `name[@]`, or `name:-default` with no quote, escape, substitution, paren or brace. Inside double quotes these open a quoting context of their own, which the inert parse cannot follow (F-26). The builder emits none of them on the lines read; DEC-036 keeps `$` out of single-quoted caller text.
4. `\$` and `` \` `` refuse the line.
