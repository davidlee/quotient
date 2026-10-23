# Design rationale

Why quotient is shaped the way it is. This document explains; the contracts
in `docs/contract/` define. Where the two seem to disagree, the contract wins.

quotient is a stdio MCP server with one tool, `pi_agent`. An agent calls it to
delegate a bounded piece of work to a cheaper model: one call runs one pi
process, confined by a form the operator chose, under limits the operator set,
and answers with a reduced transcript, a status and a verdict.

## One process per call, one root per call

Every call starts a fresh pi process and ends it before answering. There is no
long-lived delegate to drift, leak context between callers, or hold resources
after its caller has gone. Continuity, where it is wanted, is pi's own session
file, named by the call (see Sessions).

Each call names one root, the directory the delegate works in. A form confines
exactly that root, so what a call could touch is decided by one path the
operator allowlisted and the caller chose. A call that needs two trees makes
two calls.

## The operator's posture is declared, never downgraded

The policy states the posture the server runs in, and the server serves only
the one it implements, `per-call`. A policy that asks for anything else, or
carries a field that only makes sense in another posture, refuses every call.
It is never quietly read as the nearest posture the server knows. The same rule
runs through the whole schema: an unknown field refuses rather than being
ignored, because a field the operator wrote and the server dropped is a control
the operator believes in and does not have.

## Accounting is retrospective

The server counts what the delegate spends from pi's event stream, as each
record arrives, using the usage the provider reported. Request and cost ceilings
are checked against their cumulative totals. The `context_tokens` ceiling checks
the largest measured per-request footprint: input, output, cache-read and
cache-write tokens. Cumulative token totals remain available for accounting.

That is enforcement after the fact, and the ceilings promise less than they
appear to:

- context usage is known only once the request has been made, so a run can exceed
  the context ceiling by the request that crossed it;
- cost is the provider's reported cost, not a price the server computes;
- missing or invalid context usage is disclosed as a measurement gap and does
  not alone stop the run; missing or invalid cost on an ordinary response makes
  cost accounting unknown and stops the run because the cost ceiling cannot be
  enforced.

The wall clock is the hard backstop. It holds whatever the stream says, and it
also catches a delegate that has gone quiet: the server evaluates its limits
about once a second even when no record arrives.

## Roots are an allowlist, compared by path component

A call's root is canonicalised (symlinks resolved) and must be an allowlisted
directory or inside one. Containment is compared by path component, never by
string prefix, so allowing `/home/u/work` does not allow `/home/u/work-other`.

## Profiles are live authority, frozen at start-up

A profile names a delegate: its model, its thinking level, its tools, and the
filesystem capability it needs. Profiles are found in layers, the project's
own over the user's, so a repository can carry the delegates suited to it.

That makes a profile document authority, and two rules keep it safe:

- **Frozen at start-up.** Profiles are read once, when the server starts. A
  delegate that could edit a profile and have the next call use it would be
  choosing its own successor's powers. A restart is the operator's act.
- **Capability from the document, pinned by the policy.** The document says
  whether its delegate reads or writes; the policy says, per profile name,
  which it may. A mismatch refuses. A project's local profile can change the
  model or narrow the tools, but it can never turn a read delegate into a write
  delegate.

The layers are protected stores: a write delegate's view may not include them,
so it cannot plant a profile for the next start-up either.

## One termination ladder

Every way a run can be stopped goes through one sequence: SIGTERM to the run's
process group, a 2-second grace, SIGKILL to the group, reap, drain the
streams, write the audit record. A cancellation, the client going away, a
failed evidence write, a crossed ceiling, the wall clock, the operator's switch
and the server itself being signalled all hand the same ladder a cause.

The run is its own process group, so the signals reach everything the delegate
started and nothing else. There is one shutdown path, so there is no second
one to fall out of step with it. When the client goes away, the server aborts
every run in flight and writes no result, since there is no one to read it;
the audit still records why each run ended.

## Sessions

A call may name a session to continue a previous one; otherwise it starts a
new one, and the result names it. A session is a directory the form makes
writable, holding pi's own session state.

- **One owner at a time.** Ownership is an exclusive file create, so it holds
  across separate server processes sharing one session home. A second call on
  a busy session refuses rather than waiting or interleaving.
- **Bound to its first root and capability.** A session first used by a read
  call in one root cannot be continued by a write call, or in another root.
  Continuing a conversation never widens what it can touch.
- **Stale owners are reclaimed carefully.** A lock whose owner is gone is
  replaced atomically, so no reclamation can delete a live successor's lock.
  When the server cannot tell whether the owner is alive, it refuses and
  leaves the decision to the operator.

## The audit split

There are two kinds of evidence, kept apart:

- **The attempts ledger** records calls that were refused before a run
  existed: what was asked and why it was refused. Nothing ran, so there is no
  run directory to hold it.
- **The run's audit** records a run that was admitted: the `spawn` record,
  written before the launch, names what was launched under which policy and
  profile; then any `abort` with its cause and the usage known at that moment;
  then the `exit`. If the `spawn` record cannot be written, nothing is
  launched.

A form-1 form makes both unreachable from inside the run, because evidence a
delegate could edit would not be evidence. The unconfined form gives this up
with everything else.

## Validation order: fail closed, first failure wins

A call passes a fixed sequence of checks before anything runs: the policy, the
switch, the profile, the root, the form, the ceilings and tools, the session,
and the child's view. The first failure decides the refusal, and the refusal
names it. Anything the server cannot establish, such as a policy it cannot
read, a location it cannot resolve or a ledger it cannot write, refuses. It is
never read as permission.

A refusal is an ordinary tool result, not a protocol error, so a calling agent
reads the reason the same way it reads any verdict.

---

extracted from github.com/davidlee/satan
