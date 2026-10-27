# PRD-001: quotient — delegation under operator authority

<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## 1. Intent

An agent such as Claude Code or Codex spends its own, expensive context on
everything it does, including work that needs no judgement: recon across many
files, a first-pass review, a mechanical edit. That work could go to a cheaper
model running in pi. Calling pi directly gives the agent no confinement (a
delegate can read and write whatever the user can), no usable signal (nothing
until it ends, or a verbose event stream), and no way to run, queue or cancel
several delegations.

quotient is a stdio MCP server that closes that gap. The calling agent starts
pi runs, waits on them, and reads back a compact account of each. The
operator — the human who installs and configures quotient — decides, in
configuration no delegate can write, where delegates may work, which delegate
profiles exist, how much each run may spend, and what confines it.

Desired end state: an agent delegates routinely and cheaply, the operator
trusts that no delegate can exceed what was granted or rewrite the record of
what it did, and neither needs a skill, plugin or bespoke prompt to get there.

Two actors recur throughout:

- **Calling agent** (the orchestrator): chooses the task, profile, root and
  narrower limits per call; reads results; keeps judgement and verification.
- **Operator**: writes the policy and profiles, approves project forms,
  chooses the forms. Holds all authority; the calling agent holds none it was
  not granted.

The **delegate** is the pi process a run starts. It is untrusted: it may try to
widen its own powers, choose what confines it, or edit its own record.

## 2. Scope

In scope:

- Delegating one bounded task per run, with a reduced account as the answer.
- Running several delegations concurrently, in ordered lanes, and cancelling
  them.
- The operator's configuration: policy, profiles, approvals of project forms,
  overridable help.
- The contract a confining executable (a *form*) must meet, and how a form is
  selected for a run. Building forms is the operator's concern; quotient
  documents one way to build them.
- Durable evidence of each run and each refused attempt.
- Self-explanation to the calling agent and the operator.
- The stand-alone reducer.

Out of scope:

- Confinement itself. quotient selects and launches a form and checks what it
  can of the child's view; the form does the confining.
- Choosing, hosting or brokering models and credentials. pi is a
  prerequisite, not a dependency; a model broker is optional.
- Judging the quality of a delegate's work. Verification stays with the
  calling agent.
- Bounding the number of runs in flight (see §6 Non-guarantees and OQ-4).
- Multi-host coordination. Servers may share a run directory on one host; a
  run owned by a server on another host cannot be judged lost.

Boundaries:

- One run, one pi process, one root. Work that needs two trees is two runs.
- Authority is whatever the operator's configuration grants at the moment a
  run is admitted or launched. Nothing a delegate writes enters that
  configuration.

## 3. Principles

- **The delegate is untrusted.** Every input that decides a run lives where no
  delegate can write it, and the run's evidence is out of its reach.
- **The operator's word is never downgraded.** A configuration quotient does
  not fully understand refuses; it is never read as the nearest thing quotient
  does understand.
- **Fail closed, first failure wins.** What cannot be established refuses, and
  the refusal names the first check that failed.
- **A caller can only narrow.** Per-call limits, tools and budgets may tighten
  what the operator granted, never widen it.
- **Approval is selection.** A project's own form runs only as the exact
  identity the operator recorded; there is no fallback to something else.
- **State lives on disk, not in memory.** A reported status reads the same
  from any server, before and after any server exits.
- **Say what is not guaranteed.** Every limit of the guarantees is stated where
  an operator will read it, not left for them to discover.
- **The tool explains itself.** Guidance ships with the binary and reaches the
  agent through the protocol; no skill is required to use it well.

## 4. Requirements

The functional and quality requirements this capability must satisfy are
recorded as requirement entities and appear under the synthesized Requirements
section below. This section carries only the constraints and invariants that
bound every valid implementation.

Constraints:

- quotient is a stdio MCP server; the client owns its lifetime through stdin.
- pi is invoked as an external program; quotient does not embed or fork it.
- quotient ships no forms. A form is the operator's choice; quotient defines
  what a form must guarantee and stays agnostic of how a form achieves it
  (a jail, a platform sandbox, or a hand-written launcher).
- Configuration that decides a run is read from the operator's configuration
  location only, never from the project tree a delegate works in.
- Every document quotient emits or reads is a versioned, shipped contract.
- Shipped text (docs, help, examples, README) is self-contained: it cites no
  internal planning identifiers.

Invariants:

- Nothing a delegate writes can raise any run's powers.
- A run admitted again at launch can be refused or narrowed, never widened,
  and keeps the root, session and capability it was admitted with.
- A root governed by an operator approval runs exactly the approved form
  identity or refuses.
- Once a run is reported settled, its status never changes.
- No run outlives the server that started it.
- Every way a running run stops goes through one termination path and one
  audit record.

## 5. Success Measures

Outcomes:

- An agent configured with only the MCP server sets quotient up, delegates,
  and orchestrates many runs from quotient's own help, with no skill or
  prompt file.
- Delegated runs cost materially less than the calling agent doing the same
  work, at quality the calling agent's verification accepts.
- The operator can answer "what did that run do, under what grant?" from the
  evidence alone, after the fact.

Signals:

- Refusals are resolved by the indicated party (caller or operator) without
  reading source code.
- No observed run exceeds its grant: no write outside its writable set, no
  run under a capability or form the operator did not choose.
- Runs stopped short are continued through their session rather than
  restarted.

Acceptance gates:

- The release gate (`just gate`) is green: unit tests, contract drift tests,
  and form-family checks.
- The shipped contracts match the implementation in both directions
  (refusal reasons, result fields and states, policy keys, approvals format).
- The write-denial probe passes against each form the project ships guidance
  for.

## 6. Behaviour

**Delegate one task (blocking).** The calling agent calls `pi_agent` with a
prompt, a profile and optionally a root, session, tools and tighter limits. The
call is admitted against the policy, the profile's capability pin, the root
allowlist, the form selection, the limits, the session and the child's view.
Admitted, the run launches pi inside the selected form, is bounded by its
limits, and settles with a result. A client that declares MCP tasks receives a
task at once and polls it instead of blocking.

**Delegate several (non-blocking).** The agent starts each run and gets a
handle at once; a `key` makes a retried start answer the same run. It waits on
named handles for any or all to settle, within a timeout, receiving results
within a byte budget; results that do not fit come back on a later wait. A run
given a lane waits for the run started before it in that lane to settle;
`needs_success` refuses it if that predecessor did not complete, and the
refusal cascades. Queued runs are admitted again when they launch.

**Recover lost handles.** A wait naming no runs reports every started run no
one has acknowledged; acknowledging a used run removes it from that list.

**Cancel.** Cancelling marks a run before anything is awaited, so a lane never
launches a run about to be cancelled. A queued run settles without launching;
a running run is stopped through the one termination path. A run that
completes before the stop reaches it reports completed.

**Continue.** Naming a previous run's session continues that conversation, in
the same root and capability. A busy session refuses.

**Refusal.** Any failed check answers with a refused result naming the first
failed check. Nothing ran. The calling agent decides from the reason whether
to change the request, retry later, or tell the operator.

**Operator setup.** The operator writes the policy (roots, profiles and their
capabilities, limits, forms), installs profiles, and approves any project
form by hash. Without a policy every call refuses. The policy and approvals
apply from the next call; profile and help changes apply at the next server
start.

**Client goes away.** Stdin closing or a signal stops reading, stops every
running run, settles every queued one without launching, and answers nothing
further. Each run still records its outcome.

**Recovery across servers.** Any server sharing the run directory answers for
a run another server, or an earlier process, started: settled from its result,
lost only on positive evidence, otherwise still working.

Non-guarantees (stated, not hidden):

- The form does the confining; quotient's check of the child's view is only
  as sound as the form's promise.
- An approval's digest covers the form's bytes only.
- A root or `cwd` spelled through a symlink a delegate can rewrite is
  governed where it lands.
- Limits are enforced after each request, so a run can overshoot by the
  request that crossed a limit; the wall clock is the hard backstop.
- There is no bound on runs in flight; concurrency multiplies spend.
- Waits that name no runs are per server, not per caller.
- A run owned by a server whose death cannot be judged reads as working
  until its result lands.
- An unconfined form gives up every confinement guarantee.

## 7. Verification

Behaviour is proven at three levels.

Contract conformance is mechanical: drift tests hold each shipped contract and
the implementation equal in both directions (refusal reasons, result fields
and states, the cause-to-state table, policy keys and environment variables,
the approvals format), and reject internal identifiers in shipped text. These
carry REQ-008 and REQ-015.

Behaviour is proven by tests against a scripted stand-in for pi, covering
admission order and fail-closed refusals (REQ-004, REQ-006, REQ-007, REQ-012),
lane order and cancellation (REQ-002), protocol eras and tasks (REQ-003),
shutdown (REQ-014), and recovery of runs from disk across servers (REQ-010,
REQ-013).

Confinement is proven against real forms: form-family checks read built
launchers and refuse those that break the form contract, and the write-denial
probe samples the form's promise from inside a run (REQ-005). These sample the
promise; they do not prove a form sound, and §6 says so.

Self-explanation (REQ-009) is reviewed: a fresh agent given only the server
completes setup and a delegation from quotient's help. Cost and quality of
delegation (§5 Outcomes) are judged by the operator from run evidence, not
gated.

## 8. Open Questions

- OQ-1 — Does a profile carry standing instructions to its delegate, beyond
  configuration? Today the profile body is notes for humans and the caller's
  prompt is the delegate's only instruction. Blocks the profile's product
  definition in the Config and profiles spec; that spec must leave the body's
  role open. (Backlog: IMP-012.)
- OQ-2 — Should a refusal point the calling agent to the help that resolves
  it (setup for a missing policy, the policy reference for an invalid one)?
  Affects REQ-008's acceptance and whether the refusal envelope grows a
  field. (Backlog: IMP-013.)
- OQ-3 — What should a running run report while it works, and to whom: the
  calling agent deciding whether to cancel, or the operator watching spend?
  Blocks any in-flight fields on the run document; such fields must be
  additive. (Backlog: IDE-007.)
- OQ-4 — Should the operator be able to bound the number of runs in flight?
  Today it is a stated non-guarantee. (Backlog: IDE-005.)
- OQ-5 — Which platforms get documented form guidance beyond Linux with Nix
  (macOS Seatbelt; a hand-written form)? The form contract stays
  backend-agnostic regardless. (Backlog: IMP-008.)
