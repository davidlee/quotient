# quotient: orchestrating `pi_agent` runs

For a caller that drives many `pi_agent` runs as an orchestrator. It builds on
the agent section (`quotient help agent`) and does not repeat it.

Spend your own context on judgement and on the verification only you can do;
delegate the rest. Profiles may differ in model, thinking level, tools and
capability: choose one per task from the profiles table, by what the task
needs.

## Before the first real run

- Probe the confinement once, under a read profile, with a few requests: which
  tools exist (`command -v`; `which` may be absent), whether the network works,
  and whether the root is writable under a write profile. Plan around the
  answers: a step the form cannot run is yours.
- Stay under the per-run maxima in the agent section. A call above one is
  refused, not clamped.
- Changing a project's form (packages, binds) needs the operator to approve it
  again with `quotient allow` and to restart the server. Batch such changes.
  Prefer running a step yourself over widening confinement.

## Who does what

- A write profile: edits — drafts, tests, code, refactors, review fixes.
- A read profile: recon, analysis and review. Give a reviewer the diff, the
  criteria and the design references, not your opinion of them.
- You: the steps the form cannot run, every gate, adjudicating findings, and
  anything that records a decision or a user's assent.
- A stronger agent: after the same task fails twice, or when the task needs
  more adherence than the profile's model gives.

Do the work yourself when the brief would cost more than the work: a small
edit, or a tight build loop only you can run, where relaying each error doubles
the round trips.

## Writing a brief

- State the task, the files it may and may not touch, and a done-check: the
  commands to run and the result to expect. Point at files with line ranges
  rather than pasting them.
- Give a request budget and a point to answer by ("answer by request ~40").
  A delegate that explores freely, a reviewer especially, reaches the ceiling
  before it answers.
- Say what the answer reports: files changed, observed failure reasons,
  uncertainties.
- When a test is a contract, have one run write the test from the
  specification and another write the code. Ask for red-first evidence: the
  failure output, failing for the right reason.
- Say what runs concurrently. Parallel runs in one tree must touch disjoint
  files, and still contend for shared build locks and caches.

## Concurrency and lanes

- Fan out work whose parts do not depend on each other: recon over separate
  areas, reviews of one diff against different criteria. Start each part and
  collect them as the agent section's "Running several at once" describes.
- Queue steps in a lane when they must run in order and you have nothing to
  decide between them. Use `needs_success` only for such mechanical chains
  (generate, then build, then test), where a failed step makes the rest
  pointless.
- When a step's result needs your judgement before the next one starts —
  findings to adjudicate, a draft to check — do not queue the next step ahead
  of it: a queued run carries a brief written before you knew what the step
  before it found. Start the next step once you have read the result.
- A lane cannot continue one `session`: the second start finds the session
  owned and is refused. Start a continuation after the run before it settles.
- Lanes order runs; they do not keep writers apart. Keeping concurrent writers
  in one tree on disjoint files stays your job.

## When a run stops short

A run that ends with `final: false` (a ceiling, a timeout): continue its
`session` with a short prompt ("stop probing; combine commands; finish X;
answer now") and a small ceiling. Restarting loses the context the session
holds.

## Verification that stays yours

- Re-run every gate yourself: tests, type checks, lint, builds. A delegate's
  "green" is a claim.
- Read security-relevant code and every test that defines a contract. Ask of
  each test whether it would still pass against a plausible wrong
  implementation; when unsure, run a negative control.
- Verify a severe review finding by probe before acting on it, and settle each
  finding: fix it, defer it to a named home, or accept it with a reason.
- Keep a log of each run (profile, cost, outcome, what the delegate got wrong)
  and tune later briefs from it.

## Making it your own

Override this section with `$XDG_CONFIG_HOME/quotient/help/orchestrate.md`,
like any other help section. To keep your own version as a skill or prompt
instead: `quotient help orchestrate > SKILL.md`, then edit it.
