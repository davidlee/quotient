# IMP-009: Tool description shows the policy's per-run maxima

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

The `pi_agent` tool description and the MCP instructions render a profiles
table from the policy (`src/help/help.ts`, `renderContext` and the table at
~L190), but not the policy's `maxima` (`requests`, `context_tokens`,
`cost_usd`, `wall_clock_s`). A caller learns a limit only by being refused, or
by reading the operator's `policy.json` directly — which couples the caller to
the policy's location and schema, and which the caller may not be allowed to
read.

Render the four maxima next to the profiles table, with the same caveat the
capability column carries: the values are the policy as read when the text was
rendered; the policy is re-read on every call, which is authoritative. The
render context already reads the policy (it returns `maxima.wall_clock_s` for
the client timeout snippet), so this extends an existing read rather than
adding one.

Covers: a readable policy (values shown), an unreadable one (stated, as the
clients section does today), and the help digest changing with the values.

Origin: reviewing the user-level `pi-orchestrate` skill (2026-10-26), whose
"read the ceilings with `jq .maxima <policy.json>`" step this replaces.
IMP-010 depends on it.
