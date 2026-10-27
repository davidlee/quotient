# ISS-004: form-1 does not require a form to stay in its process group

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

Found 2026-10-27 drafting SPEC-004 (Forms contract), CHR-001. The server
runs the form as leader of its own process group and stops it by signalling
that group (SPEC-002's termination ladder). `docs/contract/form-1.md`
describes that as the server's behaviour, but lists no guarantee that the
form and everything it starts stay in the group. A form that calls
`setsid()` (IMP-008 notes one macOS launcher does) meets G1–G10 as written
yet escapes cancellation and shutdown, breaking "no run outlives the server"
(PRD-001 REQ-014).

## Proposal

Add a guarantee: the form and everything it starts remain in the process
group it was started in. Decide whether that is additive to form-1 (existing
Nix forms already comply) or needs form-2. Blocks IMP-008.
