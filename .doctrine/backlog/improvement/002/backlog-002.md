# IMP-002: Adopt strict linting for TypeScript and shell scripts

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

The repository currently has no configured linter. TypeScript is covered by
tests and type checking, and the shell scripts receive syntax checks, but there
is no lint pass to catch style and maintainability issues consistently.

## Desired outcome

Adopt deliberately strict linting for the TypeScript and shell code. Make
warnings fail the lint command, keep suppressions narrow and explained, expose
the check as `npm run lint`, and include it in `just gate`. Choose tools and
rules that are assertive without generating noisy, low-value findings.

## Baseline (2026-10-24)

Config landed un-gated: `eslint.config.js` (malebolge's typescript-eslint
strict rule set, pinned versions; `max-lines-per-function` off for
colocated `src/**/*.test.ts`), `just lint` (eslint `--max-warnings 0` +
`shellcheck scripts/*`), `npm run lint`. Not yet in `just gate`.

First run: shellcheck clean; eslint 1354 problems (src 619, test 735;
483 auto-fixable).

- ~900 are cheap: `curly` 337 (fixable), `no-floating-promises` 245 (all
  `node:test` `test`/`describe` calls in tests), `import-x/no-duplicates` 96
  (45 fixable), `consistent-type-definitions` 57 (fixable).
- Real work, ~250–300: `as` assertions (84), the unsafe-* family (~250, mostly
  tests over parsed JSON), `restrict-template-expressions` 62,
  `strict-boolean-expressions` 37, `no-explicit-any` 39, `complexity` > 8 in 25
  functions (worst 38/40/46).
- Hotspots: `src/reduce/reduce.ts` 155, `src/server/profiles.test.ts` 128,
  `src/server/server.ts` 85.
