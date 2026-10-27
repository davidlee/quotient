# CHR-001: Author the first specs: forms contract, MCP server, config/profiles, CLI, confinement policy

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

The project has no specs (`doctrine spec list` is empty), so SL-004's
reconcile had no spec surface to write and its truth lives only in the slice
design, decisions (DEC-045..070) and the shipped contracts in `docs/contract/`.

User, 2026-10-27, during SL-004 reconcile: the next session should create
specs, roughly one each for:

1. the forms contract
2. the MCP server
3. config / profiles
4. the CLI
5. the confinement policy

## Approach

Start with `/spec-coverage-assessment` to settle boundaries (product vs tech
spec, one spec or several per area, what existing docs and decisions each
absorbs), then `/spec-product` / `/spec-tech` per spec. Candidate sources:
`docs/design.md`, `docs/contract/*.md`, `help/*.md`, the SL-004 design
(sec-2..7) and its decisions.

## Then: README

User, 2026-10-27: after the specs, update the project `README.md` in the same
pass — bring it in line with the specs and point readers to them.

## Update 2026-10-27 (supersedes "Then: README" ordering)

User reordered: README first, then release, then specs. Done: README pass and
rewrite (da76a4e, 0048179 — why-over-pi, no-skills, quickstart), release bump
0.6.0 (3ab16b5). Remaining README work: a short second pass after the specs
land, linking them from the Documentation section.

Open items the specs must accommodate rather than foreclose:

- IMP-012 — profile body reaching the delegate as instructions (config /
  profiles spec must not fix "prose is not parsed" as durable intent).
- IMP-013 — refusals point to the help section that fixes them (MCP server /
  result contract).
- IDE-007 — in-flight observability (MCP server; run document fields).
- IMP-008 — macOS Seatbelt forms + manual (confinement policy / forms
  contract must stay backend-agnostic).
- IDE-005 — no bound on runs in flight (stated non-guarantee).

## Progress 2026-10-27 — specs drafted

Coverage map (`.doctrine/state/coverage-map-chr-001.md`, reviewed by the
user): everything was dark; user chose 1 PRD + tech specs, help owned by
Config and profiles, and a thin context spec so the container has a parent
(locked tech-spec shape).

Authored, all `draft`, `spec validate` clean:

| spec | c4 | reqs |
|---|---|---|
| PRD-001 delegation under operator authority | capability | 15 |
| SPEC-001 system context | context | 0 |
| SPEC-002 MCP server | container | 14 |
| SPEC-003 Confinement policy | component | 13 |
| SPEC-004 Forms contract | component | 10 |
| SPEC-005 Config and profiles | component | 10 |
| SPEC-006 CLI | component | 8 |

Open items kept open, per spec: IMP-012 (SPEC-005, PRD OQ-1), IMP-013
(SPEC-002/003/005/006, OQ-2), IDE-007 (SPEC-002/006, OQ-3), IDE-005
(SPEC-002/003, OQ-4, stated non-guarantee), IMP-008 (SPEC-003/004, OQ-5).

README: Documentation section links each spec by numeric path (no doctrine
ids; drift test green). `just gate` green.

Found and captured: ISS-004 (form-1 lacks a process-group guarantee; blocks
IMP-008), ISS-005 (docs say legacy layer fails start-up; it degrades),
ISS-006 (field-additivity rule undefined in contracts), CHR-002 (foreign ids
in code comments). Fixed: three code comments whose foreign `SPEC-001
REQ-009` / `REQ-004` collided with the new ids.

Remaining: user review of the drafts; move specs from `draft` when accepted.
Requirements are `pending` (coverage not recorded).
