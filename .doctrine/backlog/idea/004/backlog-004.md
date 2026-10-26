# IDE-004: wait include_acknowledged: list runs already delivered

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

From SL-004 (DEC-047). A no-target wait returns only unacknowledged runs;
acknowledged runs are visible only by naming their handles. If callers need
to rediscover acknowledged runs (e.g. after context compaction), add an
`include_acknowledged` flag to `pi_agent_wait` rather than a list tool.
