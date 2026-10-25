## Decision

check-family.nix passes PROTECT (the family's protect paths) to check.sh, which asserts one existence-tested mask line per protect path (with the directory test DEC-023 adds).

## Context

PHASE-04 Codex review C8: a missing protect mask line was undetectable; sec-3's input table had no protect list. The family must expose protect for check-family.nix to read.

## Basis

Operator, in session 2026-10-25: "agree" to the four sec-3 amendments proposed after SL-003 PHASE-04's reviews. Amends SL-003 design sec-3.