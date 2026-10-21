<!-- pi-mcp-profile
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
beyond the default of no extensions (design sec-3, "Executable contract"). A
profile that needed an MCP tool would require the form to re-enable
`builtin:mcp`, and the server refuses a profile whose tools it can never receive.

## Document format

The grammar is specified in the header comment of `pi/mcp/profiles.ts`. The
server parses this header and nothing else, once at start-up, into a snapshot
held for its lifetime — editing this file takes effect only when the server
restarts, which is a deployment act.
