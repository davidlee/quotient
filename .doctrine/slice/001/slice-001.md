# Measure peak request context for token ceilings

## Context

IMP-001 reports that a run-wide token ceiling can stop multi-turn work even
when each individual request remains within the model's useful context range.
In this checkout, `src/server/gate.ts` compares `maxima.tokens` with the sum
of accumulated input, output, cache-read, and cache-write tokens. The reducer
does not currently retain the largest single request. This slice addresses
that measurement mismatch while preserving cumulative usage reporting.

## Scope & Objectives

- Measure the largest per-request input context observed in a run, with the
  exact treatment of fresh input, cache reads, and any other usage fields
  settled during design against pi's usage contract.
- Enforce a policy ceiling against that peak and expose the peak in the run
  status, so callers can distinguish context pressure from cumulative usage.
- Define what happens to the existing cumulative `maxima.tokens` limit and
  the compatibility/migration path for existing policy files and result
  consumers.
- Update the relevant policy and result contracts, help/examples, and focused
  reducer/gate tests to match the chosen semantics.

The implementation surface is expected to include `src/reduce/`,
`src/server/`, `docs/contract/`, `examples/policy.json`, and the rendered help
or setup documentation that explains these limits. Design will refine the
exact touch set.

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
cumulative token totals for accounting/status. Whether cumulative token
enforcement remains alongside the new limit, and how policy/result schema
versions change, are design decisions rather than assumptions of this scope.

## Follow-Ups

- Before design, verify pi's usage-field semantics and the provider event path
  used by the reducer; use those findings to define the peak calculation.
- Research and design the policy migration and result/status compatibility
  before implementation.
