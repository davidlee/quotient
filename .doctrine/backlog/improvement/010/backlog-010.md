# IMP-010: Orchestration guide as a built-in help section

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Ship a built-in `quotient help orchestrate` section: how a caller drives
several `pi_agent` runs as an orchestrator — what to delegate, how to brief,
how to recover a run that stopped short, and which verification stays with
the caller. It is read on demand, not loaded into every session like
`help/agent.md`; `agent.md` gains one line pointing to it.

A help section (a `file` source in `src/help/help.ts`), not a shipped skill
file: it reaches every MCP client and the CLI from one source, and the
existing per-section XDG override applies. A user who wants it different can
`quotient help orchestrate > SKILL.md`, edit it, and install it as their own
skill.

## Source

The user-level skill `~/.claude/skills/pi-orchestrate/SKILL.md` (written by
another agent, 2026-10). Lift its portable core; leave the rest behind.

Keep (generalised):
- Probe the confinement once before the first real dispatch (which tools exist
  — `command -v`, not `which`; whether network works; whether the root is
  writable under a write capability). Anything the form can't run is the
  caller's own step.
- Stay under the per-run maxima shown in the tool description (IMP-009).
- Changing a project's form means re-approval (`quotient allow`) and a server
  restart: batch such changes; prefer running a step yourself over widening
  confinement.
- Briefs: the task and its done-check (commands + expected result); which files
  it may and may not touch; point at files with line ranges rather than pasting;
  "read in one batch"; a request budget with a point to answer by; a capped
  answer that says what to report.
- Tests and code from separate runs when the test is a contract; require
  red-first evidence that fails for the right reason.
- Parallel runs in one tree must be file-disjoint, and still contend for shared
  build locks.
- A run that ends `final: false` or `ceiling_exceeded`: continue its `session`
  with a short "stop probing, finish, answer now" prompt and a small ceiling,
  rather than restarting.
- Verification stays with the caller: re-run every gate; read the
  security-relevant code and every contract-defining test; ask whether a test
  would pass against a plausible wrong implementation, and run a negative
  control when unsure; verify severe review findings by probe before acting.
- Do it yourself when the brief would cost more than the work.
- For review, give the reviewer the diff, criteria and design references — not
  your opinion of them.

Leave out:
- Profile names. Profiles are operator-defined and may be replaced entirely;
  describe roles by capability (a write-capable profile for edits, a read
  profile for review/recon) and point at the profiles table.
- Any assumption that profiles share one model or thinking level — they need
  not. Speak of the profile's model, not "the delegate model".
- Harness- or vendor-specific escalation ("Sonnet/Opus subagent"); say
  "escalate to a stronger agent after repeated failure on the same task".
- Doctrine bindings (stage skills, criteria ids, slice notes, memory,
  recording user acts). They belong in a thin overlay outside quotient that
  cites this section.
- Project anecdotes stated as rules (gleam `build/`, `function_clause`,
  nixpkgs clones, nix-daemon sockets). At most, one generic example each.

Don't restate `help/agent.md` (batched reads, capped answers, passing
`session` back, refusals): build on it.

Done when: the section renders via `quotient help orchestrate` and is listed
by `quotient help`; `help.test.ts` covers it and the override layer; the README
help list names it; the user-level skill can be replaced by a three-line
pointer plus the doctrine overlay.
