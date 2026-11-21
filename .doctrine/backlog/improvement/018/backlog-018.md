# IMP-018: quotient help leash: frontier-orchestrator operating mode; continuation-first guidance in help

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

Field notes from Nemesis and Malebolge, plus the user's request on 2026-11-21: agents abandon runs that hit a ceiling when they should usually continue them.

## Done (2026-11-21)

- New `help/leash.md` (`quotient help leash`): the operating mode for a frontier orchestrator. It is registered in `src/help/help.ts` and tested in `src/help/help.test.ts`.
- `help/orchestrate.md`: "When a run stops short" is now a decision rule that defaults to continuing. Added bullets on passing `cwd` and on shared test artifacts.
- `help/agent.md` and `help/tool.md`: continuation guidance and a pointer to `leash`. `README.md` lists the new section.
