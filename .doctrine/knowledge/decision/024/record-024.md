## Decision

mkFormFamily asserts at evaluation that every `secretEnv` value contains `$` (a shell expansion evaluated at launch, e.g. `$(cat …)` or `$VAR`). A value without one fails the build with a message naming the variable.

## Context

SL-003 PHASE-03 review: `secretEnv` values are interpolated into the launcher, which lives in the world-readable Nix store. A literal secret would be written there, contrary to design sec-2's "values never reach disk".

## Basis

Operator, in session 2026-10-25: "2. yes" to the `$`-assertion. Amends SL-003 design sec-2 'Environment and secrets' (adds a refusal).
