# ISS-005: Docs say a legacy launch-dir layer fails start-up; the server keeps serving

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

Found 2026-10-27 drafting SPEC-005, CHR-001. README, `help/profiles.md` and
the policy contract say a server finding `<launch dir>/.quotient/profiles/`
or `/help/` "fails start-up". In code the server keeps serving: the
run-starting tools refuse `profile-invalid` naming the path, while wait, ack
and cancel keep serving runs already on disk. SPEC-005 states the code's
behaviour.

Related editorial drift in the same pass:

- `form-1.md`'s Evidence table says quotient verifies no guarantee except one
  sampled G6 case; `scripts/form-probe` (in `just gate`) checks G1–G9
  behaviourally against the shipped Nix probe family. Neither `form-1.md` nor
  `docs/nix-forms.md` mentions `form-probe`. (Both statements are true at
  different scopes: an arbitrary form vs quotient's own builder.)
- `form-1.md` G6 still says "policy, profile and help layers"; there is one
  XDG layer now.

## Proposal

Reword the shipped docs to match: "start-up degrades: run-starting tools
refuse until the layer is moved", and mention `form-probe` in the evidence
story.
