## Decision

check.sh's normalisation strips single quotes as well as double quotes, and treats tabs and runs of whitespace as one separator, before tokenising the bwrap line.

## Context

PHASE-04 Codex review C3/C4: single-quoted or tab-separated arguments evaded rules (d), (e), (g), (h); sec-3 specified double-quote stripping only.

## Basis

Operator, in session 2026-10-25: "agree" to the four sec-3 amendments proposed after SL-003 PHASE-04's reviews. Amends SL-003 design sec-3.