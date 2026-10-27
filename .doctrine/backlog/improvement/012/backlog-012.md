# IMP-012: Profile body reaches the delegate as instructions

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

User, 2026-10-27: "it's surprising it doesn't work this way already."

Today a profile is configuration only. `src/server/profiles.ts` parses the
`quotient-profile` header comment (filesystem, model, thinking, tools) and
treats everything after it as unparsed prose. `buildArgv`
(`src/server/spawn.ts`) passes pi `--model`, `--thinking`, `--tools`,
`--session-id`, `--session-dir`, `--no-extensions`, `--mode json` and, for
`mcp__*` tools, `-e builtin:mcp`. Nothing carries the body. The caller's
`prompt` is the delegate's only instruction from quotient. README and
`help/profiles.md` state this ("Profile prose is documentation").

The shipped examples (`review`, `judgement`, ...) read as if their prose
shapes the delegate, so the current split surprises operators.

## Proposal

Pass the profile body (or a delimited section of it) to pi as standing
instructions, e.g. a system-prompt addition. Unverified: pi's flag for this
(believed `--append-system-prompt`); check pi's CLI before designing.

## Open points

- Whole body vs a marked section, so operator notes can stay private.
- Trust: profiles come only from the XDG config dir, read once at start-up,
  so the instructions stay operator-authored. Confirm forms do not need to
  expose anything new.
- Visibility: the calling agent should see each profile's standing
  instructions (server instructions / `quotient help profiles`) so its briefs
  neither repeat nor contradict them.
- Interaction with session continuation: are instructions re-sent or fixed
  at session creation?
- Docs and examples: README, `help/profiles.md`, the six example profiles,
  drift tests that pin "prose is not parsed".
