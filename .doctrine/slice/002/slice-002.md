# Project forms by root, operator-approved

## Context

ISS-001: a `write` call rooted at a repository root is refused
`view-overlaps-protected` whenever the server was launched from that root —
the default for an MCP client started in a project.

```
resolveLocations (src/config.ts)   profileLayers = [<launch>/.quotient/profiles, <xdg>/quotient/profiles]
                                   helpLayers    = [<launch>/.quotient/help,     <xdg>/quotient/help]
protectedStores (childview.ts)     every layer, existing or not, never-writable
step 8                             write root <launch> contains <launch>/.quotient/* → refused
```

Triage first chose one policy per project via `QUOTIENT_POLICY`. Research
(`research/research.md` X1–X3) and discussion on 2026-10-24 replaced that with
two accepted decisions:

- **DEC-007** — the policy splits by job. The machine policy
  (`~/.config/quotient`) holds the grant (`roots`, profile capability pins,
  `exposure`, `enabled`/`mode`), the limits (`maxima`,
  `transcript_budget_bytes`) and default forms. Profiles and help are
  machine-only. A project supplies only forms, in `<root>/.quotient/`, where
  `<root>` is the `roots` entry containing the call's `cwd` (longest match).
- **DEC-008** — project forms run only when the operator has approved them by
  identity (resolved real path + sha256). Admission resolves the form once and
  the call runs that exact executable; a changed or unapproved form refuses
  the next call `form-unapproved`. Calls in flight are unaffected.
  `.quotient/` is not a protected store.

```
call(cwd) ─▶ machine policy: grant + limits     (~/.config/quotient/policy.json)
          ─▶ root = longest roots entry ⊇ cwd
          ─▶ <root>/.quotient/ forms?  ── no ──▶ machine default forms
                     │ yes
                     ▼
             resolve realpath + sha256 ─▶ approved? ── no ──▶ refuse form-unapproved
                     │ yes
                     ▼
             run that executable
```

## Scope & Objectives

- Remove the launch-dir `.quotient/{profiles,help}` layers: profiles and help
  come from the XDG layer only. Fail start-up, with migration guidance, when a
  launch-dir `.quotient/profiles` or `.quotient/help` exists (research X3).
- Drop the profile/help-layer entries for the launch dir from the protected
  stores; `<root>/.quotient/` is not protected. ISS-001's refusal disappears.
- Resolve per-call forms: the matched root's `.quotient/` forms, else the
  machine default forms. A project may not name the unconfined form.
- Approval: a machine-side approval record; admission checks the resolved
  form identity against it; refusal `form-unapproved` names old and new
  identity, a review hint and the approve command.
- An operator verb to approve a root's forms (e.g. `quotient allow <root>`).
- Contracts: a new policy schema version if the document shape or semantics
  break (design decides; DEC-004 pattern); a `.quotient/` format contract;
  result/refusal additions. Help, README, examples, client snippet.
- Version bump; migration note for satan (move `.quotient/profiles` to XDG).

Expected surface: `src/config.ts`, `src/server/{policy,childview,profiles,server}.ts`,
new form-resolution/approval module(s) under `src/server/`, `src/cli.ts`,
`src/help/help.ts`, tests and `src/server/test-rig.ts`, `src/drift.test.ts`,
`docs/contract/`, `docs/design.md`, `help/`, `examples/`, `README.md`,
`package.json`, `package-lock.json`.

## Non-Goals

- Policy inheritance / `extends` (IDE-001). Per-project policy files are no
  longer the model.
- Building forms. Quotient stays independent of Nix; the Nix form helper is
  IMP-003.
- Form-side masking of `.quotient/` inside writable roots (ISS-001 option 2).
- Project-supplied profiles, help, roots or limits.
- Protecting `flake.nix`, `flake.lock` or other build inputs (DEC-008).

## Risks, assumptions, open questions

- **Breaking:** launch-dir profiles stop being read; mitigated by the start-up
  failure. Only satan known affected (checked `~/dev/*/.quotient`, 2026-10-24).
- **Re-approval friction:** every form identity change stops calls until
  approved. Mitigation is operational (narrow, stable form toolchains).
- **Approval store:** location, format, and whether it is a protected store
  (it must be: a delegate must not approve its own form). Design decides.
- **`.quotient/` format:** how a project names its forms (relative symlinks to
  a build output, a small JSON naming paths, …). Design decides.
- **Hash scope:** for non-store paths the sha256 pins only the executable;
  anything it calls is the operator's responsibility (DEC-008).
- **Nested roots:** longest-match rule; design confirms behaviour when a call's
  `cwd` is inside a nested repo without its own `roots` entry.
- **Agent approval:** the unconfined orchestrator can run the approve verb;
  quotient cannot prevent it. Document that approving is the operator's act.

## Verification / closure intent

- The ISS-001 scenario: a write call rooted at the launch directory is
  admitted (red first).
- Absent `.quotient/` → machine default forms; behaviour of a default install
  unchanged apart from removed launch-dir layers.
- Approved project form runs; a changed form refuses `form-unapproved` with
  identities; a call in flight is not affected by a later change.
- A project naming the unconfined form is refused.
- Launch-dir `.quotient/profiles` present → start-up failure with guidance.
- Contracts, help and snippets no longer describe a launch-dir layer.
- `just gate` green; lint zero warnings.

## Summary

Keep grant and limits on the machine; let each project supply its own
confinement in `<root>/.quotient/`, trusted only once the operator approves
the exact built forms.

## Follow-Ups

- IMP-003 — Nix form helper: the customary way a flake produces
  `.quotient/` forms.
- satan: move `.quotient/profiles` to the XDG layer.
- IDE-001 — likely obsolete under DEC-007; re-triage.
