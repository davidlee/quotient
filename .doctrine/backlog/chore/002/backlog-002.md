# CHR-002: Repoint code comments that cite ids from the repository quotient was extracted from

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

Found 2026-10-27 while authoring the first specs (CHR-001). Code comments
under `src/` cite doctrine ids and design anchors from the repository quotient
was extracted from:

- DEC ids that do not resolve here: DEC-093, DEC-095, DEC-097, DEC-099,
  DEC-103, DEC-114, DEC-118.
- DEC ids that resolve here but likely mean something else (e.g.
  `policy.test.ts` cited DEC-057, which here is the run-state → Task status
  table). Every `DEC-0NN` citation in `src/` needs checking against its
  title.
- "design sec-N" anchors in 47 files, pointing at a design document that is
  not in this repo.
- Already fixed in CHR-001: `SPEC-001 REQ-009` (childview.ts,
  server.test.ts) and `REQ-004` (policy.test.ts), which collided with the new
  SPEC-001 / REQ-004 and now cite SPEC-004 / SPEC-003.

## Approach

Repoint each citation to the owning spec (SPEC-002..006) or a resolving
decision, or drop the id and keep the substance. Code is outside the
shipped-text drift scan, so citing spec ids there is allowed.
