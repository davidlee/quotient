Driving a slice's phases through `mcp__quotient__pi_agent` (`implement` worker, `review` verifier), from SL-002:

- Policy caps each call at 30 requests and 900 s. A phase takes several calls on one `session`; continue with a one-line "continue" prompt.
- Peak context climbs ~30–40k per call. Near ~120k, have the worker append a "### Handover" block (per-task status, failing test + diagnosis, readings not to get wrong) to the phase sheet's `## Findings`, WIP-commit, and start a fresh session that resumes from it. Fresh resumes ran at ~35–60k.
- The agent's view is its cwd only, read-write, with no git (a worktree's `.git` points outside). The orchestrator commits and squashes WIP with `git reset --soft`.
- `just gate`'s pack-check clones the committed HEAD: commit before gating, or a WIP commit's errors fail it.
- The node test reporter may print `ℹ pass` rather than `# pass` in the sandbox, so grep for both.
- A max-thinking `review` worker given a diff file under `.doctrine/state/` plus the plan's EX/VT criteria found real defects in five of six phases. Ask it to verify each finding and to reserve its last call for the answer.
- Before PHASE-01 of SL-002 shipped, a write agent rooted at the server's launch directory was refused (ISS-001); a doctrine fork under `.worktrees/` avoided it.
