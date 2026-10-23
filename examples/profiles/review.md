<!-- quotient-profile
filesystem: read
model: llm-gateway/deepseek-flash
thinking: max
tools: read, grep, find, ls, bash
-->

# `review` — deep design review (`max`, read-only)

Use this profile for difficult design reviews: architecture, security and trust
boundaries, state transitions, crash recovery, migrations and competing designs.
It uses the example DeepSeek gateway model with `max` thinking.
Use `judgement` at `high` for everyday judgement and `read` for cheap recon.

Supply the design, scope, constraints and settled decisions in the call's
prompt. Ask the delegate to inspect the implementation and governing contracts,
trace concrete failure scenarios and challenge assumptions against evidence.
For each substantive finding, request severity, file/line evidence, the failure
scenario and a concrete repair. Distinguish verified defects from inferences
and unperformed runtime checks; omit padding and settled issues.

These are caller instructions to include when useful: Quotient parses only the
header and does not inject this prose into the delegate's prompt. A higher
thinking setting is not evidence that the resulting review is correct.

The tools match `judgement`. The read form supplies filesystem confinement;
the presence of `bash` does not grant write capability. No MCP tools are named.

The operator policy must pin `review` to `read`. Profiles are loaded at server
startup; restart the Quotient server/client after changing them. A project's
`.quotient/profiles/review.md` takes precedence over this user-level profile.
