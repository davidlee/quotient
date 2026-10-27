```text
`SPEC-004` — Forms contract
forms-contract · active · tech
tags: forms, confinement
category: confinement
c4 level: component
descends from: PRD-001
parent: SPEC-002
responsibilities:
  - Define the form invocation: argv, working directory, environment, standard streams, exit status and process-group ownership.
  - Define the guarantees a form must hold as properties of the child's view and lifetime, independent of mechanism.
  - State what a form does not promise, and what quotient verifies, samples, or leaves to the form implementer.
  - Mark the unconfined form as a named non-form under which no guarantee holds.
  - Version the interface so a breaking change mints a new contract alongside the old.
sources:
  - markdown docs/contract/form-1.md
  - markdown docs/nix-forms.md
  - nix nix/form-family.nix
  - nix nix/check-family.nix
  - shell scripts/form-probe
  - shell scripts/hostile-audit

```

# SPEC-004: Forms contract

<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

A **form** is an executable, outside quotient, that confines one pi run. The
server (SPEC-002) launches every confined run through a form; the confinement
policy (SPEC-003) decides which form a run gets — the machine form the policy
names per capability, or a project form the operator approved. This spec owns
the interface between the two sides: what quotient hands a form, what a form
must guarantee in return, how much of that quotient can check, and where the
contract stops.

```
 SPEC-003 selects ──► form path ──► SPEC-002 spawns:  <form> <session-dir> <pi argv…>
                                                       cwd = root, own process group
                                          │
                                          ▼
                               form establishes confinement (G1–G10)
                                          │  or exits non-zero (G9) / 64 (G8)
                                          ▼
                                     execs pi
```

The normative text is `docs/contract/form-1.md` (`form-1`). This spec does not
restate its tables; it records the contract's durable shape, the properties
quotient relies on, and how conformance is evidenced. It realises PRD-001's
REQ-005 (every run is confined by an operator-chosen form) and bounds what
PRD-001's §6 non-guarantee "the form does the confining" means.

The contract is **backend-agnostic**. Guarantees are properties of the child's
view and lifetime, never mechanisms. Bubblewrap, a macOS Seatbelt profile,
Landlock or a hand-written launcher are all candidate backends; each conforms
by meeting `form-1`, not by resembling another. The Nix family builder
(§Backends) is the one backend quotient ships guidance and checks for. It has
no special standing in the contract, and a family it builds conforms only as
far as the operator's own additions to it keep the builder's safeguards
intact.

## Responsibilities

- Define the form invocation: argv shape, working directory, environment,
  standard streams, exit status, process-group ownership.
- Define the guarantees a form must hold (G1–G10) as properties of the
  child's view and lifetime, independent of mechanism.
- State what a form does not promise (reads beyond the protected stores), so
  operators who need more choose a form that documents it.
- State what quotient verifies, what it samples, and what remains the form
  implementer's to show.
- Mark the unconfined form as not a form: a separately named operator choice
  under which no guarantee holds.
- Version the interface: a breaking change mints a new contract version that
  stands alongside the old.

## Contracts

**Invocation (`form-1`, Invocation).** `<form> <session-dir> <pi argv…>`. The
root is conveyed by the working directory, not an argument, so later versions
can add arguments without disturbing existing ones. `<pi argv…>` is verbatim,
with no executable word and no `--`; it already names `--session-dir`. The
environment is the server's minus every `QUOTIENT_*` variable and minus any
value naming the run's evidence (SPEC-002's spawn strips it before launch). The
prompt arrives on stdin, closed after writing; stdout is pi's JSON event
stream; stderr is diagnostics; the form passes all three through, execs pi,
and exits with pi's status.

**Lifetime.** The server runs the form as leader of its own process group and
stops it through SPEC-002's one termination ladder by signalling that group
(SIGTERM, 2 s grace, SIGKILL). quotient therefore relies on the form and
everything it starts staying in that group; a process that leaves it is not
stopped by cancellation or shutdown. `form-1` states the group
ownership as the server's behaviour; it does not yet state, as a guarantee,
that a form must not move the delegate out of the group (see Open items).

**Guarantees (`form-1`, Guarantees).** Grouped by what they protect:

| concern | guarantees | property |
|---|---|---|
| the delegate can do its job | G1, G3, G4 | root readable at its path; session dir writable at its path; a private writable temp |
| capability is honoured | G2 | root writable only under `write` |
| nothing else is writable | G5 | writes limited to root (`write`), session dir, private temp, `exposure` |
| protected stores | G6 | evidence and other sessions unreachable; policy, profile and help directories and approvals store not writable |
| no orphan delegate | G7 | confined process dies with its parent |
| fail closed before pi | G8, G9 | bad session dir exits 64; unestablished confinement exits non-zero; nothing runs unconfined |
| confinement inputs are not delegate-writable | G10 | everything confinement depends on is in the form's bytes or an undelegated path |

G5 and G6 are what make SPEC-003's child-view disjointness check meaningful:
that check reasons over the root, session directory and `exposure`, and is
sound only if the form adds nothing writable and hides what must stay
unreachable.

**Not promised.** Reads beyond G6 are the form's choice. A form may show a
narrow view or allow wide reads; `form-1` does not promise that other host
secrets are unreadable.

**The unconfined form.** A policy may name pi itself as an unconfined write
form. quotient then runs `<pi> <pi argv…>` (no session positional) and none of
G1–G8 hold. It is never selected implicitly and never a fallback; SPEC-003 owns
when the policy admits it.

**Versioning.** `form-1` is normative. A change that would break a conformant
form or the server's reliance on one mints `form-2`, and `form-1` stays
published alongside.

## Concerns

- **Trust boundary.** The form is the only thing between an untrusted delegate
  and the host. quotient's own checks (SPEC-003) are preconditions that assume
  the form's promise; they cannot substitute for it.
- **Verification gap.** Most guarantees cannot be verified by quotient for an
  arbitrary form. The evidence split is part of the contract, not a defect to
  hide (see Decisions).
- **Approval covers bytes only.** A project form is pinned by real path and
  sha256 of its bytes (SPEC-003). G10 is what makes that pin meaningful: a form
  whose confinement reads a delegate-writable file would be confined at the
  delegate's leave whatever its digest.
- **Lifetime across platforms.** Process-group signalling is POSIX, but
  "dies with its parent" (G7) has no single portable mechanism, and some
  sandbox launchers detach into a new session. A backend that leaves the
  server's group escapes the termination ladder.
- **Path aliasing.** Protected stores are named by path; platform aliases
  (symlinks, `/private/var` vs `/var`, case-insensitive filesystems) are a
  backend's problem to close and a probe's to exercise.

## Hypotheses

- H1 — The guarantee set G1–G10, stated as properties, is implementable on
  macOS with Seatbelt plus a supervisor for G7, without changing `form-1`'s
  invocation or guarantees. Unverified; IMP-008 is where it is tested, and
  its open gates are listed under Open items: G4's meaning, process-group
  retention, G7 supervision, and the server's own procfs dependency.
- H2 — A single write-denial sample (G6 on the run's own `audit.jsonl`) is a
  useful smoke test for any backend, because a backend that fails it fails the
  property quotient most depends on. It is not taken as conformance.
- H3 — Operators who need read confidentiality beyond G6 will choose a form
  that documents it rather than needing quotient to promise it.

## Decisions

- **Properties, not mechanisms.** The contract names what the child can and
  cannot do, never how. Rationale: confinement technology differs per
  platform and changes faster than the server; tying the contract to one
  mechanism would make every other backend a contract change.
- **The root travels as the working directory.** Keeps the positional
  argument list minimal and extensible.
- **quotient ships no forms.** A form is the operator's choice; quotient ships
  the contract, a builder for one backend, and checks. Rationale: the
  operator owns the host's trust decisions.
- **Evidence is stated per guarantee.** `form-1`'s Evidence table records,
  for each guarantee, whether quotient verifies it. For an arbitrary form the
  answer is "no" except one sampled G6 case; claims about conformance must
  not exceed that table.
- **Unconfined is named, not defaulted.** Running pi without a form needs its
  own policy spelling and gives up every guarantee explicitly.

## Backends

A backend is conformant when it meets `form-1`. None is privileged.

**Nix family builder (Linux, today).** `lib.mkFormFamily` in the quotient
flake (`nix/form-family.nix`, manual `docs/nix-forms.md`) builds a `read` and a
`write` form plus a comparison `baseline` over bubblewrap via jail.nix, from
the operator's own nixpkgs, jail.nix and pi. It adds safeguards beyond
`form-1`: a cleared environment, its own namespaces, a mask over the quotient
state directory and `protect` paths, and ordering so that no option the
builder checks covers the root or session bind.

Those safeguards hold for what the builder can see. Options the operator adds
at runtime (binds delivered from a file descriptor or appended by
`add-runtime` code) are expanded after the root and session binds, can cover
them, and are not checked (`docs/nix-forms.md` §6). A built family therefore
meets `form-1` on the builder's side; the operator's runtime additions are
theirs to keep within it. The evidence:

| check | what it shows | limit |
|---|---|---|
| `lib.checkFormFamily` (`nix/check-family.nix`, `nix/check.sh`) | the launchers' bwrap text meets the contract: no undeclared read-write bind, protected state not rebound, the root and session binds last | text only; runtime binds and variable expansions are residues, not checked |
| `scripts/form-probe` | G1–G9 behaviourally, over a probe family whose pi is a probe script | the probe family, on the host that runs it. Not G10: the launcher's own bytes are immutable in the Nix store, but G10 also covers runtime inputs the operator adds, which nothing checks |
| `scripts/hostile-audit` | one G6 case with the real server, form and model | one store, one model, once |

The builder is Linux-only (bubblewrap); it fails at evaluation elsewhere.

**Other backends (not shipped).** A macOS Seatbelt backend and a documented
hand-written ("manual") form are open work (IMP-008). Each must meet `form-1`
unchanged; backend-specific builders and checks may differ (a Seatbelt check
cannot read bwrap text), and the write-denial probe applies to any backend.

## Open items

- **Process-group retention is not a stated guarantee.** The server's ladder
  signals the form's process group, but `form-1` lists no guarantee that the
  form and pi stay in it. A backend that calls `setsid()` (IMP-008 notes one
  macOS launcher does) would escape cancellation and shutdown while still
  meeting G1–G10 as written. Candidate: an additive guarantee ("the form and
  everything it starts remain in the process group it was started in"), which
  may need `form-2` if existing forms could violate it. Blocks IMP-008;
  tracked as ISS-004.
- **G4 wording for non-namespacing backends.** "A private, writable temp, not
  shared with the host" reads naturally as a private mount. A Seatbelt form
  would more likely grant a per-run directory on the host's filesystem. The
  contract should say whether "not shared" means unreachable by other runs
  and processes, or not present on the host at all.
- **G7 on macOS.** No `--die-with-parent` equivalent; needs a supervisor that
  itself stays in the group. Engineering, not a contract change (IMP-008).
- **Checks per backend.** `checkFormFamily` is bwrap-specific. A Seatbelt
  backend needs its own static check, or the contract's evidence story
  relies on probes alone for it.
- **Server portability.** Not a form question, but it gates IMP-008: session
  ownership reads the server's own start time from `/proc/<pid>/stat`, and
  refuses to start a run when it cannot. A host without Linux procfs (macOS)
  refuses every new run whatever form it has.
- **"Layers" in `form-1`'s summary diagram.** The diagram under Guarantees
  says "policy, profile and help layers"; "layers" predates the removal of
  the project layer, and the G6 row already says "directory". Editorial.

## Requirements

### FR-001 (REQ-036) — Form invocation is fixed by the contract

form-invocation-is-fixed-by-the-contract · functional · pending

The server launches a confined run as `<form> <session-dir> <pi argv…>` with the canonical root as working directory, pi's argv verbatim (no executable word, no `--`), the prompt on stdin closed after writing, and pi's event stream on stdout.

acceptance criteria:
  - A confined launch passes exactly the session directory followed by pi's argv to the form.
  - The form's working directory is the run's canonical root.
  - stdout and stderr are captured separately and never merged.

### FR-002 (REQ-061) — The child environment carries no server configuration or evidence path

the-child-environment-carries-no-server-configuration-or-evidence-path · functional · pending

The environment handed to a form is the server's minus every `QUOTIENT_*` variable and minus any variable whose value names the run directory or one of the run's evidence files.

acceptance criteria:
  - No `QUOTIENT_*` variable reaches a launched form.
  - A variable whose value names the run directory or an evidence file of the run is removed before launch.

### FR-003 (REQ-062) — A form runs in its own process group under the server's ladder

a-form-runs-in-its-own-process-group-under-the-servers-ladder · functional · pending

The server starts each form as the leader of a new process group and stops it only by signalling that group through the one termination ladder, so signals reach every process that stays in the group and nothing outside it. form-1 does not yet require a form to keep its processes in the group (ISS-004).

acceptance criteria:
  - A launched form is a process-group leader distinct from the server's group.
  - Cancellation, shutdown and limit breaches signal the form's group, never the server's.

### FR-004 (REQ-063) — The unconfined form is explicit and holds no guarantee

the-unconfined-form-is-explicit-and-holds-no-guarantee · functional · pending

When the policy names pi itself as an unconfined write form, the server runs `<pi> <pi argv…>` with no session positional, and the shipped contract states that none of the form guarantees hold.

acceptance criteria:
  - An unconfined launch passes pi's argv alone.
  - The form contract states that G1–G8 do not hold for the unconfined form.
  - No run is launched unconfined unless the policy names an unconfined form for its capability.

### FR-005 (REQ-064) — The contract states its evidence per guarantee

the-contract-states-its-evidence-per-guarantee · functional · pending

The shipped form contract records, for every guarantee, whether quotient verifies it, and claims no conformance beyond that record.

acceptance criteria:
  - Every guarantee in the form contract has a row in its Evidence table.
  - The write-denial probe is documented as sampling one protected-store case and as not establishing conformance.

### FR-006 (REQ-065) — Write-denial probe for any form

write-denial-probe-for-any-form · functional · pending

An operator can run a write-denial probe that drives the real server over a real form and model, asks the delegate to write to its own run's audit ledger, and passes only if the write did not land or the call failed closed.

acceptance criteria:
  - The probe exits 0 when the audit ledger and evidence are intact and the delegate attempted the write or the call failed closed.
  - The probe exits 1 when evidence is damaged or the run succeeded with no attempt in its stream.
  - The probe exits 77, without running, when a prerequisite is missing or ambient `QUOTIENT_*` variables are set.

### FR-007 (REQ-066) — Nix family builder produces a read and a write form

nix-family-builder-produces-a-read-and-a-write-form · functional · pending

The flake's `lib.mkFormFamily` builds, from the operator's nixpkgs, jail.nix and pi, a read form and a write form on Linux whose builder-side launchers meet the form contract, plus a comparison baseline, and reports the `exposure` list the policy must carry. Runtime options the operator adds are not checked and are the operator's to keep within the contract.

acceptance criteria:
  - A family built from the documented minimal consumer yields `read`, `write` and `baseline` executables.
  - The family exposes the read-write paths it binds as `exposure`.
  - The builder fails at evaluation on a platform without bubblewrap.

### FR-008 (REQ-067) — Static check of a Nix form family

static-check-of-a-nix-form-family · functional · pending

`lib.checkFormFamily` reads a family's launcher text and refuses a family whose read-write binds are undeclared, which rebinds protected state elsewhere, whose masks disagree with the policy's `protect`, or whose bwrap line is not plain words; it reports what it could not see as residues.

acceptance criteria:
  - A family that adds an undeclared read-write bind fails the check.
  - A family that binds protected state at another path fails the check.
  - Runtime-delivered binds are printed as residues, not passed silently.

### NF-001 (REQ-068) — The form contract is backend-agnostic

the-form-contract-is-backend-agnostic · quality · pending

Every guarantee in the form contract is stated as a property of the child's view or lifetime, never as a mechanism, so a non-Linux backend (for example a macOS sandbox profile or a hand-written launcher) is assessed against the properties alone; mechanism-specific detail lives only in a backend's own documentation. Whether a given backend can meet them is assessed per backend, not assumed.

acceptance criteria:
  - The form contract names no Linux-only mechanism as a requirement.
  - A proposed backend is assessed against the contract's guarantees, not against the Nix builder's mechanism.

### NF-002 (REQ-069) — The shipped builder's guarantees are probed behaviourally on every release

the-shipped-builders-guarantees-are-probed-behaviourally-on-every-release · quality · pending

The release gate exercises the Nix builder's forms on a real host for G1–G9 and runs the static family check, so the shipped builder's conformance is evidenced, not asserted.

acceptance criteria:
  - The release gate runs the form probe over a probe family and fails on any failed or unreported row.
  - The release gate runs the static family check, including its negative controls.
