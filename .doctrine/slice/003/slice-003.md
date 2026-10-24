# Optional jail.nix form builder

## Context

From IMP-003. quotient ships the form contract (`docs/contract/form-1.md`) and
no forms: a form is the executable the operator names in the policy, and
quotient never builds one. Today an operator on Linux has to write their own
bwrap wrapper, or fall back to the unconfined write form.

That was a deliberate v1 choice. satan's DEC-116 (operator, 2026-10-22; lives
in `~/dev/satan`, not this repo) rejected "generic bwrap forms + lib.mkForms in
quotient" because the only forms that existed were built on the operator's
private agents flake, and named generic forms as a follow-up that implements
form-1 without changing the contract. `flake.nix` carries the trace:
"quotient exports no forms (DEC-116)".

Prior art to lift, not re-derive: satan's `quotientFormFamily`
(`~/dev/satan/flake.nix:325`), its `formProbes` (`:486`) and the
`quotient-forms` flake check (`:691`). They build on `jailed-agents.nix`'s
`makeJailedPi` (private). Underneath it is `jail.nix`
(`sourcehut:~alexdavid/jail.nix`, public), whose combinators this slice uses
directly.

```
satan today                            this slice
───────────                            ──────────
nix-config/agents (private)            jail.nix (public)
  makeJailedPi + gateway + toolchain     combinators
        │                                    │
quotientFormFamily  ──── lift ────▶   quotient flake: optional form-family builder
  forms.quotient-{read,write}            forms.<prefix>-{read,write}, baseline
  quotient-forms check                   form check shipped with the builder
```

## Scope & Objectives

1. **An optional form-family builder** in this repo's flake, over `jail.nix`
   combinators: given a family name and the caller's runtime packages, it
   builds a `read` and a `write` form meeting form-1's invocation and G1–G10
   (one session-directory positional, then pi's argv; root at its own absolute
   path, `ro` for read and `rw` for write; session directory `rw`; private
   `/tmp`; `--die-with-parent`; the three exit-64 guards; nothing that reaches
   the run directory, session home or policy).
2. **Caller composition.** The caller supplies the toolchain (the per-consumer
   axis: satan needs node/just/emacs, a doctrine delegate needs cargo/rustc)
   and may add jail options (mounts, network, environment). The builder fixes
   only what form-1 requires, and the caller cannot remove those settings.
3. **A family baseline and a shipped check.** The same jail with no form
   options, and a text-only check that each form's binds are the baseline plus
   the root and the session directory. Every consumer gets the check, not just
   this repo.
4. **Docs.** README and `quotient help` say the builder exists and how to point
   a policy, or a project form, at its outputs. form-1 is unchanged.
5. **The selection gap, re-assessed.** IMP-003's note says a second toolchain
   needs a second policy and server, because `forms` is keyed by capability
   alone. SL-002's project forms may already answer it: a root whose
   `.quotient/forms/write` links an approved store path gets its own toolchain
   under one policy. Confirm or refute that in design, and record the outcome.

The server stays independent of Nix: the npm package, `src/` and the policy
schema do not change, and a policy still names the forms' executable paths.

## Non-Goals

- Non-bwrap mechanisms (macOS seatbelt, Landlock). Linux only.
- Owning provider credentials or a gateway. The builder gives the caller a way
  to pass them through; it does not choose one.
- Migrating satan's family onto the builder, or wiring doctrine as a consumer.
  Those changes belong to other repos (Follow-Ups).
- Changing form-1, the policy schema, or keying `forms` by root.
- Behavioural conformance in `nix flake check` if bwrap cannot run in the build
  sandbox. `scripts/hostile-audit` stays the behavioural probe.

## Affected surface

Revised by design (DEC-014–DEC-022):

- `flake.nix`: `lib.mkFormFamily` / `lib.checkFormFamily` and the reworded
  comment. No new input (DEC-016), so `flake.lock` is unchanged.
- `nix/**` (new): the builder, `nix/check.sh`, and the test flake
  `nix/checks/flake.nix` with its own lock (DEC-022).
- `scripts/form-probe` (new): the behavioural probe (DEC-022).
- `justfile`: `forms-check`, `forms-probe` and `nix-build` (the server
  package, IMP-007) in `gate`; shellcheck covers the new scripts.
- `docs/nix-forms.md` (new), `README.md`, `help/setup.md` step 3,
  `docs/contract/quotient-policy-2.md` (worktree wording of the lookup base,
  meaning unchanged).
- Possibly `src/drift.test.ts` / `src/help/help.test.ts` if shipped text pins
  change.

## Risks & assumptions

- **A1:** `jail.nix` alone has what `makeJailedPi` contributes that form-1
  needs: bwrap launcher, `--die-with-parent`, raw args, a persisted pi home.
  To verify in research.
- **R1:** adding a flake input changes the lock for every flake consumer of
  quotient, including those who only want the server. The input may need to
  be lazy or caller-supplied (see OQ-1).
- **R2:** a text-only check proves the launcher's arguments, not the jail's
  behaviour. A form built by the builder is form-1 conformant only by
  inspection plus the hostile-audit G6 sample, as form-1 already says.
- **R3:** `jail.nix` API drift. Pinned by the lock, and caught by the check.

## Open questions

- **OQ-1:** how `jail.nix` and pi reach the builder: a quotient flake input,
  or arguments the caller passes (their own `jail.nix`, their own pi).
- **OQ-2:** how a provider key reaches pi without the builder owning it (an
  inherited FD, an env file, caller-supplied options).
- **OQ-3:** output shape: a `lib` function, an overlay, or both; and its name.
- **OQ-4:** DEC-116's standing here. It was decided in satan, for satan's
  SL-031. Record a quotient decision that an optional builder in the flake is
  the follow-up DEC-116 named, not a reversal, and update the `flake.nix`
  comment.
- **OQ-5:** does SL-002's project-forms mechanism close the selection gap
  (Scope 5)?

## Verification / closure intent

- `nix flake check` passes, including the shipped form check over a sample
  family, and fails on a doctored form (negative control).
- Forms built on this host pass `scripts/hostile-audit` for both capabilities
  (VH, since the probe needs a reachable model).
- A sample family with a non-default toolchain builds, and the check still
  passes.
- `npm test` and `just gate` stay green; the npm package's contents are
  unchanged apart from docs.

## Summary

An optional Nix helper that builds form-1 read/write forms from `jail.nix`,
lifted from satan's family, with its conformance check shipped alongside. The
server is unchanged.

## Follow-Ups

- satan's `quotientFormFamily` consumes the builder (satan repo).
- doctrine becomes the second consumer with a cargo/rustc toolchain.
- Native forms for macOS (seatbelt).
