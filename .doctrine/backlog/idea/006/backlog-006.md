# IDE-006: Deterministic drain on stdin EOF

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Problem

On stdin EOF the server sets `closed` the moment Node emits `end` (design sec-6, DEC-103). Node may emit `end`
while lines from the last chunk are still being dispatched, so a client that writes and closes at once
(`printf req | quotient`) gets all, some or none of its replies — timing-dependent and untestable
(mem.fact.quotient.readable-end-before-dispatch). Real MCP clients keep stdin open and are unaffected; scripts and
one-off probes are not.

## Idea

On EOF only (signals stay immediate): mark the registry closing at the trigger (lanes stop advancing, starts refuse
as closing), but keep dispatching every complete line already received and write their synchronous replies; then
run today's sweep. Needs two flags instead of one `closed` (closing vs. replies suppressed) and a sec-6 amendment.

## Decision so far

User, 2026-10-27 (SL-004 after PHASE-09): not in SL-004 — backlog it. SL-004 PHASE-10 documents the current
behaviour instead: keep stdin open until you have read your replies; closing it cancels runs in flight.
