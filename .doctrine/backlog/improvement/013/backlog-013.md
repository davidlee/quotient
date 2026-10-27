# IMP-013: Policy refusals point the agent to quotient help setup

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

User, 2026-10-27, during the README rewrite. The README now says no skills are
needed: the tool carries its own help, and the quickstart is "ask your agent to
run `quotient help setup`". But an agent that calls `pi_agent` before any
setup gets a `policy-unavailable` refusal (`src/server/policy.ts`, e.g. "<path>
could not be read (ENOENT)") with no pointer to setup. Neither the refusal
detail nor `help/agent.md` mentions `quotient help setup`.

## Proposal

When admission step 1 refuses `policy-unavailable` or `policy-invalid`, the
refusal tells the agent where to go next: `quotient help setup` for a missing
policy, `quotient help policy` for an invalid one. Consider the same for
other operator-fixable refusals (`profile-*`, `form-*`), each naming the
help section that fixes it.

## Open points

- Where the pointer lives: in `detail`, or a dedicated field
  (`help`/`next`)? A new field is a `pi-agent-result/2` contract change; text
  in `detail` is not.
- Also add one line to `help/agent.md`: "Refused for a missing or invalid
  policy? Run `quotient help setup`."
- Tests: refusal text for each step-1 case; drift tests that keep the named
  help sections real.
