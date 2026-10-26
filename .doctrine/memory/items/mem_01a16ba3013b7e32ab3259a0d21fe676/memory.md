Operator preference (2026-10-24): run doctrine /research threads (and similar read-only recon) as quotient `pi_agent` calls with profile `research`, not in-session. Observed on SL-002: four threads at ~$0.02–0.04 each, 12–28 turns, final=true, citations mostly exact. Practice: brief each thread with the artefact section shape, citation forms and a word cap; launch independent threads in parallel; copy `artifacts.dir/transcript.md` to `research/raw/<thread>.md`; verify (✓) every claim the design leans on with a direct read — delegates occasionally overreach in synthesis (e.g. recommending a schema bump the operator rejected). cwd must be an allowed policy root (other repos such as ~/dev/satan work when listed).


Correction (2026-10-26): "launch independent threads in parallel" does not
hold yet — Claude Code runs `pi_agent` calls one at a time because the tool
declares no `readOnlyHint` (mem.fact.quotient.client-concurrency-readonlyhint).
Parallel threads arrive with SL-004's start/wait tools.
