<!-- quotient-profile
filesystem: read
model: llm-gateway/deepseek-flash
thinking: low
tools: read, grep, find, ls, bash
-->

# `research` — a read-capability delegate profile for judgement

The `read` wrapper form runs a delegate under a read-only view of the root the
call names. This document says what that delegate is: the filesystem capability
the server requires of the form, the model the child runs, and the tools it may
use.

`research` is for judgement over the repository: whether a governance rule
applies here, which of two competing readings a document supports, what the
tradeoffs of a change are. It is reasoning about what the tree says, not
changing it — `read` is the no-thinking profile for recon, and this one pays for
a thinking budget so the answer can weigh the evidence it gathered.

It names the same tools as `read`, and for the same reason: `bash` cannot write
through a read-only mount, and removing it would remove the delegate's ability
to inspect a tree efficiently without making the tree any safer.

This profile names no `mcp__*` tool, so the form it runs under passes no `-e`
beyond the default of no extensions (`docs/contract/quotient-policy-1.md`, Fields).

## Document format

This is an example, not a built-in: the server loads profiles only from
`<launch dir>/.quotient/profiles/` and `$XDG_CONFIG_HOME/quotient/profiles/`.
Copy it into one of those layers. The launch-dir copy wins per name. The
policy's `profiles` map must list the name and pin the same `filesystem`, or
calls refuse `profile-capability-mismatch`.

`quotient help profiles` specifies the grammar. The server parses this header
and nothing else, once at start-up, into a snapshot held for its lifetime. An
edit takes effect only when the server restarts, which is a deployment act.
