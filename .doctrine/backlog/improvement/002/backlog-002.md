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
