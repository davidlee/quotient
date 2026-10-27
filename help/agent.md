# quotient: delegating with `pi_agent`

`pi_agent` runs one pi agent, usually on a cheaper model, and answers with a
reduced transcript rather than the agent's raw output. Delegate bounded work
that does not need your judgement: recon across many files, a first-pass
review, a mechanical edit. Keep your own context for deciding what the answer
means.

- Call it with a `prompt` and a `profile` from the table below. `cwd` defaults
  to the server's launch dir; the operator's policy decides which roots are
  allowed. `tools` and `ceilings` can only narrow what the profile and the
  policy allow.
- Trust `result` only when `final` is true. Otherwise read `state`, `causes`
  and `transcript` to see how the run ended.
- A `refused` state means nothing ran; `refusal.reason` says why, and
  `refusal.detail` names what failed, for the operator. Retrying a refusal
  unchanged gets the same refusal while what it names still holds:
  `session-busy` clears once the run holding the session settles, and
  `lane-predecessor-failed` and a refusal at launch depend on what ran before,
  not on the request alone. `form-unapproved` and `form-invalid` need the operator: a project's
  form is approved by hand with `quotient allow`, so no retry clears them.
- Pass the returned `session` back to continue the same conversation.
- Ask for batched reads and a capped answer: a delegate that reads one file per
  turn exhausts its request ceiling before it answers.
- The evidence for every run is under `artifacts.dir`.
- `final: true` and `status.accounting: "known"` do not mean every request had
  a measured context footprint. Check `status.context.requests_unmeasured` and
  `status.context.peak_tokens`; a context gap leaves the peak as a lower bound.

**Running several at once**

- Start each run with `pi_agent_start` and a `key`: it answers a handle at
  once, and a start retried with the same `key` and arguments answers the same
  run rather than a second one.
- Collect with `pi_agent_wait`, naming your ids in `runs`, with
  `until: "any"`, in a loop. Keep `timeout_s` below your client's tool-call
  timeout (the default is 45 s); a wait that times out is simply repeated.
- Drop each id once its result is used, or once it is `lost` or listed in
  `unknown`. A wait by name needs no `pi_agent_ack`.
- Only to recover ids you lost (a start whose answer never arrived, a
  restarted conversation): a wait with no `runs` or `lanes` reports every
  `pi_agent_start` run no one has acknowledged; `pi_agent_ack` each one you
  have used, so it leaves that list.
- For steps that must run in order, give them one `lane`; add
  `needs_success: true` to refuse a step whose predecessor did not complete.
- A client that declares MCP tasks needs none of this: `pi_agent` answers it
  a task, which it polls.

`quotient help orchestrate` is the guide for driving many runs: briefs,
recovering a run that stopped short, and the verification that stays yours.

`quotient help result` is the full result/2 and status/3 contract, including
context gaps, cost accounting, states, causes and refusals.
