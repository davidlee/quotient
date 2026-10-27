```text
`SPEC-003` — Confinement policy
confinement-policy · active · tech
tags: policy, admission, approvals
category: policy
c4 level: component
descends from: PRD-001
parent: SPEC-002
responsibilities:
  - Read, validate and apply the operator policy on every call that would start a run, refusing anything absent, unknown or unreadable.
  - Judge each new run through one fixed admission order, first failure wins, and hand the decided grant to the server.
  - Re-admit a queued run at launch against current authority: refuse or narrow, never widen or move.
  - Keep the child's view off every protected store further than that store allows.
  - Select each call's form from the machine slot, the governing approval and the project link, with no fallback once governed.
  - Own the approvals store: closed format, containment rule, single locked writer, allow and revoke semantics.
sources:
  - typescript src/server/admission.ts
  - typescript src/server/policy.ts
  - typescript src/server/childview.ts
  - typescript src/server/paths.ts
  - typescript src/server/forms.ts
  - typescript src/server/approvals.ts
  - typescript src/approve.ts
  - markdown docs/contract/quotient-policy-2.md
  - markdown docs/contract/quotient-approvals-1.md

```

# SPEC-003: Confinement policy

<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

The operator's authority over runs, as the server applies it: the policy
document, the fixed admission sequence that judges every new run against it,
the child-view check, project-form selection and the approvals store that
records which project form may run.

Admission applies to the two calls that start a run, `pi_agent` and
`pi_agent_start`, and again when a queued run launches. Wait, ack and cancel
start nothing and are not admitted: they validate only their own arguments,
so runs on disk stay reachable when the policy is off or unreadable.

Terms this spec adds to PRD-001 §1:

- **Machine slot**: the policy's `forms.read` or `forms.write` entry, the
  form the operator chose for a capability, with any extensions it grants.
- **Capability pin**: the capability the policy assigns to each allowed
  profile name; the profile document must declare the same.
- **Exposure**: paths the policy says a form makes writable beyond the root
  and session directory (for example a tool cache).
- **Child view**: for the admission check, the paths a delegate may write
  or must be able to read — its root, its active session directory and the
  exposure paths — compared against the protected stores. The form may
  allow further reads and adds a private temp directory; neither is part of
  the check.
- **Protected store**: a file or directory a delegate must not reach, or must
  not write: the run evidence, other sessions, the policy, the approvals
  store, and the profile and help directories.
- **Approvals store**: `approvals.json`, the operator's record of which
  project forms may run, by real path and content digest.

A component of the MCP server container (SPEC-002), realising PRD-001's
operator-authority, confinement-selection, per-run-limit and fail-closed
requirements. The registry, lanes, termination ladder, gate ticks and evidence
writing are SPEC-002's; this spec states only what they consult here and what
this component promises them. Where a form comes from and what it must
guarantee is SPEC-004's; profiles and their snapshot are SPEC-005's; the
command-line shape of `allow` and `revoke` is SPEC-006's.

```
start call ──► start-up ok? ──► request shape ──► key replay? ──► answer the held run
 (SPEC-002)    (SPEC-005)                          (pi_agent_start only)
                                   │ new run
                                   ▼
            1 policy ─ 2 switch ─ 3 profile ─ 4 root ─ 5 form
                                                          │
 refusal (first failure) ◄── ledger probe ─ 8 child view ─ 7 session ─ 6 ceilings/tools
                                   │
                                   ▼
                    admitted: root, capability, form identity,
                    clamped ceilings, tools, session  ──► SPEC-002 registry

queued run at launch ──► steps 1-6 and 8 again (session kept,
                         ceilings narrowed, form re-selected) ──► launch or refuse
```

## Responsibilities

- Read, validate and apply the operator policy on every call that would
  start a run, with no default for anything absent and no tolerance for
  anything unknown.
- Judge each new run through one fixed admission order, first failure wins,
  and hand an admitted call's decided grant to SPEC-002.
- Re-admit a queued run at launch against the policy and approvals then
  current: refuse or narrow, never widen, never move.
- Keep the child's view off every protected store further than that store
  allows.
- Select the form for a call from the machine slot, the governing approval and
  the project's link, with no fallback once an approval governs.
- Own the approvals store: its closed format, its containment rule, its single
  locked writer, and the semantics of `allow` and `revoke`.

## Contracts

Normative text lives in the shipped contracts; this spec does not restate
their tables.

- `docs/contract/quotient-policy-2.md` — the policy schema, the locations of
  every input, caller ceilings, the admission order, the protected stores, the
  project-form selection table and the unconfined form.
- `docs/contract/quotient-approvals-1.md` — the approvals store's format, what
  an approval governs, the `allow`/`revoke` semantics and the write protocol.
- `docs/contract/pi-agent-result-2.md` (Refusals) — the refusal reasons this
  component raises, in the order it raises them. Owned by SPEC-002; this
  component is its main producer.

Interface promises to SPEC-002:

- **An admitted call is fully decided.** Root (canonical), capability, form
  (identity and extensions), clamped ceilings, tools, transcript budget and
  session are fixed at admission and recorded by SPEC-002; nothing downstream
  re-decides them except re-admission.
- **Re-admission is a refusal or a narrowing.** Given an admitted run, it runs
  steps 1–6 and 8 against the current policy and approvals and the start-up
  profile snapshot; ceilings and the transcript budget narrow to the current
  maxima instead of refusing; the session is not re-acquired; root, session,
  capability and tools never change, and the root must still canonicalise to
  itself. The form is selected again: what launches, and what the audit names,
  is the selection at launch.
- **The switch is re-readable on its own.** `enabled` is checked at admission
  and, by SPEC-002's gate, about once a second for running runs; an absent,
  unreadable or malformed policy reads as off.
- **Every refusal is recorded once**, in the attempts ledger, as it is
  decided. If the ledger cannot take the line, the refusal is still the
  answer and the failure is reported on stderr. Because of that, the last
  admission check probes that the ledger is writable and refuses
  `audit-unavailable` if not: a server that could not record a refusal must
  not start a run it could not audit.

## Concerns

- **The delegate is the adversary.** Every input that decides a call is a
  protected store or lives outside every writable path; a protected store is
  protected whether or not it exists, so a delegate cannot create one to be
  read at the next start-up.
- **Containment is by path component on canonical paths.** One canonicalise
  and one containment predicate serve both the root allowlist (step 4) and the
  child-view check (step 8), so the two cannot disagree; `/work/one` never
  contains `/work/oneevil`.
- **A broad root is legal.** An operator may allowlist `$HOME` or `/`, so the
  child-view check is disjointness over the union of root, session directory
  and `exposure`, not "no bind names the evidence".
- **Step 8 is only as sound as the form.** It trusts `exposure` as the whole
  of what the form adds writable and treats every entry as writable. A form
  that adds more is outside what this component can see (SPEC-004).
- **Approval is the selection.** A governed call runs exactly the recorded
  identity or refuses. Deleting the link refuses (`form-invalid`); only
  `revoke` ungoverns. This closes downgrade-by-deletion.
- **Swap race.** A usable project form's real path must lie outside every path
  a delegate admitted under the policy can write (roots, `exposure`, session
  home), so it cannot be swapped between digest and launch by those delegates.
  Delegates of another policy or server are the operator's obligation: an
  approved form must be immutable host-wide.
- **The digest covers bytes only.** Inputs a form reads at run time must be
  embedded or delegate-immutable; quotient cannot check that.
- **Relocation.** A `cwd` through a delegate-writable symlink is governed where
  it lands; the selection is decided on the canonical root, never the
  spelling.
- **Store integrity.** A malformed approvals store refuses every call that
  reaches form selection (`form-unapproved`), and the verbs refuse to
  overwrite it. The lock serialises operator commands; it is not a security
  boundary and is never reclaimed automatically.
- **Cost of a refusal.** Probing an unapproved link digests the target in full
  before the approval is consulted (RSK-001): a delegate-planted link to a
  very large file makes calls in that root slow to refuse.

## Hypotheses

- H1 — An orchestrator able to run `quotient allow` is trusted as the
  operator. quotient cannot tell them apart and does not try; the digest is
  the confirmation and there is no prompt.
- H2 — One policy file per server is the right unit of operator authority.
  A project needing a different toolchain uses a project form, or its own
  server and policy (IDE-001 would relax this).
- H3 — Retrospective, per-run ceilings plus a hard wall clock are an
  acceptable spend control; concurrency is left to the caller (IDE-005).
- H4 — Fail-closed refusal is preferable to any default: an operator who meets
  a refusal fixes the configuration; an operator who meets a silent default
  believes in a control they lack.

## Decisions

- **One posture served, never downgraded.** `per-call` only; another mode, or
  a static-only field, refuses `posture-unsupported`.
- **Closed-world documents.** Unknown fields refuse in the policy, its
  `maxima`, its form objects, caller `ceilings` and the approvals store.
- **Only an unset location falls through.** A set-but-empty or relative
  `QUOTIENT_*` location refuses `policy-unavailable`; nothing is defaulted
  from the caller's working directory, and the policy is never looked up in
  the project tree.
- **Caller ceilings refuse above the maximum; re-admission clamps.** A call
  asking for more than the maximum is refused, not clamped; a queued run whose
  maxima shrank before launch is narrowed, not refused.
- **Project forms substitute the executable, not the slot** (DEC-010). A
  project form inherits the machine slot's extensions, cannot add one, and
  cannot replace an unconfined slot.
- **Approval by identity, governed by containment** (DEC-008). The deepest
  approval for the capability whose root contains the call's canonical root
  governs, whether or not that root is still in `roots`. `allow` will not
  record where a deeper approval would keep governing.
- **`revoke` addresses a stored key.** It reads neither the policy nor the
  filesystem, so a moved or deleted root can still be revoked and a parent's
  approval is never reached by resolving a path.
- **One writer, lock then rename.** The verbs write under an exclusive lock,
  validate the new list through the same reader, publish by rename, and clean
  up on every path.
- **Unconfined is a named slot, write only.** It is never a fallback, never a
  project form, and gives up every confinement guarantee; step 8 still runs.
- **Breaking is defined by grant.** A policy change is breaking — a new schema
  version — when it changes what an existing document grants or selects
  without an operator act.

## Open items

These must stay open; this spec does not foreclose them.

- **IMP-013 — refusals that point to their fix.** Step 1's
  `policy-unavailable` and `policy-invalid` (and other operator-fixable
  refusals: `profile-*`, `form-*`) may name the help section that resolves
  them. Nothing here fixes the wording or envelope of `refusal.detail`; a
  pointer in `detail` needs no contract change, a new field is SPEC-002's
  envelope decision.
- **IMP-008 — backend-agnostic selection.** Nothing in the policy, the
  approvals store or selection knows how a form confines: a form is an
  absolute path to an executable (plus an extensions grant), identified by
  real path and digest. A Seatbelt or hand-written form is selected, approved
  and launched exactly as a Nix-built one.
- **IDE-005 — runs in flight.** There is no bound on the number of runs in
  flight; the policy bounds each run only. This is a stated non-guarantee. A
  future bound would be a new optional policy key. Under the contract's
  breaking-change rule an optional key that existing documents do not carry
  changes no existing grant, so it could ship within `quotient-policy/2`; an
  older server would refuse a policy that uses it (unknown field), which fails
  closed. Whether that is acceptable, or the key warrants `/3`, is a decision
  for the change that adds it.
- **IDE-001 — base policy.** An `extends` key would make the policy more than
  one file; every file it reaches would become a protected store and part of
  step 1. Not foreclosed.
- **IDE-002 — broader extension grants.** `extensions` admits only
  `builtin:mcp` today. Broadening keeps DEC-010's split: extensions are a
  machine-slot grant, never a project's.
- **RSK-001 — digest before approval.** Streaming or capping the digest of an
  unapproved link is open.

## Requirements

### FR-001 (REQ-025) — Admission runs in a fixed order and the first failure decides

admission-runs-in-a-fixed-order-and-the-first-failure-decides · functional · pending

Every call that would start a new run (pi_agent, or pi_agent_start without a held key) on a server whose start-up succeeded is checked request shape, then policy, switch, profile, root, form, ceilings and tools, session, child view, then that the attempts ledger is writable, in that order; the first failing check is the refusal, recorded in the attempts ledger as it is decided, and later checks do not run.

acceptance criteria:
  - A call failing two checks is refused with the earlier check's reason.
  - Each refusal decided by admission appears once in the attempts ledger when the ledger is writable; when it is not, the refusal is still answered and the failure is reported on stderr.
  - An unwritable attempts ledger refuses audit-unavailable after the child-view check, and nothing launches.
  - pi_agent_wait, pi_agent_ack and pi_agent_cancel are not admitted: they answer for runs on disk while the policy is disabled or unreadable.
  - The order of refusal reasons in the result contract's Refusals table matches the code's order.

### FR-002 (REQ-026) — The policy is read on every admitting call and nothing in it is defaulted or ignored

the-policy-is-read-on-every-call-and-nothing-in-it-is-defaulted-or-ignored · functional · pending

The policy is read and schema-validated on each call that admits a run; an unreadable file refuses policy-unavailable, a malformed one or any unknown field (top level, maxima, form objects) refuses policy-invalid, and only an unset QUOTIENT_* location falls through to its XDG default.

acceptance criteria:
  - An edit to the policy applies to the next call without a restart.
  - An unknown key at any level of the policy refuses policy-invalid.
  - A QUOTIENT_POLICY, QUOTIENT_RUN_DIR or QUOTIENT_SESSION_HOME that is set but empty or relative refuses policy-unavailable.

### FR-003 (REQ-027) — Only the per-call posture is served

only-the-per-call-posture-is-served · functional · pending

A policy whose mode is not per-call, or that carries a field belonging only to the static posture, refuses posture-unsupported for every call that would start a run; it is never read as the nearest posture served.

acceptance criteria:
  - mode "static" refuses posture-unsupported.
  - Any of agent, root, filesystem, session_home, run_dir, evidence_dir in the policy refuses posture-unsupported.

### FR-004 (REQ-028) — Roots are an allowlist compared by path component on canonical paths

roots-are-an-allowlist-compared-by-path-component-on-canonical-paths · functional · pending

A call's cwd is canonicalised (symlinks resolved) and must be an allowlisted root or inside one, compared by path component; the same canonicalisation and containment predicate decide the child-view check.

acceptance criteria:
  - Allowlisting /work/one admits /work/one/sub and refuses /work/oneevil with root-not-allowlisted.
  - A cwd reached through a symlink is judged at its real path.
  - Root containment and child-view containment share one implementation.

### FR-005 (REQ-029) — Caller ceilings above a maximum refuse; omitted ones inherit

caller-ceilings-above-a-maximum-refuse-omitted-ones-inherit · functional · pending

A call's ceilings object is closed; each supplied unit at or below its policy maximum is used, an omitted unit inherits the maximum, and a unit above the maximum refuses ceiling-above-maximum; a call's tools may only narrow the profile's.

acceptance criteria:
  - ceilings.cost_usd above maxima.cost_usd refuses ceiling-above-maximum, not clamped.
  - An unknown key in ceilings refuses request-invalid.
  - A tool not granted by the profile refuses tools-not-allowed.

### FR-006 (REQ-030) — A queued run is re-admitted at launch, narrowed never widened

a-queued-run-is-re-admitted-at-launch-narrowed-never-widened · functional · pending

When a queued run reaches launch it passes the policy, profile, root, form, ceilings and child-view checks again against the policy and approvals current then; its ceilings and transcript budget narrow to current maxima rather than refusing; its root, session, capability and tools are kept; any failure settles it as that refusal without launching.

acceptance criteria:
  - Lowering a maximum while a run is queued launches it with the lower ceiling.
  - Disabling the policy while a run is queued settles it refused disabled without launching.
  - Re-admission never changes the run's root, session, capability or tools.

### FR-007 (REQ-031) — The child's view never reaches a protected store further than it allows

the-childs-view-never-reaches-a-protected-store-further-than-it-allows · functional · pending

Before launch, the union of root, session directory and exposure paths is checked against the protected stores: the evidence directory, attempts ledger and other sessions may be neither read nor written; the policy file, approvals store, profile and help directories may be read but never written; a store is protected whether or not it exists.

acceptance criteria:
  - A write profile whose root contains the profile directory refuses view-overlaps-protected.
  - A read profile whose root contains the run directory refuses view-overlaps-protected.
  - An exposure path inside the not-yet-created approvals store location refuses view-overlaps-protected.

### FR-008 (REQ-032) — Form selection follows the governing approval with no fallback

form-selection-follows-the-governing-approval-with-no-fallback · functional · pending

For a call's capability, the deepest approval whose root contains the call's canonical root governs; a governed call runs exactly the recorded real path and digest or refuses (form-unapproved on mismatch, form-invalid when the link is gone); an ungoverned call runs the machine form only when no project link exists.

acceptance criteria:
  - Each row of the policy contract's project-forms selection table holds as a unit test of selection.
  - Deleting a governed root's link refuses form-invalid and never runs the machine form.
  - An approval keeps governing after its root is removed from roots.

### FR-009 (REQ-033) — A project form replaces only the executable of a confined machine slot

a-project-form-replaces-only-the-executable-of-a-confined-machine-slot · functional · pending

A usable project form must resolve to an executable regular file outside every roots entry, exposure path and the session home; it inherits the machine slot's extensions, cannot add any, and cannot substitute an unconfined slot.

acceptance criteria:
  - A project link resolving inside a roots entry refuses form-invalid.
  - A project link where the machine slot is unconfined refuses form-invalid.
  - A project form for a profile naming an mcp__* tool launches with the machine slot's builtin:mcp extension.

### FR-010 (REQ-034) — The approvals store is closed-world and a malformed store refuses

the-approvals-store-is-closed-world-and-a-malformed-store-refuses · functional · pending

The approvals store admits exactly its schema's keys, one entry per root and capability, canonical paths and lowercase sha256 digests; a malformed or unreadable store refuses every call that reaches form selection with form-unapproved naming the store and the fault, and is never overwritten by the verbs.

acceptance criteria:
  - A duplicate (root, capability) pair makes every form-selecting call refuse form-unapproved.
  - A non-canonical root (trailing separator) is malformed, not normalised.
  - allow and revoke exit non-zero on a malformed store and leave it byte-identical.

### FR-011 (REQ-035) — allow records only the identity that was reviewed

allow-records-only-the-identity-that-was-reviewed · functional · pending

quotient allow without identities reports each capability's link, real path, digest, governing approval, machine slot and the exact record command, and never writes; with identities it records them only if, under the store lock, each link still resolves to the given real path with the given digest, the slot is confined, and no deeper approval governs — all or nothing.

acceptance criteria:
  - A report run leaves the store unchanged.
  - A record whose digest differs from the link's current target writes nothing and names both identities.
  - A record at a roots entry beneath which a deeper approval governs is refused with the revoke it needs.

### FR-012 (REQ-059) — revoke addresses a stored root and nothing else

revoke-addresses-a-stored-root-and-nothing-else · functional · pending

quotient revoke removes the named capabilities (or all) for a root equal to a stored root after lexical normalisation, reading neither the policy nor the filesystem; an unknown root or capability exits non-zero listing the stored roots.

acceptance criteria:
  - revoke of a root whose directory no longer exists succeeds when an entry is stored for it.
  - revoke of a child root leaves a parent's approval untouched.
  - revoke of an unknown root exits 1 listing stored roots and creates no store.

### NF-001 (REQ-060) — The approvals store has one serialised writer and atomic publication

the-approvals-store-has-one-serialised-writer-and-atomic-publication · quality · pending

allow and revoke write under an exclusive pid lock, validate the new list through the store reader, publish by rename of an exclusively created temp file, and remove the temp file and their own lock on every path; a held lock fails the command and is never reclaimed automatically.

acceptance criteria:
  - A reader concurrent with a write sees the old store or the new one, never a partial file.
  - A second writer while the lock is held exits non-zero naming the holder's pid.
  - No temp file or own lock remains after a failed write.

## Interactions

- SPEC-005 — uses: admission reads the profile snapshot and config locations
- SPEC-004 — uses: selects a form per capability and checks the child view against form-1's promise
