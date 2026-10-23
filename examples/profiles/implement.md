<!-- quotient-profile
filesystem: write
model: llm-gateway/deepseek-flash
thinking: high
tools: read, grep, find, ls, edit, write, bash
-->

# `implement` — implementation with reasoning (`high`, writable)

Use this profile for work that needs edits and judgement: debugging, choosing
an approach, refactoring and making changes whose consequences need reasoning.
It uses the example DeepSeek gateway model with `high` thinking.
Use `review` at `max` for deep design review before implementation, or
`judgement` at `high` for analysis that does not need edits.

Give the delegate the intended behavior, constraints and appropriate validation
in the call's prompt. Quotient parses only the header; this prose is
documentation, not a system prompt.

The tools match `write`. The write form supplies filesystem confinement. No MCP
tools are named. The policy must pin `implement` to `write`.
Restart the server/client after profile changes. A project-local profile with
the same name takes precedence over this one.
