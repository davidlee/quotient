# SL-001 Research

## Header

- Slice: SL-001 — Measure peak request context for token ceilings.
- Producers: Thread 1, quotient pi research profile (governance applicability); Thread 2, quotient pi research profile (code map). Raw outputs: [raw/governance.md](raw/governance.md), [raw/code-map.md](raw/code-map.md).
- Baseline: [baseline.toml](baseline.toml), minted by `doctrine slice research SL-001`.
- Initial round: project-requested quotient MCP research agents. The design/plan consumer subsequently rechecked the load-bearing source seams and refreshed the design-input deltas after the scope and design changed; the raw thread reports remain historical evidence.

## Verification legend

- Unmarked claims are researcher findings with citations; they have not been independently rechecked by the downstream design/plan consumer.
- Initial researcher claims below remain unmarked unless explicitly noted. The current consumer's checked planning premises are listed under Design-input deltas; raw-thread marks are the researchers' own.
- Governance claims cite durable IDs where available. This checkout has no numbered project governance entities for the relevant contracts; SL-001 and IMP-001 are the related slice and improvement records.

## Thread 1 — governance applicability

### Binding constraints

- SL-001's scope explicitly leaves the peak calculation, cumulative-token enforcement policy, and policy/result compatibility path to design; its follow-ups require validating pi usage semantics/provider events before design and researching compatibility before implementation.
- IMP-001 is the motivating report, but the agent found no project ADR, policy, standard, or spec entities that govern this surface. The binding local contracts are therefore unnumbered repo artifacts: [quotient-policy/1](../../../../docs/contract/quotient-policy-1.md) and [pi-agent-result/1](../../../../docs/contract/pi-agent-result-1.md). The research thread reports that docs/design.md:3-4 names contract docs as normative over the rationale.
- The policy contract defines `maxima.tokens` as input, output, cache-read and cache-write tokens per run, requires all maxima fields, and rejects unknown fields. It says a breaking policy change mints `quotient-policy/2` and keeps the old contract alongside. Research citations: `docs/contract/quotient-policy-1.md:3-4,42-44,52-56`; implementation citations: `src/server/policy.ts:94,102,239-249`.
- Per-call ceilings use the same closed set: `MAXIMA_FIELDS` feeds validation and clamping (`src/server/policy.ts:102,332-346`). A new peak ceiling therefore has a policy and per-call API decision.
- The result contract treats a breaking result change as `pi-agent-result/2`; nested status is separately tagged `pi-run-status/2`, and the outer contract currently lists only cumulative token fields (`docs/contract/pi-agent-result-1.md:3-4,49-60`; `src/reduce/reduce.ts:25`).
- The current design narrative describes retrospective enforcement and stopping when accounting is unknown (`docs/design.md:39-47)); SL-001 excludes pre-emptive enforcement. Treat the slice scope and narrative as design inputs, not numbered governance decisions.
- The research skill requires a persisted, cited research artifact before design consumes it; the round is advisory (`.agents/skills/research/SKILL.md:13-21,25-50`).

### Checked, not applicable

- Project ADRs, policies, standards and specs: none were found in the checkout's governance inventory; boot snapshot says these sections are unpopulated. No numbered authority could be cited for token semantics.
- ADR-003 and SL-229: mentioned by Doctrine CLI help, but neither resolves as a project entity in this checkout; their mentions explain the research command behavior, not local policy.
- docs/contract/form-1.md: launcher/confinement contract, outside the token measurement surface.
- Cost, request-count and wall-clock limits: separate units and explicit SL-001 non-goals.
- docs/design.md: explanatory, not normative under its own preface; used as corroboration only.
- README/help files: derived documentation and migration surfaces, not authorities.
- Memory signposts: no token-accounting or schema-migration decision identified by the thread.

### Revision candidates

- The contracts are treated as normative locally but have no durable Doctrine IDs or coverage edges from SL-001; governance traceability is absent.
- The policy contract says versioned breaking changes remain alongside the old contract, but does not define policy file coexistence, precedence, deprecation, or migration behavior.
- No rule clarifies whether a reducer status schema change requires a result contract revision.
- Current required maxima and closed-world parsing make removing/redefining `maxima.tokens` a compatibility break without a documented migration.
- SL-001 has only a related edge to IMP-001, not an explicit governed-by/specs relationship to the contract surfaces.

### Design-relevant open questions

- Should the peak be a new required policy maximum, an optional compatibility field, or replace the cumulative limit under a new schema?
- Should callers be able to lower the peak limit through the `ceilings` argument?
- Where should the peak appear in status, and which schema tags change (`pi-run-status/2`, `pi-agent-result/1`)?
- Should a peak crossing receive a distinct gate unit in the audit/result vocabulary or reuse `tokens`?
- If cumulative enforcement remains alongside peak enforcement, how should their separate meanings be named and documented?
- Does the design wait for authoritative pi usage semantics to be located and verified? The code-map thread did not find the dependency's usage type/docs.

## Thread 2 — code map

### Hotspots

- Reducer accumulator and status: `src/reduce/reduce.ts:44-66,96-107`.
- Counting records and reading usage fields: `src/reduce/reduce.ts:439-467,508-533`.
- Gate comparison and trigger vocabulary: `src/server/gate.ts:38,138-151`.
- Policy fields and clamping: `src/server/policy.ts:27-32,94,102,332-352`.
- MCP per-call ceiling schema/validation and reducer result flow: `src/server/server.ts:63-91,182-192,298-300,334,421`.
- Audit usage projection and stream seam: `src/server/spawn.ts:332-344,408-414,502-510`.
- Result status embedding: `src/server/result.ts:40-58,68-85,117-118,272`.
- Contract/example surfaces: `docs/contract/quotient-policy-1.md:52-56`, `docs/contract/pi-agent-result-1.md:56-60`, `examples/policy.json:6-11`.
- Test and CLI output precedents: `src/reduce/reduce.test.ts:186-199,323-340,485,512`; `src/server/gate.test.ts:136-143`; help topics at `src/help/help.ts:232-236`.

### Verified facts

- Reducer reads `usage.input`, `output`, `cacheRead`, `cacheWrite`, and `cost.total`; status projects these as input/output/cached/cache_write tokens. The code validates finite nonnegative values (`src/reduce/reduce.ts:509-513,527-533`). Whether pi's `input` includes cached tokens was not verified.
- Normal usage accrues all four token fields cumulatively. Failed `error`/`aborted` sends count toward request count but do not accrue tokens; empty usage marks the request unmeasured, while non-empty failed-send usage accrues cost only (`src/reduce/reduce.ts:445-448,471-494,521-525`).
- `auto_retry_start` is not counted separately; the reducer comment says its `message_end` already counted the send (`src/reduce/reduce.ts:432-436,439-467`).
- `compaction_end` counts when it carries a result object and reads `result.usage`; `summarization_retry_scheduled` increments requests and unmeasured count; compaction-end without a result is not counted (`src/reduce/reduce.ts:435-465`).
- Missing/invalid usage sets accounting unknown, which the gate treats as an abort cause (`src/reduce/reduce.ts:471-475`; `src/server/gate.ts:126-129,149`).
- Gate compares the sum of four cumulative token fields to the token limit; crossing is strictly greater than the bound. Gate reads the shared tally, while final status is recomputed by reducing the captured stream (`src/server/gate.ts:98-103,138-157`; `src/server/spawn.ts:341-342`; `src/server/server.ts:421`).
- Policy maxima and per-call ceiling fields are closed sets, and clamping iterates the maxima field list (`src/server/policy.ts:102,239-249,344-346`; `src/server/server.ts:185-192`).
- The research agent inspected the source checkout at `/home/david/.local/src/pi`, HEAD `936e5f40aede9327b9142b63506ed2b68bc6b4ac` (`v1.4.0-22-g936e5f40a`). Usage types are in `packages/ai/src/types.ts:459-477`: input, output, cacheRead, cacheWrite, totalTokens; cacheWrite1h is a subset of cacheWrite and reasoning is a subset of output (`:465-471`).
- Source provider adapters separate cached input from ordinary input: OpenAI Completions (`packages/ai/src/api/openai-completions.ts:1550-1574`), Responses (`packages/ai/src/api/openai-responses-shared.ts:637-653`), Anthropic (`packages/ai/src/api/anthropic-messages.ts:719-725,877-894`), Google (`packages/ai/src/api/google-generative-ai.ts:236-241`), Bedrock (`packages/ai/src/api/bedrock-converse-stream.ts:722-731`), Mistral (`packages/ai/src/api/mistral-conversations.ts:615-627`), OpenRouter images (`packages/ai/src/api/openrouter-images.ts:179-199`). This supports measuring prompt context as input + cacheRead + cacheWrite, excluding output. Provider-reported totalTokens varies in cache inclusion, so it is not a portable substitute.
- JSON `message_update` usage is a cumulative partial snapshot and `message_end` carries the final message (`packages/coding-agent/src/modes/json-event.ts:10-18,41-45,57-59`). Compaction summary usage is carried in `compaction_end.result.usage` (`packages/coding-agent/src/core/compaction/compaction.ts:1019,1039`; `packages/coding-agent/src/core/agent-session.ts:2911,2930-2938`). Provider retries occur before stream events are consumed (`packages/ai/src/utils/provider-retry.ts:111-116`); session auto-retries retain failed assistant message usage (`packages/coding-agent/src/core/agent-session.ts:1150-1175,1990`).
- Runtime match remains unverified: installed pi is 1.3.0, while this source checkout is 22 commits later at v1.4.0-22. The agent found no token-parsing changes in inspected diffs since v1.3.0, but the minified runtime bundle prevents byte-level verification. Quotient does not pin the pi version it launches.

### Naming and data-flow precedents

- Ceiling units use plural or snake-case names (`requests`, `tokens`, `cost_usd`, `wall_clock_s`); trigger payload carries `unit`, `observed`, and `limit` (`src/server/policy.ts:27-32`; `src/server/gate.ts:38,42-49`).
- `createTally()` supplies the shared empty accumulator for reducer, spawn and gate idle polling (`src/reduce/reduce.ts:97-107`; `src/server/gate.ts:88`).
- The live path is child stream → `countRecord` → `onRecord` → gate; final result independently reduces the same lines and embeds status (`src/server/spawn.ts:332-344`; `src/server/result.ts:117-118,272`).
- Existing tests assert exact cumulative values, gate crossing unit/value/limit, and CLI status text (`src/reduce/reduce.test.ts:186-199,512`; `src/server/gate.test.ts:136-143`).

### Inferred hotspots

- A peak must be stored in the shared tally for live gate access and separately exposed in status; exact field placement is a design decision.
- Adding or redefining a policy unit likely touches maxima validation, per-call clamping, MCP tool schema, examples, contracts and help. These are inferred from the closed field sets.
- The current result contract's optional status rows may allow additive status data, but compatibility semantics are not specified and must be settled by design.
- CLI rendering could need updating if peak context is expected there; the reducer tests pin its existing line format.
- Existing help topics do not include a policy topic, despite IMP-001 mentioning it; the researcher inferred a documentation gap.

### Checked, not applicable

- The installed pi 1.3.0 bundle: source documentation in the installed distribution was available, and the agent inspected newer checkout source, but the bundle is minified and exact token normalization could not be byte-verified. The checkout/runtime version mismatch remains relevant.
- Earlier design references `sec-4`/`sec-5` cited in code are from slice-029. SL-001 now has its own design, whose sections are distinct from those older code citations.
- Form/confinement contract is outside the usage/maxima surface.
- Request-count and wall-clock accounting remain separate. The accepted design preserves cost ceilings but deliberately separates cost validity from token/context validity (DEC-006).

## Cross-thread findings

- The code's cumulative token sum is the contract's current meaning of `maxima.tokens`; changing only the gate arithmetic would silently violate the policy contract. Both threads point to a coordinated policy/result/reducer/gate change.
- A peak requires per-request usage to be represented at the shared counting seam. Current behavior has explicit gaps for failed sends with placeholder usage and unmeasured summarization retries; design must say whether these count as unknown, zero, or excluded, consistent with retrospective accounting.
- Cache semantics in the inspected source are explicit: input excludes cacheRead/cacheWrite, while provider totalTokens may include cached values inconsistently. The remaining uncertainty is parity with the unpinned 1.3.0 runtime.
- Compatibility is coupled across policy schema, caller ceilings, status schema, result envelope, audit trigger units, examples, help and consumers. The current repository documents the cumulative limit as required and per-run.
- The contracts appear locally normative but unnumbered; no project governance entities or traceability edges currently anchor this change.

## Design-input deltas

1. DEC-001 through DEC-006 and CON-001, as expressed by the current scope and design, settle the design inputs: full per-request input/cache/output footprint, context gaps disclosed, independent cost validity, replacement of cumulative enforcement, explicit policy /2/status /3/result /2 migration and package 0.2.0. The research's earlier input-only proposal does not override those decisions.
2. ✓ Consumer re-read `src/reduce/reduce.ts:439-533`: request classification, coupled validity, cumulative accrual, failed-send exclusion and the exact legacy unmeasured-counter increment set are current implementation facts. The design intentionally changes validity coupling while preserving the counter's existing increment set.
3. ✓ Consumer re-read `src/server/gate.ts:98-151`, `src/server/spawn.ts:332-359,403-414,502-510`, and `src/server/server.ts:421`: strict crossings, fixed gate inputs, crossing-time audit snapshots, continued buffered/drain accounting and replay all use the identified seams. Plan tests must compare like event prefixes, not the abort snapshot to final drained status.
4. ✓ Consumer re-read policy and MCP ceiling declarations/validation/clamping in `src/server/policy.ts:27-32,56,102,194-202,237-250,342-360` and `src/server/server.ts:63-91,182-192`, plus schema owners `src/reduce/reduce.ts:25` and `src/server/result.ts:12`. Active help mappings are at `src/help/help.ts:37-38`; drift tests name the old active contracts in `src/drift.test.ts:45-46`.
5. ✓ Consumer inspected `scripts/pack-check:104-118,248-252,403-408` and `scripts/hostile-audit:196-199`. Both need generated-policy migration; pack-check must add explicit schema/context assertions and test the intended committed release tree because it clones HEAD. It is not an automatic npm publish hook. These paths were added to the design-target selector set after RV-001.
6. ✓ Consumer checked `src/root.ts:11-13` and package/lockfile metadata: CLI and MCP use the package version owner, and 0.2.0 must agree across package.json and both package-version locations in package-lock.json. No dependency upgrade or lockfile-format bump is required.
7. ASM-001 retains unverified exact launched-pi token normalization and resumed-session event behavior. Source reads and quotient fixtures do not prove installed-runtime behavior. RV-001 verifies the design repairs, not an executed provider/session probe or installed-package check.
8. Publication remains user-owned after audit and before reconciliation; the design and notes require the reminder at that boundary. Future implementation phases must leave the distinction between proposed verification and executed evidence explicit.

