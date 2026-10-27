<!-- doctrine:section sec-1 -->
## 1. Design Problem

`just lint` (typescript-eslint strict, zero warnings) reports 526 errors on the
main tree and is not in `just gate` (IMP-002). `eslint .` also walks
`.worktrees/`, inflating the count to 1642. The goal is zero, gated, with no
behaviour change, at low orchestrator-token cost, leaving the code better
typed rather than cast-riddled.

Most findings descend from a few untyped sources:

```
source                                         findings fed
Record<string, any> JSON parsers in tests      unsafe-* / no-explicit-any / `as`
  test-rig.ts jsonLines, attempts, replies,      (the bulk of ~230 unsafe + 70 `as`)
  waitForReplies, resultDocument; server.test
  payload; spawn.test oneShot; session.test
  readRecord; childview/profiles drive
reduce.ts: pi event stream read as `any`       ~120 in one file
long branching functions                       28 complexity / depth / length
```

<!-- doctrine:section sec-2 -->
## 2. Decisions

- **D1 — fix sources, not sites.** Tests parse wire documents through type
  guards built on the existing contract validators (`validateAgentResult` in
  `src/server/result.ts`; `validateHandle`/`validateWait`/`validateAck` in
  `src/server/documents.ts`), so `resultDocument(reply)` returns a typed
  `AgentResult` and every call also checks the contract. Generic JSON
  (JSON-RPC envelopes, jsonl evidence lines) is `unknown`, narrowed by small
  readers beside `isRecord` in `src/json.ts`. `reduce.ts` reads events as
  `Record<string, unknown>` through the same readers. A test that
  deliberately reads a contract-invalid document keeps an explicit untyped
  path (`unknown` + readers), never a cast.
- **D2 — complexity by extraction.** Over-threshold functions are split into
  small named pure functions; thresholds (`complexity` 8, `max-depth` 3,
  `max-lines-per-function` 80) stay.
- **D3 — suppressions and rule changes are exceptional.** One rule per
  `eslint-disable-next-line`, with a reason. Config changes need a stated
  rationale recorded in `notes.md`. No new rules.
- **D4 — no regressions.** Each phase ends with `just gate` green and no
  file's lint count above `lint-baseline.tsv`. Each phase diff is checked for
  new `as`, non-null `!`, `any`, `eslint-disable`; each rewritten truthiness
  test is reviewed for `0` / `""` semantics under `strict-boolean-expressions`.
  Behaviour is unchanged on inputs the system produces. A change on
  out-of-contract input is allowed only when it is stricter or no longer
  crashes, is listed in `notes.md`, and is confirmed by a side-by-side review
  against the previous commit.
- **D5 — token economy.** The orchestrator writes the shared helpers (D1)
  first; cheap pi workers (`mcp__quotient__pi_agent`, `implement` profile) fix
  one file cluster per run against them; the orchestrator keeps verification
  (gate, ratchet, diff review).

<!-- doctrine:section sec-3 -->
## 3. Phases

1. Ignore `.worktrees`; per-file baseline; readers in `src/json.ts`; contract
   guards and typed parsers in `src/server/test-rig.ts` (orchestrator).
2. Test files by cluster: gate, profiles, session, spawn, server, rest
   (workers).
3. `src/reduce/reduce.ts`, `src/reduce/cli.ts`: typing and complexity
   (worker, close review).
4. Remaining production files: `spawn.ts`, `session.ts`, `profiles.ts`,
   `policy.ts`, `help.ts`, `result.ts`, `server.ts`, others (workers).
5. `lint` joins `just gate`; IMP-002 resolved.

<!-- doctrine:section sec-4 -->
## 4. Verification

- VT: `just lint` exits 0; `just gate` (now including `lint`) green; test count
  not below the starting count.
- VA: per-phase diff scan (D4) shows no new casts, `!`, `any`, or unexplained
  disables; truthiness rewrites reviewed.

