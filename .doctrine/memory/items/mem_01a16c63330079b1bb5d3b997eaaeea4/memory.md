Driving a slice's phases through `mcp__quotient__pi_agent` (`implement` worker, `review` verifier), from SL-002:

- Policy caps each call at 30 requests and 900 s. A phase takes several calls on one `session`; continue with a one-line "continue" prompt.
- Peak context climbs ~30–40k per call. Near ~120k, have the worker append a "### Handover" block (per-task status, failing test + diagnosis, readings not to get wrong) to the phase sheet's `## Findings`, WIP-commit, and start a fresh session that resumes from it. Fresh resumes ran at ~35–60k.
- The agent's view is its cwd only, read-write, with no git (a worktree's `.git` points outside). The orchestrator commits and squashes WIP with `git reset --soft`.
- `just gate`'s pack-check clones the committed HEAD: commit before gating, or a WIP commit's errors fail it.
- The node test reporter may print `ℹ pass` rather than `# pass` in the sandbox, so grep for both.
- A max-thinking `review` worker given a diff file under `.doctrine/state/` plus the plan's EX/VT criteria found real defects in five of six phases. Ask it to verify each finding and to reserve its last call for the answer.
- Before PHASE-01 of SL-002 shipped, a write agent rooted at the server's launch directory was refused (ISS-001); a doctrine fork under `.worktrees/` avoided it.

- No solo phase binding runs on this path, so nothing records the phase's source delta. After committing each phase, run `doctrine slice record-delta <slice> PHASE-NN --start <pre-phase commit> --end <phase tip>`; otherwise `slice conformance` reads every selector undelivered at audit. SL-002 bootstrapped all six rows at audit (RV-009 F-6). A phase sheet scaffolded before an earlier phase landed carries a stale start stamp, and `--commit` then needs `--force`.
- `slice verify-vt` matches each VT criterion's keywords literally against its test file. Put the plan's keywords in test titles while writing them; SL-002's audit renamed seven titles (RV-009 F-3).

- Briefs: Claude's scratchpad (`/tmp/claude-*/…`) is invisible inside the pi sandbox (it sees only its cwd). Write long briefs and spec extracts under `.doctrine/state/slice/NNN/phases/` (gitignored) and pass the relative path (SL-004 PHASE-06).
- Contract tests from pi often pass against plausible wrong implementations: a hang guard equal to the wait's own timeout, order fixtures that cannot tell two orderings apart, boundary slack. Read every test and run mutation controls before the code run (SL-004 PHASE-05/06).

- Refactors: a worker's "order/behaviour preserved" claim is not evidence. A `review` worker running the old (HEAD) and new code side by side on generated inputs caught a policy check-order regression the suite missed (SL-005 PHASE-04, RV-017). Run one per risky production refactor.
- `just gate`'s nix-build sees only git-tracked files: a new source file needs `git add -N` (intent-to-add) before gating an uncommitted tree (SL-005 PHASE-03).
