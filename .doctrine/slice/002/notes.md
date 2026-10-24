# Notes SL-002: Project forms by root, operator-approved

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: <yyyy-mm-dd> · <PHASE-NN | stage> · <head-commit>

### Produced

### Learned

### Open

## Design triage (2026-10-24, exploring)

Evidence: `research/research.md` rounds 1–2 (ids X*, Y*, F*, S* below refer
to its rows).

### Shaping decisions (accepted)

- DEC-007 — machine policy holds grant + limits + default forms; profiles and
  help machine-only; project supplies forms in `<root>/.quotient/`, root =
  longest matching `roots` entry.
- DEC-008 — project forms run only when operator-approved by resolved real
  path + sha256; resolved once at admission; `form-unapproved`; `.quotient/`
  not a protected store.

### Constraining governance

- `quotient-policy-2.md:9-11` — policy never looked up in the project tree.
- `quotient-policy-2.md:180-193` — protected stores, existing or not.
- `quotient-policy-2.md:3-5` + DEC-004 — breaking change mints a new schema
  version; refuse old with guidance; keep old contract.
- `docs/design.md:66-72` — profiles/help frozen at start-up (kept).
- `src/drift.test.ts:88-104, 226-265` — refusal reasons, policy keys and env
  vars must be documented in contracts.

### Open questions (→ design inquiries)

1. Approval store: location, format, write path, and its place in step 8
   (Y3).
2. `.quotient/` layout: fixed `forms/{read,write}` executables or
   `forms/<cap>/bin/…` (Y6).
3. Exec-time race: require project forms to resolve outside every writable
   path, or exec a held descriptor (Y1).
4. Policy schema: does anything in the policy document change (an opt-in
   switch for project forms? none?) — and therefore /2 vs /3 (X3, DEC-004).
5. Approve verb: arguments, what it shows before approving, how it records
   (F10, F11).
6. Evidence: what the `spawn` audit record carries (resolved path, sha256,
   source) and how it is pinned (Y5).
7. Root matching: longest-match return of the canonical entry; refusal and
   admission behaviour unchanged (Y4).
8. Legacy launch-dir layers: start-up failure message and scope (X3).

### Risks

- Re-approval friction on every form rebuild (mitigation operational).
- Hash covers the exec chain, not host state read at run time (S3, Y7).
- Breaking: launch-dir profiles stop loading; satan affected (S5).
- An unconfined orchestrator can run the approve verb; documented as the
  operator's act only.

### Assumptions

- Forms are normally Nix store paths or other immutable locations outside
  the project's writable tree (S1, S2).
- One server per client session serves every root in the machine policy.
