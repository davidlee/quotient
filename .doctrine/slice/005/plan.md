# Implementation Plan SL-005: Lint burn-down to zero, gated

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. Use this for the plan's rationale and sequencing.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

Five phases: shared foundations first (orchestrator), then tests, `reduce`,
the rest of production (pi workers), then gating.

## Sequencing & Rationale

PHASE-01 removes the root causes the most findings share, so worker phases
apply one pattern instead of inventing casts. Tests precede production because
their findings are mostly downstream of the PHASE-01 helpers and they guard
the production refactors that follow. `reduce.ts` is its own phase: it holds a
quarter of the findings and the accounting logic most sensitive to
truthiness rewrites. Gating last, once zero holds.

## Notes

The baseline TSV moves to `research/lint-baseline.tsv` (SL-002's copy was
taken before the noise pass and covers different counts).
