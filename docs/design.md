# Design rationale

Why quotient is shaped the way it is. This document explains; the contracts
in `docs/contract/` define. Where the two seem to disagree, the contract wins.

quotient is a stdio MCP server whose tools start pi runs, wait for them,
acknowledge them and cancel them. An agent uses it to delegate a bounded piece
of work to a cheaper model: each run is one pi process, confined by a form the
operator chose, under limits the operator set, and settles with a reduced
transcript, a status and a verdict. `pi_agent` is the blocking form, start and
wait in one call; to a client that declares MCP tasks it answers a task
instead, which the client polls.

## One process per run, one root per run

Every run starts a fresh pi process and ends it before it settles. A run may
outlive the call that started it, but never the server. There is no
long-lived delegate to drift, leak context between callers, or hold resources
after its client has gone: when the client goes away, every run settles (see
One termination ladder). Continuity, where it is wanted, is pi's own session
file, named by the run (see Sessions).

Each run names one root, the directory the delegate works in. A form confines
exactly that root, so what a run could touch is decided by one path the
operator allowlisted and the caller chose. Work that needs two trees is two
runs.

Starting and waiting are separate tools because of how clients schedule calls.
A client overlaps two tool calls only when the tool declares itself read-only,
and a tool that starts write-capable runs cannot honestly declare that. A
blocking call is also bounded by the client's patience. So starting answers at
once with a handle, and waiting is the read-only half: `pi_agent_wait` changes
nothing, is the only tool marked read-only, and one wait covers any number of
runs.

## Two protocol eras, chosen per request

quotient speaks two revisions of MCP at once. The legacy era is the
`initialize` handshake at 2025-06-18, served exactly as before; Codex and older
clients use it. The modern era is the 2026-07-28 revision, which is stateless:
every request carries its protocol version and the client's capabilities in its
own `_meta`. Only the modern era has tasks, so only a modern request that
declares the tasks extension gets a task from `pi_agent`; every other request
gets the blocking answer.

The era is decided per request, from that request's `_meta`, never per
process. The specification permits one server to serve both, a per-request rule
adds no state to keep consistent, and a legacy client keeps working untouched
however other clients of the same server speak. A version the server does not
serve is an error naming the one modern version it does, rather than a silent
fallback.

## Results live on disk

Every run that settles writes its result document, `result.json`, into its
evidence directory: to a temporary file, then renamed into place, so a reader
sees no file or a whole one. The server's registry holds a compact record per
run and never a result, so memory grows with the number of runs, not with the
size of their answers.

A handle the registry does not hold, from before a restart or from another
server sharing the run directory, is resolved from disk. Each run records its
owner when it is admitted: the server's pid and start time, and the host, boot
and namespaces in which those mean something. A run with a result is settled.
A run without one is `lost` only on positive evidence that no result can still
arrive: a published `lost` record, or an owner confirmed dead. Otherwise it
belongs to another live server and reads as still working, and a result that
exists but cannot be read now is reported as unreadable, with no status, until
it reads.

The reason is that a task's terminal status must read the same before and
after the server ends. A status derived from memory would vanish with the
process; one derived from a file, a published record and a confirmed death
cannot change once given. The cost is stated: a dead owner the server cannot
judge, on another host or in another pid namespace, leaves its unfinished runs
reading as working.

## Lanes

A lane makes runs execute strictly one after another, in the order they were
started. Naming a lane is the only way to opt in; unlaned runs launch as soon
as they are admitted. Lanes exist per server process and need no declaration.

- **FIFO, one executing.** A run launches when the run started before it in
  its lane has settled. A cancelled run is skipped.
- **`needs_success` cascades.** A run with `needs_success` launches only if
  its predecessor completed; otherwise it is refused
  `lane-predecessor-failed`. That refusal is itself not a completion, so a
  failure cascades down the lane until a run without the flag. The check runs
  wherever the run is placed, so it gives the same answer whether the
  predecessor failed before or after the start.

Lanes order runs; they do not order judgement. A step that needs the caller to
look at the previous result should be started after reading it, not queued
ahead.

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

The wall clock is the hard backstop. It starts when the run launches, not when
it was started into a lane. It holds whatever the stream says, and it also
catches a delegate that has gone quiet: the server evaluates its limits about
once a second even when no record arrives.

Each run is bounded; the number of runs in flight is not. Concurrency
multiplies spend, and the policy has no bound on it.

## Roots are an allowlist, compared by path component

A run's root is canonicalised (symlinks resolved) and must be an allowlisted
directory or inside one. Containment is compared by path component, never by
string prefix, so allowing `/home/u/work` does not allow `/home/u/work-other`.

## Profiles are live authority, frozen at start-up

A profile names a delegate: its model, its thinking level, its tools, and the
filesystem capability it needs. Profiles come from one place,
`<xdgConfig>/quotient/profiles/`, and so does help. An earlier version also read
a project layer from the launch directory, which put authority inside the tree
a delegate works in; a server that finds one now fails start-up instead.

That makes a profile document authority, and two rules keep it safe:

- **Frozen at start-up.** Profiles are read once, when the server starts. A
  delegate that could edit a profile and have the next run use it would be
  choosing its own successor's powers. A restart is the operator's act.
- **Capability from the document, pinned by the policy.** The document says
  whether its delegate reads or writes; the policy says, per profile name,
  which it may. A mismatch refuses, so no profile document can raise its own
  capability, and a profile can only narrow what the policy grants.

The directory is a protected store: a write delegate's view may not include it,
so it cannot plant a profile for the next start-up either.

Authority is judged when it is exercised. A run that waited in a lane is
admitted again when it launches, against the policy and approvals current then:
the switch, the profile's pin, the root, the form and its approval, the
ceilings, the child's view. It can be refused at launch, and its ceilings and
transcript budget can be narrowed to the current maxima, but never widened. It
keeps the root, session and capability it was admitted with: re-admission can
refuse a run but never moves it.

## A project form is approved, not adopted

A project may substitute the executable that confines its own root: a link at
`<root>/.quotient/forms/{read,write}`. Nothing about that is automatic. The
policy still decides where a run may execute, and the operator records the
executable's real path and digest by hand, so a delegate that can write the
project can repoint the link and change nothing that runs. Until it is recorded
the root refuses, and only `quotient revoke` returns it to the machine form.

What the digest covers is the executable's bytes: what the form reads or execs
when it runs must be embedded in it or kept where no delegate can write, and an
approved form must be immutable to every delegate on the host. The rule, the
selection table and the operator's obligations are in
`quotient-approvals-1.md` and `quotient-policy-2.md` (Project forms).

## One termination ladder

Every way a running run can be stopped goes through one sequence: SIGTERM to
the run's process group, a 2-second grace, SIGKILL to the group, reap, drain
the streams, write the audit record. A cancellation (of the request, the
handle or the task), the client going away, a failed evidence write, a crossed
ceiling, the wall clock, the operator's switch and the server itself being
signalled all hand the same ladder a cause. A queued run has no process to
stop: cancelling it, or the client going away, settles it without launching.

The run is its own process group, so the signals reach everything the delegate
started and nothing else. There is one shutdown path, so there is no second
one to fall out of step with it.

Cancelling marks the run before anything is awaited, so a lane never launches
a run a cancel is about to reach. The mark is intent, not outcome: a run that
completes before the ladder reaches it reports `completed`, and its status
comes only from `result.json`.

A request the client cancels gets no reply. What else happens depends on what
it asked for: a cancelled blocking `pi_agent` still ends its run, whose
outcome is in `result.json`; a cancelled wait ends only the wait; a cancelled
start leaves its run standing, to be found by its key or a wait.

The client going away (EOF on stdin, a failed input, SIGTERM or SIGINT) is one
trigger. The server stops reading, aborts every running run, drops every
queued one, and writes no further replies, including to requests it had
already read. Each run still writes `result.json`, so a later server reports
it settled rather than lost. Nothing outlives the server, so a client must keep
stdin open until it has read the replies it wants: closing it is how quotient
learns the client has gone.

## Sessions

A run may name a session to continue a previous one; otherwise it starts a
new one, and the result names it. A session is a directory the form makes
writable, holding pi's own session state.

- **One owner at a time.** Ownership is an exclusive file create, so it holds
  across separate server processes sharing one session home. A second run on
  a busy session refuses rather than waiting or interleaving.
- **Owned from start until settled.** A run takes its session when it is
  admitted and releases it only when it settles, so a queued run holds its
  session while it waits. Lanes queue runs, never sessions: a lane cannot chain
  several runs on one session, because the second start finds the session
  owned. To continue a conversation, start the next run after the previous one
  settles.
- **Bound to its first root and capability.** A session first used by a read
  run in one root cannot be continued by a write run, or in another root.
  Continuing a conversation never widens what it can touch.
- **Stale owners are reclaimed carefully.** A lock whose owner is gone is
  replaced atomically, so no reclamation can delete a live successor's lock.
  When the server cannot tell whether the owner is alive, it refuses and
  leaves the decision to the operator.

## The audit split

There are two kinds of evidence, kept apart:

- **The attempts ledger** records attempts that spawned nothing: a call
  refused before a run existed, and a run refused at launch, by re-admission or
  `lane-predecessor-failed`. What was asked, and why it was refused.
- **The run's audit** records a run that was admitted. It opens with
  `admitted`, written before the call answers: the publication line, naming the
  run's owner, its lane and its session. From that record on, the run has been
  promised to someone and its directory is never deleted; every later failure
  settles as a result, never a disappearance. Then the `spawn` record, written
  before the launch, names what was launched under which policy and profile;
  then any `abort` with its cause and the usage known at that moment; then the
  `exit`. A run that never launched records why instead: `refused` (at launch),
  `cancelled` (cancelled while queued) or `dropped` (queued when the client went
  away). `lost` records that `result.json` could not be written, so that every
  server reads the run as lost rather than as still working.

If the `admitted` record cannot be written, the call refuses `audit-failed` and
nothing is published. If the `spawn` record cannot be written, nothing is
launched, and the run settles as an `audit-failed` refusal in its directory.

A form-1 form makes both unreachable from inside the run, because evidence a
delegate could edit would not be evidence. The unconfined form gives this up
with everything else.

## Validation order: fail closed, first failure wins

A run passes a fixed sequence of checks before anything executes: the policy,
the switch, the profile, the root, the form, the ceilings and tools, the
session, and the child's view. The first failure decides the refusal, and the
refusal names it. Anything the server cannot establish, such as a policy it
cannot read, a location it cannot resolve or a ledger it cannot write, refuses.
It is never read as permission.

A refusal is an ordinary tool result, not a protocol error, so a calling agent
reads the reason the same way it reads any verdict. Every tool's refusal is the
same result document, told apart from a handle or a wait answer by its
`schema`.

---

extracted from github.com/davidlee/satan