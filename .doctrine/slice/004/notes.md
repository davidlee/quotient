# Notes SL-004: Concurrent runs: start and wait tools

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-26 · design:drafting · a777bb1 (all SL-004 doctrine work uncommitted)

### Produced
- design run dr-01a17694 through exploring and inquiring; now drafting, no sections yet
- research: `research/research.md` (+ `raw/code-map.md`, pi research run)
- informal Codex critique (thread 01a176a3-3f4e-7ee3-9804-fc35804790d0, gpt-6.1-sol) folded into DEC-048..054; keep the thread for the formal review (`--resume`)
- minted: IMP-011 — origin, probe evidence; IDE-003 — MCP tasks binding; IDE-004 — list acknowledged runs (title still says include_delivered: no title verb); IDE-005 — in-flight bound

### Learned
- mem.fact.quotient.client-concurrency-readonlyhint — clients overlap calls only with readOnlyHint; annotations need a reconnect; probe the global npm install
- mem_01a16ba3013b7e32ab3259a0d21fe676 — corrected: parallel research threads do not overlap yet
- EVD-001 — the two-call scheduling probe

### Open
- DEC-048 — tools: start, wait, ack, cancel, blocking pi_agent; start key
- DEC-049 — compact run records; result.json on disk; ack only of settled runs
- DEC-050 — lanes, full re-admission at launch, needs_success
- DEC-051 — pure wait, selectors, until, timeout, byte budget
- DEC-052 — wrapper contracts, lost/unknown states, isError
- DEC-053 — mark-before-await cancel; EOF; start cancel boundary
- DEC-054 — readOnlyHint on wait only
- DEC-045 — docs incl. full README pass and design.md revision
- ASM-002 — invalidated; kept for the record
