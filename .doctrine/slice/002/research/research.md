# SL-002 research — policy names the profile and help layers

## Header

- Round: pre-design, 2026-10-24. Baseline: `research/baseline.toml` (stamped by
  `doctrine slice research 2`).
- Producers: both threads ran as quotient `pi_agent` delegates, profile
  `research` (deepseek-flash, read-only form), cwd repo root.
  - Thread 1 governance — session `4528870ec01e3c07ad17e430584f7304`, raw:
    `raw/governance.md`.
  - Thread 2 code map — session `f34465bfde134577fadd77fbba03f6e6`, raw:
    `raw/code-map.md`.
- Assembly, verification and cross-thread synthesis: orchestrating agent
  (Claude Opus 5.5).
- No ADRs, policies, standards or specs exist in this repo. Governance is the
  knowledge records (DEC/CON/ASM) plus the contracts in `docs/contract/`, which
  `docs/design.md:3-4` makes authoritative over narrative.

## Verification legend

- ✓ — the consuming agent read the cited site and confirmed the claim.
- unmarked — researcher claim: cited, not checked. Design may lean only on ✓
  rows or rows it verifies at point of use.

## Thread 1 — governance applicability

### Binding

| # | source | binds | |
|---|---|---|---|
| G1 | `docs/contract/quotient-policy-2.md:9-11` | "The policy is authority, so it is never looked up in the project tree." A per-project policy is a separately named file (`QUOTIENT_POLICY`), never discovered by walking the tree. | ✓ |
| G2 | `quotient-policy-2.md:180-193` | Layers are protected whether or not they exist (never-writable). Named layers must stay protected. | ✓ |
| G3 | `quotient-policy-2.md:3-5` | Breaking change mints a new schema version; the old contract stays alongside. | ✓ |
| G4 | DEC-004 | Pattern: refuse old forms "with actionable migration guidance rather than reinterpret or silently convert"; keep historical contracts verbatim; update current help/examples. | |
| G5 | `quotient-policy-2.md:35-38`, `:235-236`; `docs/design.md:66-72` | Profiles and help are frozen at start-up: "A delegate that could edit a profile and have the next call use it would be choosing its own successor's powers. A restart is the operator's act." | ✓ |
| G6 | `quotient-policy-2.md:42-44` | Closed-world parsing: an unknown field refuses `policy-invalid`. | |
| G7 | `docs/design.md:26-31` | Fail closed; never silently downgrade. | |
| G8 | `docs/contract/form-1.md:33-55` | G5/G6 form guarantees make step 8 sound; the form is told the stores via the policy contract. | |

### Checked — not applicable

- DEC-001, DEC-002, DEC-003, DEC-005, DEC-006 — context measurement, gap
  disclosure, ceilings, status/result schema, cost validity. SL-002 changes no
  measurement or payload. Reusing `policy-invalid` adds no refusal reason.
- CON-001 — scoped to SL-001 (version 0.2.0, spent). Only the practice
  (package.json and lockfile bumped together) carries over.
- ASM-001 — pi usage-event shape; unrelated.
- IDE-001, IMP-003 — deferred / sequenced after; context only.
- `docs/design.md` sections on roots, termination, sessions, audit — unaffected.
- `form-1.md` G1–G4, G7, G8 — orthogonal to where layers live.
- `AGENTS.md`, `CLAUDE.md`, `.doctrine/project-orientation.md` — no domain
  constraints.
- `help/policy.md` — does not exist; the `policy` help section renders the
  contract (`src/help/help.ts:38`) ✓, so the contract edit propagates.

### Revision candidates

- `quotient-policy-2.md:37-38`, `:186-187`, `:189-193` (the "cannot be rooted at
  the launch directory" consequence), `:235-236` ✓.
- `docs/design.md:64-66` ("the project's own over the user's, so a repository
  can carry the delegates suited to it"), `:73-77`, `:79-80` ✓.
- `help/profiles.md:8-14`, `help/setup.md:16-18, 51-54`, `help/agent.md:10-11`,
  `README.md:63, 190`, `examples/profiles/{read,research,write,review}.md:26-32`.
- `docs/contract/quotient-policy-1.md` — deliberately **not** revised (G4).
- Drift: `quotient-policy-2.md:4` reads "a breaking change mints
  `quotient-policy/2`" inside the /2 contract — a copy-forward slip; should say
  `/3` (or "the next version") ✓.

## Thread 2 — code map

### Hotspots

| file | why it changes | key lines |
|---|---|---|
| `src/config.ts` | layer builder; only place the launch dir enters a location; header comment states the authority split | `:4-9`, `:15-27`, `:64-78` ✓ |
| `src/server/policy.ts` | new optional field(s): `OPTIONAL_FIELDS`, validator, `Policy` type; schema gate | `:94-95` ✓, `:196-205` ✓, `:285-300` ✓ |
| `src/server/server.ts` | `serve` resolves layers and loads snapshots once; step 8 reads layers from `context.locations` while other stores come from the per-call admission | `:353-364` ✓, `:570-578`, `:646-672` ✓ |
| `src/server/childview.ts` | layer stores; inputs keep shape, source may change | `:103-122` ✓ |
| `src/cli.ts` | `quotient help` resolves layers from cwd before reading any policy | `:41-48` |
| `src/help/help.ts` | header prose; client snippet "`cwd` is the launch dir: where `./.quotient` is found" | `:5-14`, `:156-163`, `:218-224` |
| `src/drift.test.ts` | fails if a policy key or `config.ts` env var is undocumented in the contract; contract/README/example `json` blocks must parse | `:226-265` ✓ |
| tests | `config.test.ts:63-96`, `childview.test.ts:45-82, 159-187, 263-293`, `profiles.test.ts:220-250, 271-339`, `help.test.ts:36-41, 91-139, 216-281`, `cli.test.ts:111-130` | |
| `src/server/test-rig.ts` | `launchEnv`, `xdgProfileLayer`/`xdgHelpLayer`, `newRig` (comment: launch dir's `.quotient/` is the highest layer), `validPolicy` | `:56-70`, `:76-89`, `:162-164`, `:202-227` |

### Cited facts (load-bearing subset; full list in `raw/code-map.md`)

- C1 ✓ The policy is re-read every call (`src/server/policy.ts:4`; `admitCall`
  in `callTool`, `src/server/server.ts:277`). Profiles and help are loaded once
  in `serve` (`src/server/server.ts:646-672`).
- C2 ✓ Step 8 mixes lifetimes: `exposure`, `policyPath`, `runDir`,
  `sessionHome` from the per-call admission; `profileLayers`/`helpLayers` from
  start-up `context.locations` (`src/server/server.ts:353-364`).
- C3 ✓ Optional-field precedent: `transcript_budget_bytes` — in
  `OPTIONAL_FIELDS`, validated only when present, assigned only when present
  (`src/server/policy.ts:95, 285-288`).
- C4 ✓ Schema precedent: an old schema is refused `policy-invalid` with
  migration guidance; no conversion code (`src/server/policy.ts:196-205`).
- C5 Absolute-path lists share one validator shape: `roots` (`:235-238`),
  `exposure` (`:276-280`); helper `isAbsolutePath` (`:110`).
- C6 Snapshots are frozen values with no reload path (`src/server/profiles.ts:76-87, 258-261`;
  `src/help/help.ts:58-66, 135`).
- C7 A bad layer document today fails start-up with one stderr line naming the
  path, and every call then refuses `profile-invalid`
  (`src/server/server.ts:570-578, 663-665`).
- C8 Layer, run and session paths are not checked for disjointness from each
  other or from `roots` (`src/server/childview.ts:103-117`).

### Naming precedents

- Policy path lists are bare plural nouns: `roots`, `exposure`. `_dirs` would
  be new. Internal names already say *layers*: `Locations.profileLayers`,
  `Snapshot.layers` (`src/config.ts:20-22`). Candidates: `profile_layers` /
  `help_layers`.
- Env vars: `QUOTIENT_POLICY`, `QUOTIENT_RUN_DIR`, `QUOTIENT_SESSION_HOME`
  (`src/config.ts:28-31`) ✓.
- Store kinds `profile-layer` / `help-layer` stay; refusals stay
  `policy-invalid` / `view-overlaps-protected`.

## Cross-thread findings

**X1 — The lifetimes conflict (highest value).** G5 requires layers frozen at
start-up; C1 says the policy is per-call. If the policy names the layers:

```
start-up:  read policy → layer names → load snapshot (frozen)
call N:    read policy → names may differ from the snapshot's
```

A policy edit to the layer list would either be inert until restart (breaking
the policy's "applies to the next call" promise) or must be detected. Step 8
must also protect the layers the *current* policy names, not only the
snapshot's, or a delegate can plant into a newly named layer before the
restart that loads it (C2, G2).

**X2 — An environment variable avoids X1.** `QUOTIENT_PROFILES` /
`QUOTIENT_HELP` (absolute, colon-separated or single dir, default XDG), read
once like `QUOTIENT_POLICY`, have the same lifetime as the snapshot. Effects:

| | policy field | env var |
|---|---|---|
| Lifetime vs snapshot | conflicts (X1) | matches |
| Schema change | optional field (+ /3 question, X3) | none |
| Per-project setup | per-project policy | env var in the client config (same place `QUOTIENT_POLICY` is set today) |
| `quotient help` (CLI) | must read the policy first | unchanged path |
| Step 8 | union of snapshot and current-policy layers | unchanged (`context.locations`) |
| Single place for authority | yes | split across policy file and client config |

Both satisfy G1: neither is looked up in the project tree. This departs from
the agreed option 1a (a policy field), so it is a design input for the user,
not a decision.

**X3 — Silent loss of the launch-dir layer.** Governance argues for
`quotient-policy/3`, since a /2 policy would parse unchanged and quietly lose a
layer (G4, G7). But the break is in server behaviour, not in the policy
document, so a schema bump marks it only indirectly. A more direct fail-closed
fix: at start-up, if `<launch>/.quotient/profiles` or `/help` exists, fail
start-up (C7's existing path) with migration guidance. This catches every
affected operator (satan) whichever schema is chosen. Schema version then
follows from X2: an env var needs no bump; a policy field is additive (C3
precedent), and /3 would be justified only by the semantic break, which the
start-up check already covers.

**X4 — "Override" wording.** The slice scope says "opt-in override of the
global policy". Under G1 and with IDE-001 deferred, that means *a separately
selected policy file* with no inheritance or precedence. The scope document
should say so.

**X5 — Named layers can be placed anywhere.** C8: nothing stops a named layer
from sitting inside an allowed root (re-creating ISS-001) or overlapping run
evidence. Design: refuse `policy-invalid` (or fail start-up, for an env var)
when a named layer lies inside a root, or accept and document it.

**X6 — Stale prose survives green.** `src/drift.test.ts:226-265` checks keys
and env vars, not prose. The revision candidates above need an explicit
checklist item in the plan.

## Design-input deltas

1. Decide where layer names live: policy field (1a, agreed at triage) or env
   var (X2). The research favours the env var on lifetime grounds; the user
   decides.
2. Whichever is chosen: fail start-up when a launch-dir `.quotient/{profiles,help}`
   exists, with migration guidance (X3).
3. Schema: no bump for the env var form; for the policy-field form, decide
   between an optional /2 field and /3 (X3).
4. Policy-field form only: define behaviour when the current policy's layers
   differ from the snapshot's, and protect their union at step 8 (X1).
5. Validate named layers against `roots` (X5).
6. Reword the slice scope: per-project policy = separately selected file, no
   inheritance (X4).
7. Fix `quotient-policy-2.md:4` copy-forward slip with the contract revision.
8. Name: `profile_layers`/`help_layers` (policy) or `QUOTIENT_PROFILES`/`QUOTIENT_HELP` (env).

## Resolution (2026-10-24, after the round)

DEC-007 and DEC-008 (accepted) settle deltas 1–5 differently from both
options above: profile/help layers become machine-only (no field, no env
var); a project supplies only forms in `<root>/.quotient/`, gated by operator
approval of the resolved form identity. X1 dissolves (no policy-named layers);
X3's start-up failure for legacy launch-dir layers is kept; X5 is moot
(`.quotient/` is no longer a protected store). Thread 1's G5 (frozen at
start-up) is preserved for profiles/help; for forms, per-call approval
replaces it. The slice scope document is rewritten accordingly.

## Round 2 — forms pipeline and prior art (2026-10-24, design exploring)

Producers: quotient `pi_agent`, profile `research` (deepseek-flash).
Session `158003546b07bfa1c2813532c36bf410` (quotient forms pipeline, raw:
`raw/forms-pipeline.md`); session `28adf2f220bda0a50521c36d81db4053` (satan
forms, cwd `~/dev/satan`, raw: `raw/satan-forms.md`). ✓ = re-read by the
orchestrating agent.

### Code facts

| # | fact | cite | |
|---|---|---|---|
| F1 | `Form` = `{confined, path, extensions}` \| `{unconfined, pi}`; `Forms = {read?, write?}` | `src/server/policy.ts:41-53` | ✓ |
| F2 | Form validation (`readForm`) touches no filesystem: no stat, realpath or executability check | `src/server/policy.ts:154-196` | |
| F3 | Step 5 `selectForm` indexes `policy.forms[filesystem]`; absent → `wrapper-unavailable` | `src/server/policy.ts:318-327` | ✓ |
| F4 | One launch branch: confined → `[form.path, [sessionDir, …]]` | `src/server/spawn.ts:179-181` | ✓ |
| F5 | The `spawn` audit record stores the policy's form text verbatim; no resolved path, no hash; `AuditRecord` is unguarded by contract/drift | `src/server/spawn.ts:278-292`, `evidence.ts:186-190` | ✓ (record) |
| F6 | `resolveRoot` accepts the **first** matching roots entry in policy order and returns only the canonical cwd, not the entry | `src/server/profiles.ts:329, 371-375` | ✓ |
| F7 | `roots` entries are checked only for absoluteness; they need not exist | `src/server/policy.ts:235-238` | |
| F8 | Refusal drift guard: every `export type *Refusal* = '…'` union in `src/server/*.ts` must match the result contract's Refusals table both ways | `src/drift.test.ts:88-104` | ✓ |
| F9 | `sha256Hex` exists | `src/server/evidence.ts:221` | ✓ |
| F10 | CLI is a single switch (serve, `reduce`, `help`, `--version`); `help()` already builds `Locations` | `src/cli.ts:68-88, 41-48` | |
| F11 | No atomic-write helper in `src/`; nearest is `session.ts` `O_EXCL` + `renameSync` | `src/server/session.ts:284-320` | |
| F12 | The run gate re-reads the policy each tick only for `enabled`; resolved-once forms are consistent with that | `src/server/gate.ts:113-136` | |

### Prior art (satan)

| # | fact | cite | |
|---|---|---|---|
| S1 | `just quotient-forms` does `nix build -o <state>/forms/{read,write} .#quotient-{read,write}`: GC-rooted symlinks outside the repo; the policy names `<state>/forms/<cap>/bin/quotient-<cap>`. A rebuild silently changes what runs — no gate today beyond the explicit recipe | `~/dev/satan/justfile:72-81` | ✓ |
| S2 | A form is a store-resident `writeShellScriptBin` whose text `exec`s the next store path by hash, so the sha256 of the resolved script pins the exec chain | `~/dev/satan/flake.nix:364-385` | |
| S3 | The chain reads host state at run time (gateway key, jail home, hardcoded `/home/…`, `/run/user/…`); the hash does not cover it | `~/dev/satan/justfile:88-113`, `flake.nix:96-131` | |
| S4 | A flake check (`checks.quotient-forms`) verifies the built forms' bind sets against a baseline | `~/dev/satan/flake.nix:688-810, 836` | |
| S5 | satan's `.quotient/` holds only `profiles/{read,research,write}.md` | `~/dev/satan/.quotient/profiles/` | ✓ |

### Cross-thread findings

**Y1 — Exec-time race (time-of-check vs time-of-use).** Admission hashes the
form; spawn execs it later (F4). If the resolved form lies inside a writable
root or a read-write `exposure` path, a concurrent write delegate can swap it
in between. Simplest closure: require a project form's real path to lie
outside every `roots` entry and every read-write `exposure` path, so no
delegate can write it. Nix store paths satisfy this trivially. Alternative:
exec via a held file descriptor (`/proc/self/fd/N`) — Linux-only, more
machinery.

**Y2 — Approval stays sound without protecting `.quotient/`.** A delegate
can plant or repoint `.quotient/` (F6–F7 give it no fence once layers go),
but the planted target fails approval. Planting is denial of service, not
escalation. Matches DEC-008.

**Y3 — The approval store must be a protected store.** A delegate that can
write approvals approves itself. It joins step 8's never-writable list.

**Y4 — Longest-match is a new rule.** F6: today the first entry in policy
order wins and the entry is discarded. Admission (accept/refuse) is
unchanged by longest-match; only the `.quotient/` lookup base changes.
`resolveRoot` must return the canonical matched entry.

**Y5 — Evidence must record what ran.** F5: the audit `spawn` record should
carry the resolved real path, the sha256 and the form's source (machine
policy or `<root>/.quotient/`), pinned by a test since no contract guards it.

**Y6 — `.quotient/` format.** S1 shows the natural producer is
`nix build -o <root>/.quotient/forms/<cap> .#…` (a gitignored, GC-rooted
symlink to a store package), mirroring the existing state-dir layout. The
committed-JSON alternative names machine-specific absolute paths (S3) and
gains nothing: re-approval churn is identical. Fixed layout
`.quotient/forms/{read,write}/bin/quotient-{read,write}` vs a convention-free
`.quotient/forms/{read,write}` executable: design decides.

**Y7 — Hash coverage limit is real.** S3: the closure reads host state at
run time. DEC-008 already assigns that to the operator; the contract must say
so plainly.
