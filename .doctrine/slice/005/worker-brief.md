# SL-005 worker brief: make one test file lint-clean

You edit ONLY the file(s) named in your prompt. Touch nothing else. With several files, the done-check applies to each.

## Goal
`npx eslint <file> --max-warnings 0` exits 0 AND `npx tsc --noEmit 2>&1 | grep '<file>'` prints nothing.
No behaviour change: every assertion keeps its expected value and meaning. Never delete or skip a test or an assertion.

## Helpers to use (already exist; read them, do not change them)
- `src/json.ts`: `isRecord(v)`, `at(value, ...path)` → unknown (path = keys / array indices; undefined if absent).
- `src/server/test-rig.ts` (around lines 510-780):
  - `toolDocument(reply)` asserts one text content block; `resultDocument(reply): AgentResult` — validated pi-agent-result/2; `status` and `artifacts` are nullable.
  - `ranResult(reply): RanResult` — same, but `status: Status` (typed, from src/reduce/reduce.ts) and `artifacts` non-null. Use this whenever the test reads `doc.status.*` or `doc.artifacts.*` of a run that was spawned.
  - `toolDocument(reply): unknown` — the raw parsed document, for documents that are deliberately not a valid result.
  - `recordLines(text, what)` (newline-framed JSON → records), `jsonLines(path)`, `attempts(dir)`, `server.replies()`, `waitForReplies`, `converse(...).replies` → `Record<string, unknown>[]`.
  - `numberAt(v, ...path): number`, `textAt(v, ...path): string` — fail the test if the value is the wrong type.
  - `envelopeDocument(reply, schema)`, `refusalDocument(reply)`.

## How to fix common findings
- `Record<string, any>` / `any` → `unknown` or `Record<string, unknown>`; `JSON.parse(x) as T` → `const v: unknown = JSON.parse(x)` then narrow with `isRecord`, the helpers above, or the real contract types.
- deep reads on unknown records (`abort.usage.requests`) → `at(abort, 'usage', 'requests')` inside `assert.equal`/`deepEqual` (they accept unknown); `numberAt(...)` where a number is needed for arithmetic or `>`.
- `x!` non-null → an explicit check: `assert.ok(x !== undefined)` / `if (x === undefined) {assert.fail(...)}` before use.
- `find(...)` result then `assert.ok(found)` → `if (found === undefined) {assert.fail('…')}` so it narrows.
- template literal with number/unknown → `String(n)` or `JSON.stringify(v)`.
- strict-boolean-expressions → explicit comparisons (`!== undefined`, `!== null`, `.length > 0`, `=== true`). Keep exact semantics for 0 and ''.
- no-empty-function → `() => undefined` or a named `noop` with a comment.
- Missing return type → add it.
- complexity / max-depth → extract a small named helper inside the same file.
- `as` casts: forbidden. No `!`, no new `any`. `eslint-disable` only if a rule is genuinely wrong for that line: one rule, next-line form, with `-- reason`. Prefer none.

## Done-check (run both before answering; batch commands in one bash call)
npx eslint <file> --max-warnings 0; npx tsc --noEmit 2>&1 | grep -F '<file>' ; echo DONE
(Other files may have tsc errors; ignore them. Do not run the whole test suite; the orchestrator does.)
Optionally: node --test <file> 2>&1 | grep -E '^# (pass|fail)'

## Answer (short)
Files changed; final eslint/tsc output for your file; any eslint-disable added with its reason; anything you were unsure about. Answer by request ~45.

## Production files (PHASE-03/04) — extra rules
- Do NOT edit any test file. The existing tests must pass unchanged: run `node --test <the file's colocated .test.ts>` (and for src/server/* also `npm test` is the orchestrator's job; just run the colocated test).
- Exact semantics. When you replace a truthiness / `?.` / `typeof x === 'object'` check, keep identical behaviour for every input: `0`, `''`, `NaN`, `null`, `undefined`, arrays (note `typeof [] === 'object'` but `isRecord([])` is false), non-plain objects. If an exactly-equivalent rewrite is impossible, keep the closest and LIST it in your answer.
- Untyped JSON input: `Record<string, unknown>` / `unknown`, narrowed with `isRecord`, `at(...)`, `typeof` checks, or small named readers in the same file. No casts.
- complexity / max-depth / max-lines-per-function: extract small named pure functions with a one-line doc comment, in the same file. Keep public exports and their signatures unchanged.
- Keep the file's comment style and density; keep existing doc comments with the code they describe.
