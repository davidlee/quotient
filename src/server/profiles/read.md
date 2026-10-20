<!-- pi-mcp-profile
filesystem: read
model: llm-gateway/deepseek-flash
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

This profile names no `mcp__*` tool, so the form it runs under passes no `-e`
beyond the default of no extensions (design sec-3, "Executable contract"). A
profile that needed an MCP tool would require the form to re-enable
`builtin:mcp`, and the server refuses a profile whose tools it can never receive.

## Document format

The server parses the header above and nothing else. It is read once, at
start-up, into a snapshot held for the server's lifetime — editing this file
takes effect only when the server restarts.

- The first non-empty line opens the header: `<!-- pi-mcp-profile`.
- Then one `key: value` line per field, with exactly one space or tab after the
  colon: `filesystem` (`read` or `write`), `model` (one non-empty token), and
  `tools` (comma-separated tool names). Each field exactly once, no others, no
  blank line inside the header.
- A line holding `-->` closes it. Everything after that is prose for a human.

The profile's name is this file's base name (`read`), which must match
`^[a-z][a-z0-9-]{0,31}$`. There is no YAML or markdown parser behind this: the
grammar is what `pi/mcp/profiles.ts` documents, so a document that fails it
refuses at start-up rather than being quietly ignored.
