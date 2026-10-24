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
  unchanged gets the same refusal. `form-unapproved` and `form-invalid` need
  the operator: a project's form is approved by hand with `quotient allow`, so
  no retry clears them.
- Pass the returned `session` back to continue the same conversation.
- Ask for batched reads and a capped answer: a delegate that reads one file per
  turn exhausts its request ceiling before it answers.
- The evidence for every run is under `artifacts.dir`.
- `final: true` and `status.accounting: "known"` do not mean every request had
  a measured context footprint. Check `status.context.requests_unmeasured` and
  `status.context.peak_tokens`; a context gap leaves the peak as a lower bound.

`quotient help result` is the full result/2 and status/3 contract, including
context gaps, cost accounting, states, causes and refusals.
