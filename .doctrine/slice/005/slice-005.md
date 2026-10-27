# Lint burn-down to zero, gated

## Context

IMP-002 adopted typescript-eslint strict (`eslint.config.js`, `just lint`) but
left it out of `just gate`. After the noise pass (2026-10-24) the main tree
carries 526 errors, none auto-fixable. Running `eslint .` reports 1642 because
`.worktrees/` (merged, clean SL-002/SL-003 worktrees) is not ignored.

Main tree, 2026-10-27:

```
rule family                                 count   main source
unsafe-* (member-access/argument/assign/    231     Record<string, any> test helpers,
  return/call) + no-explicit-any 38                 JSON.parse results, reduce.ts
consistent-type-assertions (no `as`)         70     parsed JSON, test fixtures
restrict-template-expressions                57     numbers/unknowns in templates
strict-boolean-expressions                   28
no-unnecessary-condition                     25
complexity > 8 / max-depth / max-lines       28     reduce.ts, spawn.ts, session.ts
no-non-null-assertion                        14
other (return types, empty fns, dupes, …)    ~35
```

Hotspots: `src/reduce/reduce.ts` 124, `src/server/gate.test.ts` 56,
`src/server/profiles.test.ts` 49, `src/server/session.test.ts` 36,
`src/server/spawn.test.ts` 34.

## Scope & Objectives

- Ignore `.worktrees` in `eslint.config.js`.
- Drive `just lint` to zero on the main tree, then add `lint` to `just gate`
  and resolve IMP-002.
- Fix root causes, not sites: where one untyped helper (e.g. a
  `Record<string, any>` result parser in tests) feeds dozens of findings, type
  the helper once — narrow `unknown` through the real contract types or a
  small shared guard — so the code improves rather than gaining casts.
- Reduce complexity by extracting small, named, pure functions (notably
  `src/reduce/reduce.ts`), not by loosening the threshold.
- Suppressions only where a rule is wrong for that line: one rule per
  `eslint-disable-next-line`, each with a reason. Rule changes in the config
  only with a stated rationale (rule low-value for this codebase), and recorded
  in the slice notes.
- No behaviour change. Every phase ends with `just gate` green and no file's
  lint count above its starting count (ratchet against a per-file baseline).
- Token economy: per-file mechanical fixes are delegated to cheap pi workers
  (`mcp__quotient__pi_agent`); the orchestrator keeps verification (gate,
  lint ratchet, diff review of type and control-flow changes).

## Non-Goals

- New features, contract or behaviour changes.
- shellcheck (already clean).
- Removing the stale `.worktrees/sl-00{2,3}` worktrees (operator's call).
- Adopting additional lint rules beyond the current config.

## Summary

Affected surface: `eslint.config.js`, `justfile`, `src/**/*.ts`
(production and tests), `src/server/test-rig.ts`.

Risks:
- Type-narrowing refactors in production code (`reduce.ts`, `spawn.ts`,
  `session.ts`) can change edge-case behaviour (falsy vs nullish checks under
  `strict-boolean-expressions`). Mitigation: tests per phase; review each
  converted condition for `0` / `""` semantics.
- Cheap workers may paper over findings with casts or disables. Mitigation:
  phase verification greps the diff for new `as`, `!`, `any` and
  `eslint-disable`.

Done when: `just lint` exits 0, `just gate` includes `lint` and is green,
328+ tests pass, IMP-002 resolved.

## Follow-Ups
