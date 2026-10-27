# SL-005 notes

## Design review (2026-10-27)

Human pass: the user read the full proposal in-session (lint state, D1–D5,
phases, verification) and replied "agreed"; no findings. A further pass is
not needed before execution: the design is a burn-down under fixed rules,
and the risk it carries (behaviour change while re-typing) is checked per
phase by D4 (gate green, per-file ratchet, diff scan), which is stronger
evidence than another design read. A further pass would probe only whether
the D1 contract guards reject documents some test reads on purpose; phase 1
answers that empirically.

## Progress

### PHASE-01 (2026-10-27) — done

- `eslint.config.js` ignores `.worktrees`. Baseline: `research/lint-baseline.tsv`
  (526 → 332 after this phase; ratchet: no file rose).
- `src/json.ts`: `at(value, ...path)` (own properties, array indices; tests in
  `src/json.test.ts`, red first: missing export).
- `src/server/test-rig.ts`: `recordLines`/`jsonLines`/replies return
  `Record<string, unknown>[]`, failing on a non-object line; `toolDocument`
  (raw, but asserts one `text` content block), `resultDocument` (validated
  `AgentResult`), `ranResult` (status narrowed by its schema token, artifacts
  non-null), `numberAt`/`textAt`; `killSurvivors` split (`killGroup`).
- Deviation from plan: tightening the rig's return types broke 57 type sites in
  gate/spawn/server/profiles tests, so those four files were brought to
  lint-clean inside PHASE-01 (gate must end green) instead of PHASE-02.
- Doctrine: `slice phases 5` materialised PHASE-02..05 but not PHASE-01
  ("Phases up to date" on re-run); tracking file created by hand from the
  PHASE-02 template.

### PHASE-02 (2026-10-27) — done

Every `src/**/*.test.ts` lint-clean; gate green, 745 tests; lint 332 → 236
(all remaining in production files). One suppression:
`result.test.ts` `consistent-type-assertions` on a forged `LatchCause[]`
(the test's subject is a value the type cannot hold). Reviewed: session.test
guard removals follow `assert.equal(x.ok, …)` narrowing, releases kept;
childview step-8 test moved onto `converse`/`refusalDocument` (equivalent,
stricter).

### PHASE-03 (2026-10-27) — done

`src/reduce/**` lint-clean; gate green, 746 tests; lint 236 → 97.
- reduce.ts: events read as `Record<string, unknown>` via `at`/typeof; `reduce`
  and `fit` split into named helpers; `observeContext` reuses `readTokens`.
- Equivalence: independent pi review ran ~500k differential cases (old vs new,
  random + corrupted streams, budget sweeps): 0 mismatches on inputs that did
  not throw before. Accepted divergences: streams with non-array `content` or
  non-string `text` blocks used to throw and now reduce (block skipped); the
  options object's `alerts` is read before `budgetBytes`.
- cli.ts: `parseArgs`/`main` split; equivalence by 2959 argv sequences.
- DRY (beyond lint): one `messageOf` in new `src/errors.ts` (the total,
  never-throwing variant from runs.ts) replaces three copies and eight inline
  `error instanceof Error ? … : String(error)` sites (cli, server, runs,
  spawn, evidence, execute, drift.test).
- Gotcha: the gate's `nix-build` sees only git-tracked files; new source files
  need `git add -N` before the gate.

### PHASE-04 (2026-10-27) — done

Every production file lint-clean; `npx eslint .` → 0. Gate green, 748 tests.
- Accepted divergences (only on inputs the system never produces, all stricter
  or total where the old code cast or crashed): session.ts `bindingOf` refuses
  a hand-edited binding whose `session`/`bound` is not a string; policy.ts
  builds `maxima` in canonical key order; spawn.ts `crossingOf` reads own
  properties; help.ts `requiredText` throws on an impossible null; server.ts
  answers a JSON-RPC-invalid id (bool/object/array) as `null` (spec-correct)
  instead of echoing it; root.ts `packageVersion` throws naming the file when
  package.json has no version string; server.ts `handleLine` is synchronous
  with one explicit microtask per record in `dispatchLines` (same ordering as
  the old `await`).
- Regression caught by the equivalence review, fixed red/green: policy.ts
  split moved the `mode` check before the unknown/missing-field checks,
  changing the first defect reported (one case `policy-invalid` →
  `posture-unsupported`). Original order restored (`checkStaticOnly` →
  `checkShape` → `checkMode`) and pinned by a new policy.test case.
- DRY: one `isMember` in `src/json.ts` replaces the copies in documents.ts and
  result.ts (tested in json.test.ts).

### PHASE-05 (2026-10-27) — done

`just gate` runs `lint` first. IMP-002 resolved.

## Review passes (pi workers)

Brief: `worker-brief.md` (this dir). Profile `implement` (deepseek-flash, high).

| file | cost | outcome | what pi got wrong / orchestrator fix |
|---|---|---|---|
| gate.test.ts | $0.027 | clean, 20 pass | — |
| spawn.test.ts | $0.029 | clean, 35 pass | local `oneReply` duplicated rig parsing (it flagged this itself) → rig `recordLines` exported and reused; winner parse kept strict (exactly one reply) |
| server.test.ts | $0.029 | clean, 85 pass | dropped the one-text-content-block assertions in `payload` → moved into `toolDocument` for every suite |
| profiles.test.ts | $0.040 | clean, 29 pass | — (extracted `profileOf`, `shippedProfiles`; stricter helpers) |

| session.test.ts | $0.036 | clean, 16 pass | — |
| childview.test.ts + result.test.ts | $0.042 | clean, 18 + 88 pass | one justified disable |
| reduce/policy/root/config/cli tests | $0.040 | clean | local `failedChild` helper in reduce.test (kept: avoids pulling the server rig into a unit test) |

| reduce.ts | $0.063 | clean | — (large restructure) |
| reduce.ts equivalence review (`review` profile) | $0.034 | 0 value mismatches / ~500k cases | — |
| reduce/cli.ts | $0.036 | clean, differential-tested | added a 3rd local `messageOf` → consolidated |

| spawn.ts | $0.060 | clean, 55 pass | — |
| session.ts | $0.046 | clean, 16 pass | `bindingOf` stricter (accepted) |
| profiles.ts + policy.ts | $0.090 | clean, 55 pass | **reordered policy checks** (claimed "original order exactly") → caught by review, fixed |
| help.ts + result.ts | $0.065 | clean, 135 pass | another local `isMember` → consolidated |
| server/root/gate/cli/paths | $0.035 | clean, 120 pass | listed its divergences honestly |
| PHASE-04 equivalence review (`review`) | $0.051 | 1 confirmed regression | — |

Total pi spend ≈ $0.87 over 18 runs. Lesson: a worker's "order preserved"
claim is not evidence; a differential review against HEAD is, and found the
one regression the tests missed.

Observed: pi_agent calls from this client run serially (~2 min each).
