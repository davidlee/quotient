# Implementation Plan SL-004: Concurrent runs: start and wait tools

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. "sec-N" is a section of the locked `design.md`.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

Ten phases, each ending with `just gate` green. Six build pure modules that are
proven without a server or a process; three wire them into `server.ts`; the
last is shipped text and the client probe.

```text
PHASE-01  evidence foundations      evidence.ts, result.ts reason, spawn.ts observe/onAudit   pure, no behaviour change
PHASE-02  owner identity            session.ts owner + ownerLiveness, fakeProc → test-rig     host probe at entry
PHASE-03  extract callTool          tools.ts, admission.ts (admit), execute.ts, documents.ts  refactor under the net
PHASE-04  run registry              runs.ts with fakeLaunch                                   no processes
PHASE-05  views + documents         views.ts, documents.ts (status, handle, ack, validators)  fixture dirs
PHASE-06  waiting                   waiting.ts                                                real registry, fake launch
PHASE-07  blocking via registry     server.ts: publish, result.json, reply gate, EOF          regression net rewrites
PHASE-08  the four tools + lanes    tools.ts readers, readmit, handlers, tool help sections   sleeper form, end to end
PHASE-09  eras + tasks              protocol.ts, routing, server/discover, tasks/*            legacy unchanged
PHASE-10  docs + probe              contracts, help, design.md, README; IMP-011 probe (VH)
```

Dependencies run strictly down the list: each phase consumes only what the
phases above it built.

```text
evidence ─┬─▶ runs ─▶ views ─▶ waiting ─┐
session ──┘     ▲       ▲               ├─▶ server wiring (07 → 08 → 09) ─▶ docs
extraction ─────┴───────┘ (Admitted, toolResult)
```

## Sequencing & Rationale

- **Foundations first, behaviour unchanged.** PHASE-01 and PHASE-02 add what
  later modules read and write (result.json, audit readers, owner identity)
  without changing anything a client sees. `runChild`'s `removeRun` stays until
  PHASE-07, because only publication makes a kept directory meaningful.
- **Move before building on it.** PHASE-03 is sec-7's "move today's code, do
  not write a second copy" applied first, as a refactor under the existing
  test net with no test edited. Every later module then builds on `Admitted`,
  `admit` and `executeRun` instead of on `callTool`. It also discharges IMP-004
  (admission steps out of `callTool`).
- **The registry alone.** `runs.ts` is the only new long-lived state and holds
  the races the design spent most of its review on (mark before await, one
  commit, the lane loop, the lost path). `fakeLaunch` drives every settlement
  and ordering by hand, so these cases are deterministic and fast.
- **Readers after the writer.** Views resolve what the registry and disk hold;
  waiting composes views. Each is pure over fixtures, so their disk and
  liveness tables are tested exhaustively before a server is involved.
- **Server wiring in three steps**, so a regression points at one change:
  PHASE-07 changes only how the existing blocking call runs (and the four
  deliberate legacy changes of sec-9, less `tools/list`); PHASE-08 adds the
  four tools and lanes (and with them `readmit`, the only caller of queued
  launch); PHASE-09 adds the modern era and tasks on top of a finished run
  model.
- **Tool help sections land with the tools.** A tool's description is its help
  section, so PHASE-08 ships first-draft `tool-*.md` text accurate to the
  behaviour; PHASE-10 completes all prose against sec-8 in one pass.
- **The probe is human-run.** The IMP-011 probe needs Claude Code driving the
  built server, so it is VH in PHASE-10.

## Constraints carried into every phase

- **Lint.** `just lint` is not in the gate and the repo has a large existing
  backlog (IMP-002). Rule: every new file lints clean; every touched
  pre-existing file ends a phase with no more errors than its baseline
  (notes.md § Plan baselines); code moved out of `server.ts` is brought to zero
  errors as it moves. Limits that shape the new modules: complexity 8, depth 3,
  80 lines per function.
- **Shipped text** cites no doctrine ids (`src/drift.test.ts`), including the
  tool help sections in PHASE-08.
- **TDD.** Each phase records its first red in the phase sheet; PHASE-03 is the
  exception (a pure move: the red is any existing test it breaks).

## Routed design-review findings

RV-013 has no findings routed `demonstrate`, `probe` or `control`; all 21 were
fixed in the design. Nothing to transcribe.

## Out of scope, carried

inq-19 (recovering a lost CreateTaskResult), IDE-004, IDE-005, RSK-002,
RSK-003. None blocks a phase.
