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
  machine-only. A project supplies only forms, in `<base>/.quotient/forms/`.
  The base is the root of the deepest approval containing the call's
  canonical root, else the longest `roots` entry containing it.
- **DEC-008** — the operator's approval is the selection. A governed call runs
  exactly the approved identity (resolved real path + sha256) or refuses —
  never the machine default; an ungoverned call with a project link refuses
  `form-unapproved`. Admission resolves the form once and the call execs that
  path, so a later change never alters a call in flight. `.quotient/` is not a
  protected store.

```
call(cwd) ─▶ machine policy: grant + limits     (~/.config/quotient/policy.json)
          ─▶ root = canonical cwd; entry = longest roots entry ⊇ root
          ─▶ approval governing root?   (deepest approval root ⊇ root; approvals.json)
               yes ─▶ link at approval root ─▶ same real path + sha256? ─ no ─▶ refuse
                                                  │ yes ─▶ run that executable
               no  ─▶ link at entry?  ── no ──▶ machine default form
                                       └ yes ─▶ refuse form-unapproved
```

## Scope & Objectives

- Remove the launch-dir `.quotient/{profiles,help}` layers: profiles and help
  come from the XDG layer only. Fail start-up, with migration guidance, when a
  launch-dir `.quotient/profiles` or `.quotient/help` exists (research X3).
- Drop the profile/help-layer entries for the launch dir from the protected
  stores; `<root>/.quotient/` is not protected. ISS-001's refusal disappears.
- Resolve per-call forms (DEC-007, DEC-010): `<base>/.quotient/forms/{read,write}`
  replaces the executable of the machine's confined slot for that capability
  and inherits its `extensions`. Real path must lie outside every `roots`,
  `exposure` path and the session home. Refusals `form-invalid`,
  `form-unapproved`.
- Approval (DEC-009): `<xdgConfig>/quotient/approvals.json`, a never-writable
  protected store, read at admission every call; approvals govern by
  containment.
- `quotient allow [<path>]` reports; `quotient allow <path>
  <cap>=<realpath>@<sha256>...` records only on a full identity match;
  `quotient revoke <approval-root> [<cap>...]` addresses a stored root
  exactly (DEC-009).
- Contracts (DEC-011): `quotient-policy/2` edited in place (no field
  changes); new `quotient-approvals/1` contract; `form-1` clarification (a
  form that cannot confine exits non-zero; confinement inputs embedded or
  delegate-immutable); refusal additions to `pi-agent-result/2`.
  `.quotient/forms` layout documented. Help, README, examples, client snippet.
- Migrate `scripts/pack-check` and `scripts/hostile-audit` fixtures off the
  launch-dir profile layer.
- Version bump; migration note for satan (move `.quotient/profiles` to XDG).

Expected surface: `src/config.ts`, `src/server/{policy,childview,profiles,server}.ts`,
new form-resolution/approval module(s) under `src/server/`, `src/cli.ts`,
`src/help/help.ts`, tests and `src/server/test-rig.ts`, `src/drift.test.ts`,
`docs/contract/`, `docs/design.md`, `help/`, `examples/`, `README.md`,
`scripts/{pack-check,hostile-audit}`, `package.json`, `package-lock.json`.
Design-target selectors: `doctrine slice selector list 2`.

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
- **Hash scope:** for non-store paths the sha256 pins only the executable;
  anything it calls is the operator's responsibility (DEC-008).
- **Nested roots:** without an approval, `.quotient` is looked up at the
  longest `roots` entry; nested repos and worktrees need their own entries.
- **Relocation:** a `cwd` spelled through a delegate-writable symlink can
  send a call elsewhere, where that place's selection applies; calls inside an
  approved root are never downgraded (design sec-2).
- **Host-wide immutability:** the outside-writable-paths check covers this
  policy's delegates only; approved forms must be immutable to every delegate
  on the host (operator obligation, like the policy file).
- **Agent approval:** the unconfined orchestrator can run the approve verb;
  quotient cannot prevent it. Document that approving is the operator's act.

## Verification / closure intent

- The ISS-001 scenario: a write call rooted at the launch directory is
  admitted (red first).
- Absent `.quotient/` → machine default forms; behaviour of a default install
  unchanged apart from removed launch-dir layers.
- Approved project form runs; a changed form refuses `form-unapproved` with
  identities; a deleted link refuses (no fallback); a call in flight is not
  affected by a later change.
- A delegate-style root-alias retarget cannot re-base a call inside an
  approved root onto the machine default.
- `allow` records nothing when the real path or digest differs from what was
  reviewed.
- A project naming the unconfined form is refused.
- Launch-dir `.quotient/profiles` present → start-up failure with guidance.
- Contracts, help and snippets no longer describe a launch-dir layer.
- `pack-check` still executes its form; `just gate` green; lint zero warnings.

## Summary

Keep grant and limits on the machine; let each project supply its own
confinement in `<root>/.quotient/`, trusted only once the operator approves
the exact built forms.

## Follow-Ups

- IMP-003 — Nix form helper: the customary way a flake produces
  `.quotient/` forms.
- satan: move `.quotient/profiles` to the XDG layer.
- IDE-001 — likely obsolete under DEC-007; re-triage.
- IDE-002 — broaden extension permissions (operator wants this later).
