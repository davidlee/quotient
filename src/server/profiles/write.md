<!-- pi-mcp-profile
filesystem: write
model: llm-gateway/deepseek-flash
thinking: off
tools: read, grep, find, ls, edit, write, bash
-->

# `write` — a write-capability delegate profile

The `write` wrapper form runs a delegate under a writable view of the root the
call names. This document says what that delegate is: the filesystem capability
the server requires of the form, the model the child runs, and the tools it may
use.

`write` is a superset of the edit tooling: it adds `edit` and `write` to the
inspection tools `read`, `grep`, `find` and `ls`, and it keeps `bash` for the
same reason `read` does — a shell is how a delegate inspects a tree, and the
capability is what decides whether a shell can write, not the tool list.

This profile names no `mcp__*` tool, so the form it runs under passes no `-e`
beyond the default of no extensions (design sec-3, "Executable contract").

## Document format

The grammar is specified in the header comment of `pi/mcp/profiles.ts`. The
server parses this header and nothing else, once at start-up, into a snapshot
held for its lifetime — editing this file takes effect only when the server
restarts, which is a deployment act.
