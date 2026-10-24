# ISS-001: Launch-dir profile layer blocks repo-root writes

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Symptom

A `write` call rooted at a repository root is refused `view-overlaps-protected`
whenever the server was launched from that root, which is the default for an
MCP client started in a project (Claude Code launches stdio servers with the
project as cwd). Delegates fall back to subdirectory roots (`src/`, `tests/`)
in separate sessions, and the orchestrator stitches the work together. Observed
in doctrine's SL-286 delegation (2026-10-24).

## Cause

```
launch dir                = <repo>
launch-dir profile layer  = <repo>/.quotient/        protected, existing or not
write root                = <repo>                    writable view contains it
admission step 8          → view-overlaps-protected
```

`quotient help policy` (Protected stores) states the consequence: a write call
cannot be rooted at the launch directory or any parent of it. The protection is
sound (a delegate must not plant a profile for the next restart); the
enforcement is coarse: it fences one path by refusing the whole tree, and that
tree is the natural write root.

The underlying tension: the policy is authority and so "is never looked up in
the project tree". Profiles are authority too (they pin model, tools and
thinking), yet one of their layers is looked up in the project tree and must
then be fenced off.

## Options

1. **Policy names the profile layers** (e.g. a `profile_dirs` array; the
   launch-dir layer becomes opt-in or goes away). No authority in the tree,
   nothing to fence, repo roots become writable. Smallest change; applies the
   policy's own rule to profiles. Help layers would follow the same rule.
   Recommended.
2. **Form masks the store.** The server passes protected paths to the form,
   which ro-binds them inside a writable root; step 8 accepts a masked overlap.
   Needs a `form-2` guarantee the server cannot verify. More machinery for the
   same outcome.

Either is a policy-schema change (`quotient-policy/3` under option 1 if the
launch-dir layer is removed; an optional field otherwise).

## Workaround

Launch the server from a directory outside every root (e.g.
`~/.config/quotient/<project>/`, with `QUOTIENT_POLICY` pointing at a
per-project policy). Its `.quotient/profiles` then gives per-project profiles
outside the tree. Cost: the default `cwd` (the launch dir) is not an allowed
root, so every call must pass `cwd`.

## Related

- IMP-003 (form builder): per-project toolchains currently also need a
  per-project policy and server, since `forms` maps capability → form, not
  (root, capability) → form.

## Triage (2026-10-24)

- Direction: option 1 — the policy names the profile and help layers
  (optional `profile_dirs` / `help_dirs`, default the XDG layer); the
  launch-dir layer goes away. Preferred over deriving layers from the policy
  file's directory: explicit, and the default install is unchanged.
- Per-project model: **one policy per project, as an opt-in override** of the
  global policy. A project needs its own policy only when its profiles, forms
  (toolchain), roots or maxima differ. Settles IMP-003's selection gap: forms
  stay keyed by capability.
- Cost: a project-local `.quotient/profiles` override no longer works without
  config. Only satan uses it (`~/dev/satan/.quotient/profiles/{read,research,write}.md`);
  migrate to the global layer or a satan policy.
- Removes doctrine's workaround (empty launch dir, `cwd` on every call).
- Breaking server behaviour → version bump and migration note.
- Deferred: IDE-001 (policy `extends`) for per-project policy duplication.

## Re-decision (2026-10-24, SL-002 research)

The one-policy-per-project triage above is superseded by DEC-007 (machine
policy owns grant and limits; projects supply forms in `<root>/.quotient/`,
keyed by root) and DEC-008 (project forms run only when operator-approved by
resolved identity; `.quotient/` is not a protected store). IDE-001 is likely
obsolete under DEC-007.
