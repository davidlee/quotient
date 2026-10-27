# SPEC-003: Confinement policy

<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

The operator's authority over runs, as the server applies it: the policy
document, the fixed admission sequence that judges every call against it, the
child-view check, project-form selection and the approvals store that records
which project form may run.

A component of the MCP server container (SPEC-002), realising PRD-001's
operator-authority, confinement-selection, per-run-limit and fail-closed
requirements. The registry, lanes, termination ladder, gate ticks and evidence
writing are SPEC-002's; this spec states only what they consult here and what
this component promises them. Where a form comes from and what it must
guarantee is SPEC-004's; profiles and their snapshot are SPEC-005's; the
command-line shape of `allow` and `revoke` is SPEC-006's.

```
call ──► request shape ──► 1 policy ─ 2 switch ─ 3 profile ─ 4 root ─ 5 form
                                                                       │
     refusal (first failure) ◄─── 8 child view ─ 7 session ─ 6 ceilings/tools
                                        │
                                        ▼
                         admitted: root, capability, form identity,
                         clamped ceilings, tools, session  ──► SPEC-002 registry

queued run at launch ──► steps 1-6 and 8 again (session kept,
                         ceilings narrowed, form re-selected) ──► launch or refuse
```

## Responsibilities

- Read, validate and apply the operator policy on every call, with no default
  for anything absent and no tolerance for anything unknown.
- Judge each call through one fixed admission order, first failure wins, and
  hand an admitted call's decided grant to SPEC-002.
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
- **Every refusal is recorded once**, in the attempts ledger, as it is decided.

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
