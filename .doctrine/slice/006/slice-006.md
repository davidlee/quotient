# Handback reserve: nearing-ceiling wrap-up and a partial-result label

## Context

Originates from IDE-010 (field notes from Nemesis SL-024 and Malebolge). The
gate acts only after a bound is crossed (`src/server/gate.ts:117`) and never
warns the child. A ceiling stop returns `result: null`, so whatever the worker
had already earned is lost; the orchestrator recovers it by reading the tree
and continuing the session (`help/orchestrate.md` § When a run stops short).
This session's own runs show the cost: two of three green/red steps stopped at
the ceiling with no answer and their edits landed (`QUOTIENT-META.md`).

The user chose to slice this rather than do it in one session (2026-11-21),
because it needs design decisions across the spawn, the gate and the result.

## Scope & Objectives

- An opt-in soft threshold below a hard ceiling. When a run reaches it, the
  worker is told to finish its current deliverable and answer: files edited,
  the last test and its exit status, the remaining work.
- The hard ceiling stays exactly as today.
- A result produced after the reserve fired is labelled partial, as an added
  field (additive under DEC-072; readers take absence as `null`).
- Help and contract text for the new input and output fields.

## Mechanism candidates (for /design)

Evidence, pi 1.6.0 docs under its `libexec/pi/docs/`:

- **A — quotient pi extension.** A `turn_end` handler can append a
  `custom_message` draft (user-role) before the next request
  (`extensions.md:746-748`). Works under today's `--mode json`. Quotient already
  loads one builtin extension with `-e` (`src/server/spawn.ts:172-175`).
- **B — RPC mode.** `--mode rpc` accepts `steer`, delivered "after the current
  assistant turn finishes executing its tool calls, before the next LLM call"
  (`rpc-commands.md:46`). RPC emits no session header and is long-lived, so the
  transport, session-id discovery and process shutdown all change.

## Open questions (for /design)

1. A or B. A looks smaller; B moves the control into the server's gate.
2. Who counts: the child (an extension counts its own turns/tokens) or the gate
   (which already meters requests, context and cost) — and whether the two
   counts can disagree (compaction, retries: see SL-001 / DEC-003 accounting).
3. Where the threshold is set: per call (`ceilings`-style), per profile, or in
   policy; its unit (fraction of the ceiling or an absolute reserve); and which
   dimensions it covers (`requests`, `context_tokens`, `cost_usd`, wall clock).
4. Extension admission: forms admit only `builtin:mcp` and spawn passes
   `--no-extensions` (IDE-002, DEC-010). A second builtin needs a policy and
   confinement story; is it always loaded, or only when the reserve is asked for?
5. The partial label: a new field (e.g. `reserve` with when/why it fired) vs a
   new `termination` value; how `final`, `next` and `state` read for a run that
   answered under the reserve.
6. What if the worker ignores the message: the hard ceiling still fires; does
   the result say the reserve fired?

## Affected surface

- `src/server/spawn.ts` (argv, extension loading), `src/server/gate.ts`
  (thresholds), `src/server/result.ts` (partial label, `ADDED_FIELDS`),
  `src/server/tools.ts` (input field), `src/server/policy.ts` if the threshold
  is policy-bound.
- A new builtin extension (path A) alongside the MCP one.
- `docs/contract/pi-agent-result-2.md`, `docs/contract/quotient-policy-2.md`,
  `help/orchestrate.md`, `help/leash.md`, `help/tool*.md`.

## Non-Goals

- Changing the hard ceilings or their enforcement.
- Recovering a result from a run that hit the hard ceiling (that stays the
  continue-the-session recipe).
- General extension admission for projects (IDE-002).
- Calls requested but never started (IMP-020).

## Verification intent

- Tests: a run crossing the soft threshold gets the wrap-up message exactly
  once, and its answer is labelled partial; a run without the opt-in is
  byte-identical to today; the hard ceiling still stops a run that ignores it.
- A real-pi check (the forms probe or a gated run) that the message reaches the
  model under the confinement.
- `just gate` green.

## Summary

Scoped 2026-11-21; design deferred to a later session. Run `/research` on
mechanism A vs B before `/design`.

## Follow-Ups
