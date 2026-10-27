# ISS-006: Contracts do not say whether adding a field is additive within a version

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

Found 2026-10-27 drafting SPEC-002, CHR-001. `pi-agent-result-2.md` allows a
new refusal reason within a version; the handle, wait and ack contracts and
the result contract do not say whether adding a *field* to an envelope is
additive (consumers must ignore unknown fields) or breaking. IMP-013 (a help
pointer on refusals) and IDE-007 (in-flight fields on the run document) both
want to add fields.

## Proposal

Decide and state the rule once, in each emitted contract's "Version and
compatibility" section: probably "consumers ignore unknown fields; adding an
optional field is additive". Decide before IMP-013 or IDE-007 lands.
