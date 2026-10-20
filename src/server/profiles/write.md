<!-- pi-mcp-profile
filesystem: write
model: llm-gateway/deepseek-flash
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

The server parses the header above and nothing else. It is read once, at
start-up, into a snapshot held for the server's lifetime — editing this file
takes effect only when the server restarts, which is a deployment act.

- The first non-empty line opens the header: `<!-- pi-mcp-profile`.
- Then one `key: value` line per field, with exactly one space or tab after the
  colon: `filesystem` (`read` or `write`), `model` (one non-empty token), and
  `tools` (comma-separated tool names). Each field exactly once, no others, no
  blank line inside the header.
- A line holding `-->` closes it. Everything after that is prose for a human.

The profile's name is this file's base name (`write`), which must match
`^[a-z][a-z0-9-]{0,31}$`. The grammar is what `pi/mcp/profiles.ts` documents.
