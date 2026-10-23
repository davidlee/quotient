# Measure peak request context for token ceilings

## Context

IMP-001 reports that a run-wide token ceiling can stop multi-turn work even
when each individual request remains within the model's useful context range.
In this checkout, `src/server/gate.ts` compares `maxima.tokens` with the sum
of accumulated input, output, cache-read, and cache-write tokens. The reducer
does not currently retain the largest single request. This slice addresses
that measurement mismatch while preserving cumulative usage reporting.

## Scope & Objectives

- Measure each request's full context footprint as pi's normalized input,
  cache-read, cache-write and output tokens, including measured assistant and
  compaction-summary requests; retain the largest observed footprint.
- Enforce the fixed context ceiling retrospectively at each measurement and
  expose the peak and unmeasured-request count in status. Continue through
  context gaps with disclosure; validate cost independently and retain its
  accounting stop and existing failed-send/retry exceptions.
- Replace cumulative `maxima.tokens` enforcement with `maxima.context_tokens`
  and the corresponding caller ceiling. Require explicit migration to policy
  `/2`, status `/3` and result `/2`, preserving cumulative token reporting and
  historical contracts.
- Update the relevant policy and result contracts, help/examples, and focused
  reducer/gate tests to match the chosen semantics.
- Release the slice as package version 0.2.0 with consistent lockfile metadata.

The implementation surface is expected to include `src/reduce/`,
`src/server/`, `docs/contract/`, `examples/policy.json`, and the rendered help
or setup documentation that explains these limits, plus package release
metadata. The design's code-impact section and design-target selectors define
the intended touch set.

## Non-Goals

- Changing request-count, cost, wall-clock, or transcript ceilings.
- Choosing a universal model context threshold such as 180k tokens; the
  operator supplies the limit.
- Preventing a single request from exceeding its limit before its usage is
  reported. Enforcement remains retrospective.
- Changing how Malebolge schedules or resumes work.

## Summary

Replace the cumulative token ceiling as the proxy for per-request context
pressure with an explicit peak-context measurement and limit. Preserve
cumulative token totals for accounting/status. The accepted design decisions
DEC-001 through DEC-006 settle measurement, disclosure, independent cost
validity and explicit migration; CON-001 requires package version 0.2.0.

## Follow-Ups

- Keep the inspected-pi-source versus installed-runtime parity limit explicit;
  fixture tests do not establish every launched provider's reporting behavior.
- After audit and before reconciliation, remind the user to run `npm publish`
  for 0.2.0 and obtain the publication outcome before continuing. The user owns
  publication; the reminder does not authorize the agent to publish.
