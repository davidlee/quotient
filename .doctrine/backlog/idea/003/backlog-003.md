# IDE-003: Bind start/wait/cancel to the MCP tasks extension

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

From SL-004 (inq-9, deferred). MCP 2025-11-25 added experimental tasks, later
moved to the `io.modelcontextprotocol/tasks` extension: a task-augmented
`tools/call`, `tasks/get` (returns the result in the extension revision),
`tasks/cancel`. SL-004's tools are shaped to map one-to-one: start ↔
task-augmented call, wait ↔ `tasks/get`, cancel ↔ `tasks/cancel`. Do this once
a client we use supports tasks; see SL-004 research.md § Prior art.
