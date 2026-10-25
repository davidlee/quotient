## Decision

check.sh's bind_words recognises --dev-bind (and --dev-bind-try) as read-write binds, so rules (f) and (g) see them. A caller's device bind must then be declared in exposure.

## Context

PHASE-04 review C6/R1: --dev-bind was invisible to bind_words.

## Basis

Operator, in session 2026-10-25: "agree" to the four sec-3 amendments proposed after SL-003 PHASE-04's reviews. Amends SL-003 design sec-3.