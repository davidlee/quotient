# IMP-001: Token ceiling meters cumulative input across requests, not context size

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Observation (2026-10-23, malebolge SL-001 orchestration)

The policy's `maxima.tokens` (320000) is checked against the run's
cumulative token total — every request's input, cache reads included, summed.
Each request re-sends the whole conversation, so the total grows roughly
quadratically in turns. A `write` run on deepseek-flash died at request 16
with `cached: 311,680`, `input: 14,081`, `output: 5,774`: average context
~20k, peak ~30k. Five of seven writer runs that session ended
`ceiling_exceeded` mid-edit, leaving the tree half-changed.

A resumed `session` is worse: its first request already carries the prior
context, so it hits the ceiling within a few requests.

## Why it matters

- The operator's real concern is **context size per request** — model
  quality degrades past ~180k regardless of how many turns produced it.
  Cumulative tokens do not measure that.
- Cost is already bounded by `cost_usd`; cache reads are cheap, so the
  cumulative token meter double-counts a concern `cost_usd` owns.
- The meter punishes the batched, many-small-turns style the server
  instructions recommend.

## Proposal

- Replace (or complement) the cumulative `tokens` maximum with a **peak
  context** ceiling: max input tokens (fresh + cached) of any single request.
- If a cumulative meter stays, exclude or discount cache reads, and say in
  `quotient help policy` exactly what is summed.
- Status should report peak context alongside totals, so a caller can see
  which limit bound.
