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
