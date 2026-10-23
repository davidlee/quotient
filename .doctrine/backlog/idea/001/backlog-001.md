# IDE-001: Policy extends a base policy

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Idea

Let a per-project policy name a base policy (e.g. `"extends": "<abs path>"`)
and override only what differs — typically `roots` and `forms` — instead of
copying profile pins and maxima from the global policy.

## Why

Under the one-policy-per-project model (decided while triaging ISS-001,
2026-10-24), a project that needs its own toolchain carries a full policy
copy. Evidence: `~/.config/quotient/doctrine.policy.json` duplicates the
global policy's profile pins and maxima; each copy drifts independently.

## Why not yet

Two projects use per-project policies. Merge semantics (arrays replace or
append? which fields may a child loosen?) are new authority-bearing machinery:
a child must not be able to widen what its base forbids without that being
explicit. Revisit if per-project policies multiply or drift bites.

## Related

- ISS-001 — fixes the per-project model this idea would make cheaper.
- IMP-003 — form builder; the other per-project setup cost.
