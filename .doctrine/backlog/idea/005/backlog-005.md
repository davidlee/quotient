# IDE-005: Policy bound on runs in flight

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

From SL-004 (OQ-4, user 2026-10-26: not needed yet). Concurrent runs multiply
spend; per-run maxima stay per run. If that becomes a problem, add a policy
maximum on runs executing (and/or queued) at once, refusing starts beyond it.
