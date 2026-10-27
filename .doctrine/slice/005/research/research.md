# SL-005 research — lint burn-down

## Header

- Round: pre-design, 2026-10-27, by the orchestrating agent (Claude Opus 5.5),
  in-session. Small round: the question is a survey of the lint output, not
  open design space.
- Governance: no ADRs, policies, standards or specs bear on linting
  (`doctrine search "lint eslint"` → IMP-002, IMP-004, SL-002, SL-004 only;
  no memory matches `lint`). IMP-002 sets the desired outcome.

## Verification legend

- ✓ — observed directly by the consuming agent this session.

## Findings

| # | finding | |
|---|---|---|
| R1 | `npx eslint . -f json` → 1642 problems; 526 in the main tree, rest in `.worktrees/sl-002`, `.worktrees/sl-003` (not ignored by `eslint.config.js`). | ✓ |
| R2 | Both worktree branches have no commits beyond `main` and clean trees; SL-002/003 are `done`. | ✓ |
| R3 | Main tree: 0 auto-fixable findings. Top rules: no-unsafe-member-access 159, consistent-type-assertions 70, restrict-template-expressions 57, no-explicit-any 38, no-unsafe-argument 31, strict-boolean-expressions 28, no-unnecessary-condition 25, complexity 21. | ✓ |
| R4 | Hotspots: `src/reduce/reduce.ts` 124, `src/server/gate.test.ts` 56, `profiles.test.ts` 49, `session.test.ts` 36, `spawn.test.ts` 34, `server.test.ts` 28, `test-rig.ts` 27. | ✓ |
| R5 | `Record<string, any>` JSON parsers: `test-rig.ts` (`jsonLines` :514, `attempts` :532, `replies` :572, `waitForReplies` :628, :685, `resultDocument` :697), `session.test.ts` :114/:228/:330, `spawn.test.ts` :117/:146/:856, `server.test.ts` :105/:116/:275, `childview.test.ts` :472, `profiles.test.ts` :535. | ✓ |
| R6 | `reduce.ts` reads pi events as `any` (`:180`, `countRecord` :455, usage readers :493–:575); comment states the stream has no contract. | ✓ |
| R7 | Existing reuse points: `isRecord` in `src/json.ts`; contract validators `validateAgentResult` (`src/server/result.ts:365`), `validateHandle`/`validateWait`/`validateAck` (`src/server/documents.ts:236–283`) returning `Validation`. | ✓ |
