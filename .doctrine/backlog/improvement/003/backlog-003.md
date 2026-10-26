# IMP-003: Optional jail.nix form builder

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Quotient accepts operator-supplied form executables and deliberately does not
own a jail implementation. Add an optional Nix helper in this repository that
uses `jail.nix` combinators to build Quotient-compatible pi forms, so Nix users
can reuse the jail syntax without depending on a consumer-specific layer such
as `jailed-agents.nix`.

The generated read and write forms must implement Quotient's existing
`form-1` invocation and guarantees. Keep the helper optional and the Quotient
server independent of Nix; its policy should continue to name the resulting
form executable paths. Leave room for callers to compose their own jail options
(for example mounts, networking, environment, and runtime packages).

Design should settle how `jail.nix` and pi are supplied to the helper, which
per-call settings the helper standardizes, and how caller options compose with
those settings. Use Quotient's form contract as the acceptance boundary,
including root capability, writable session state, private temp, evidence
isolation, and child lifetime.

## Notes (2026-10-24, from wiring doctrine)

- **Prior art to lift, not re-derive.** SATAN's `quotientFormFamily`
  (`~/dev/satan/flake.nix:325`) already does this over `jailed-agents.nix`'s
  `makeJailedPi`: per-capability root bind at `$PWD`, the session directory
  via `$1` → `QUOTIENT_ACTIVE_SESSION_DIR`, `--tmpfs /tmp`, `--chdir "$PWD"`,
  `--die-with-parent`, and the G8 exit-64 checks in the wrapper. Its
  `baseline` (the same jail with no form options) and `formProbes` let a flake
  check assert the forms add only root + session beyond the generator's binds.
  Ship the probes with the helper so every consumer gets the check.
- **The toolchain is the per-consumer axis.** A form is root-agnostic (it binds
  whatever `$PWD` the server gives it), but its packages are fixed at build
  time. Satan's forms carry node/just/emacs; a doctrine delegate needs cargo
  and rustc and has neither. So the helper's main parameters are the family
  `prefix` and the runtime packages; one family per policy.
- **Gateway / provider credentials** are the part tied to the consumer layer
  (satan passes `gateway = piGateway`). Design must say how the key reaches pi
  (an FD, an env file, caller-supplied options) without the helper owning it.
- **Migration.** Once it lands, satan's family should consume the helper
  rather than keep a parallel copy; doctrine becomes the second consumer.
- **Selection gap.** Because `forms` is keyed by capability only, a second
  toolchain means a second policy and server (`QUOTIENT_POLICY` per client
  config). Worth deciding whether that is the intended model or whether the
  policy should key forms by root. See ISS-001 for the related launch-dir
  constraint.

## Selection gap — answer (SL-003 close, 2026-10-26)

A second toolchain does not need a second policy and server. Project forms
already key forms by root under one policy: link `<root>/.quotient/forms/<cap>`
to a family's form and approve it with `quotient allow`; a root without
one inherits the policy's form (SL-003 slice OQ-5, design inquiry; lookup base
in `src/server/approvals.ts`). SL-003 documented this in `docs/nix-forms.md`
and clarified the nested-root/worktree wording in the policy contract. No
change to the policy's `forms` keying is needed.
