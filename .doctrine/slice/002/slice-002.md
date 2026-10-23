# Policy names the profile and help layers

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

The protection is sound (a delegate must not plant a profile for the next
restart). The defect is that authority (profiles pin model, tools, thinking;
help is the text agents follow) is looked up in the project tree, which the
policy itself never is (`src/config.ts` header: "the policy is never looked
up in the project tree").

Triage (ISS-001, 2026-10-24) settled the direction:

- The policy names the profile and help layers. The launch-dir layer goes.
- One policy per project, as an **opt-in override** of the global policy. A
  project needs its own policy only when its profiles, forms, roots or maxima
  differ. Forms stay keyed by capability (settles IMP-003's selection gap).

## Scope & Objectives

- Remove the launch-dir `.quotient/{profiles,help}` layers from location
  resolution and from the protected stores.
- Let the policy name its profile and help layers (working shape: optional
  `profile_dirs` / `help_dirs`, absolute paths, highest first; absent → the
  XDG layer, so the default install is unchanged). Field names, schema
  version (optional field on `/2` vs `quotient-policy/3`) and whether layers
  are re-read per call or at startup are design decisions.
- Keep every named layer a protected store (never-writable), as today.
- Update contracts, help (`setup`, `profiles`, `clients`), README, examples
  and the client snippet, whose `cwd` currently means "where `./.quotient`
  is found".
- Migration note for operators with a project-local `.quotient/` layer;
  version bump (breaking server behaviour).

Expected surface: `src/config.ts`, `src/server/{childview,profiles,server}.ts`,
`src/help/help.ts`, `src/cli.ts`, policy parsing, their tests and
`src/server/test-rig.ts`, `docs/contract/`, `docs/design.md`, `help/`,
`examples/`, `README.md`, `package.json`.

## Non-Goals

- Keying forms or profiles by root (one server for many differently-tooled
  projects). Rejected at triage in favour of one policy per project.
- Policy inheritance / `extends` — IDE-001.
- The Nix form builder — IMP-003 (sequenced after this slice).
- Masking protected paths inside a writable root (ISS-001 option 2).
- Migrating satan's `.quotient/profiles` — operator task outside this repo;
  this slice ships the migration note.

## Risks, assumptions, open questions

- **Breaking:** a project-local `.quotient/profiles` silently stops being
  read. Assumption: only satan uses it (checked `~/dev/*/.quotient`,
  2026-10-24). Design should decide whether the server warns when it finds an
  ignored `<launch>/.quotient/` (a hint, not authority).
- **Policy vs startup lifetime:** the policy is re-read per call; profiles and
  help are read at startup. A policy-named layer couples the two — design must
  say which wins when the policy's layers change without a restart.
- **Protection by path:** a named layer inside an allowed root still fences
  that root for writes. Design: refuse such a policy (`policy-invalid`) or
  keep the step-8 refusal and document it.

## Verification / closure intent

- A write call rooted at the launch directory is admitted when no named layer
  lies inside it (test: the ISS-001 scenario, red first).
- Named layers stay protected: a write root containing one is refused.
- Absent fields resolve to the XDG layer; behaviour of a default install is
  unchanged (tests over `resolveLocations` and profile loading).
- Contracts, help and the client snippet no longer mention a launch-dir layer.
- `just gate` green; lint zero warnings.

## Summary

Move profile and help layer lookup out of the project tree and under policy
authority, so repo-root writes work and per-project configuration means a
per-project policy.

## Follow-Ups

- IMP-003 — Nix form builder (after this slice).
- IDE-001 — policy `extends` (deferred).
- satan: move `.quotient/profiles` to the global layer or a satan policy.
