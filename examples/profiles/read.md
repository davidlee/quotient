<!-- quotient-profile
filesystem: read
model: llm-gateway/deepseek-flash
thinking: off
tools: read, grep, find, ls, bash
-->

# `read` — a read-capability delegate profile

The `read` wrapper form runs a delegate under a read-only view of the root the
call names. This document says what that delegate is: the filesystem capability
the server requires of the form, the model the child runs, and the tools it may
use.

A read-capability profile still names `bash`. Read-only is an OS claim the form
makes, not a claim a tool list can make: `bash` cannot write through a read-only
mount, and removing it would remove the delegate's ability to inspect a tree
efficiently without making the tree any safer.

This profile runs with thinking off: it is the recon delegate, and judgement is
the `research` profile's job.

This profile names no `mcp__*` tool, so the form it runs under passes no `-e`
beyond the default of no extensions (`docs/contract/quotient-policy-2.md`, Fields). A
profile that needed an MCP tool would require the form to re-enable
`builtin:mcp`, and the server refuses a profile whose tools it can never receive.

## Document format

This is an example, not a built-in: the server loads profiles only from
`<launch dir>/.quotient/profiles/` and `$XDG_CONFIG_HOME/quotient/profiles/`.
Copy it into one of those layers. The launch-dir copy wins per name. The
policy's `profiles` map must list the name and pin the same `filesystem`, or
calls refuse `profile-capability-mismatch`.

`quotient help profiles` specifies the grammar. The server parses this header
and nothing else, once at start-up, into a snapshot held for its lifetime. An
edit takes effect only when the server restarts, which is a deployment act.
