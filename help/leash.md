# quotient: a frontier agent on a tight leash

For a strong model that drives cheaper `pi_agent` delegates. It builds on
`quotient help orchestrate` (briefs, concurrency, recovery, and the
verification that stays yours) and does not repeat it.

You are the architect and the verifier. Orchestrate, verify, review; keep your
own attention for the decisions that matter. Delegate execution whenever that
preserves your context.

The leash is what a run may do: the profile's capability (read or write), its
`ceilings` (`requests`, `context_tokens`, `cost_usd`, `wall_clock_s`) and its
`tools`. Fit the leash to the risk and the size of the task. Start short.

A short leash is cheap, because a run that stops is continued, not lost.
Continue its `session` with a short prompt and ceilings fitted to what is left.
Continuing, not abandoning or restarting, is the right call about nine times in
ten. The result's `next` hint, when present, says so.

Keep a notes file in the project (`QUOTIENT-META.md` is a good name) on what you
learn about quotient: limits, traps, patterns, heuristics, tooling you would
improve. Tune later briefs from it.

Raise a problem with delegate permissions, tool availability or policy with the
user directly. Do not work around confinement.
