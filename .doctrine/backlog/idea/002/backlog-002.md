# IDE-002: Projects can broaden pi extension permissions

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Idea

Let operators grant extensions beyond `builtin:mcp`. Today a form's
`extensions` admits only `builtin:mcp` (`docs/contract/quotient-policy-2.md:66-72`).
Doctrine, for example, needs a custom pi extension to use its MCP tool, and
extensions are a large part of what pi can do.

## Constraints from SL-002

DEC-010: the machine policy owns a form slot's interface (its extensions); a
project supplies only the executable. Broadening should keep that split —
extensions are a grant, decided centrally, not by the project.

Out of scope for SL-002 (operator, 2026-10-24).
