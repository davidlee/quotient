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

## Progress 2026-10-27 — GPT review integrated

Review: Codex (strong tier), all seven specs in one pass, for readability
cold and correctness. No RV ledger: no review facet fits a spec. 20 findings
(2 high, 12 medium, 6 low). Each was checked against the cited contract or
code and all 20 observations held. Integrated, with two prescriptions
adjusted: one lifecycle diagram plus a paragraph instead of two diagrams; the
CLI verbs table kept, with its exceptions listed beside it.

Main corrections:

- Confinement, evidence and lifetime guarantees are now conditional on a
  conformant form. Orderly shutdown is split from abrupt death, and
  process-group reach depends on the form keeping its processes in the group
  (ISS-004).
- The owner-lost / other-server-foreign exception is stated (PRD REQ-013,
  SPEC-002 REQ-055).
- Admission is scoped to new runs, after the start-up check, request shape
  and key replay, and ends with the ledger probe (`audit-unavailable`).
- SPEC-002 corrections: the era classifier is ordered, task and suppressed
  replies are exempt from the envelope rule, the evidence-sink table is keyed
  by publication, lanes keep cancelled runs as predecessors, and key-digest
  normalisation is enumerated.
- Builder conformance depends on the operator's runtime additions. The
  portability gates for IMP-008 now include the server's `/proc` dependency.
- Help equality holds only after a healthy start-up. The CLI exit-code
  exceptions are stated, and `revoke` is independent of the policy.
- Readability: a Terms section in PRD-001 §1, terms each spec adds defined
  up front, and the profile header/body split explained with an example.

Verification round on the same Codex thread: 17 resolved, 4 partly resolved
and 4 new defects (wrong spawn-audit row, REQ-015 taking in task responses,
REQ-043 help-load failure, child-view definition). All were verified and
fixed, along with the remaining X-1 statements. `spec validate` is clean. No
shipped text was touched.

Follow-up, not done: the policy contract's "How a call is admitted" also says
"every call", where it means calls that start a run. That is shipped text,
outside CHR-001's spec scope.

Remaining: user acceptance to move specs out of `draft`.

## Progress 2026-10-27 — promoted and rendered

User (2026-10-27): "yes, agreed, promote from draft". All seven specs moved
from `draft` to `active` by editing `status` in each spec's TOML. There is no
CLI verb for it, and `doctrine validate` is clean.

User asked, in the same message, for a justfile recipe that writes the full
specs to disk using `doctrine show`, and for README links to them. Done:

- `just specs` renders every listed spec to `specs/<id>.md`, lowercase
  (`specs/spec-002.md`), and clears the old renders first. The metadata
  header is wrapped in a code block.
- `specs/` sits outside the drift test's shipped-text set (docs, examples,
  help, README, flake.nix, nix) and outside the package's `files`, so the
  uppercase ids the renders contain are allowed there. `pack-check` passes.
- The README's Documentation section now links the renders, not the
  `.doctrine/` prose files.

Caveat: the renders are committed artefacts and go stale when a spec
changes. Re-run `just specs` after spec edits. Not yet gated: a check that
renders to a temp dir and diffs against `specs/` would catch staleness, but it
needs `doctrine` on the gate host.
