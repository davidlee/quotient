# RSK-002: Blocking pi_agent runs over 30 minutes are aborted by Claude Code's stdio idle timeout

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Claude Code aborts an MCP tool call to a stdio server that sends no response
and no progress notification for 30 minutes (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`;
EVD-002). quotient sends no `notifications/progress`, so a blocking
`pi_agent` call whose policy allows `wall_clock_s` above 1800 can be aborted
by the client mid-run. The run then continues server-side; the client sees
a tool error.

Mitigations to weigh: emit `notifications/progress` when the request carries
a `progressToken`; document the per-server `.mcp.json` `timeout` floor; steer
long runs to start/wait or the tasks binding (SL-004).
