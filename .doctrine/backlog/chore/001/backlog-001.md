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
