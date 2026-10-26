Probed 2026-10-26 under Claude Code with server 0.5.0: two `pi_agent` calls in
one message ran strictly in sequence while the tool declared no annotations;
with `annotations: { readOnlyHint: true }` patched into the `tools/list`
reply they started 4ms apart and overlapped fully (IMP-011 holds the
timestamps). Codex CLI is reported to schedule the same way (secondary
source, SL-004 research.md § Prior art).

The server is not the bottleneck: `tools/call` is already handled without
awaiting earlier calls (`src/server/server.ts`, the `tools/call` arm).

Consequences:
- Never set `readOnlyHint` on a tool that can start a write run, to win
  concurrency; clients may also skip approval for read-only tools.
- Concurrency for writers comes from launching fast and waiting in a
  read-only tool (SL-004, DEC-048 / DEC-054).
- Tool annotations are read at connect time: a change needs an MCP
  reconnect (`/mcp`) before a probe means anything.
- The configured server is the global npm install
  (`~/.npm-global/lib/node_modules/@davlee/quotient/dist`), not this repo's
  `dist`; probing a source change means building and patching or installing
  it there.
