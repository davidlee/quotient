<!-- quotient-profile
filesystem: read
model: llm-gateway/deepseek-flash
thinking: high
tools: read, grep, find, ls, bash
-->

# `judgement` — reasoning and decisions (`high`, read-only)

Use this profile for weighing alternatives, interpreting requirements, tracing
consequences and answering questions that need a reasoned conclusion. It uses
the example DeepSeek gateway model with `high` thinking.
Use `review` at `max` for deep adversarial design review, and `implement` at
`high` when the task requires edits.

Give the delegate the decision to make, relevant constraints and the evidence
you expect back. Ask it to distinguish verified facts, inferences and unknowns.
Profile prose documents intended use; Quotient parses only the header, so
criteria and output requirements belong in the call's prompt.

The read form supplies filesystem confinement, including for `bash`. No MCP
tools are named. The policy must pin `judgement` to `read`.
Restart the server/client after profile changes. A project-local profile with
the same name takes precedence over this one.
