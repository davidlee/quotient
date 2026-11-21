# IMP-019: Non-final results carry a next hint: continue the session

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

A result with `final: false` carried no hint that the session should be continued. Shaped by DEC-072, which says adding a field is not a breaking change.

## Done (2026-11-21)

- `src/server/result.ts`: `next: string | null` is always present. `nextStep(termination, session)` returns `CONTINUE_HINT` for `ceiling`, `timeout`, `toolUse` and `deferred` when a session exists. The validator requires `next` to be present, null on a final run, and null on a refusal.
- Tests: the new IMP-019 test in `src/server/result.test.ts`.
- `docs/contract/pi-agent-result-2.md`: new Fields row. All four output contracts state the compatibility rule.

The hint is one fixed text for all four terminations. It can name the ceiling it hit once IMP-015 lands.
