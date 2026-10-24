# Implementation Plan SL-002: Project forms by root, operator-approved

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. Use this for the plan's rationale and sequencing.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

Six phases, each ending with `just gate` green. The first fixes ISS-001 and
ships no new mechanism. The next three build the approval mechanism bottom-up
(store, judgement, admission). The fifth adds the operator verbs. The last
brings contracts, help and the version in line.

```text
PHASE-01  remove launch-dir layers      config, startup, childview, rig, release fixtures   ← ISS-001 red first
PHASE-02  approvals store               approvals.ts, Locations.approvalsPath, step 8, approvals contract
PHASE-03  root entry + form judgement   resolveRoot entry, forms.ts (probe, chooseForm), result-contract refusals
PHASE-04  admission wiring              server step 5, RunPlan.formSource, spawn record   ← RV-006 F-1
PHASE-05  allow / revoke                approve.ts, cli.ts                                ← RV-006 F-3
PHASE-06  contracts, help, release      policy-2, form-1, help, README, examples, 0.3.0
```

## Sequencing & Rationale

- **PHASE-01 stands alone.** Removing the launch-dir layers fixes ISS-001 by
  itself and touches nothing the later phases need. The release fixtures
  (`pack-check`, `hostile-audit`) move in the same phase, because once the
  legacy check lands, a fixture that still plants `<launch>/.quotient/profiles`
  fails start-up and turns the gate red.
- **Store before judgement before wiring.** `chooseForm` takes an `Approval`
  value, and the server needs both the store and the probe. Building the pure
  and filesystem-bounded units first (PHASE-02, PHASE-03) leaves PHASE-04 as
  composition plus the end-to-end server tests. Those tests are the slice's
  main evidence.
- **The approvals contract lands with the store (PHASE-02).** The drift check
  that parses its `json` blocks with `readApprovals` needs both. The contract
  describes the `allow`/`revoke` verbs that come in PHASE-05. That is safe:
  the design fixes those verbs, and PHASE-05's tests check the behaviour the
  contract describes.
- **The refusal rows land with the type (PHASE-03).** The drift guard reads
  every `export type …Refusal… =` union under `src/server/`, so exporting
  `ProjectFormRefusal` fails the suite until `pi-agent-result-2.md` lists
  both reasons.
- **Help text is split by coupling.** PHASE-01 changes only the help output
  that tests observe and that would otherwise be false (the layer lists, the
  legacy warning). Prose waits for PHASE-06, which checks it against the
  design's documentation checklist (research X6: tests do not catch prose
  drift).
- **Routed findings from RV-006** (the design-review ledger,
  `doctrine review show RV-006 -f 1,3`):
  - F-1 (a delegate retargeting a root symlink must not re-base an approved
    call onto the machine default) is PHASE-04/EX-5 and VT-1.
  - F-3 (`allow` must bind real path and digest together) is PHASE-05/EX-4
    and VT-1.

  Each sits in the phase its ledger placement constraint names. Both are
  verified on the ledger after their phase lands.

## Lint ratchet

The operator chose a ratchet on 2026-10-24. `just lint` is not part of
`just gate` (IMP-002 owns that), and the tree started with 1354 errors. A
noise pass (commit b5c441e: config for `node:test` and the house `type`
style, then `eslint --fix`) brought that down to 575. The per-file counts at
that commit are in `lint-baseline.tsv` next to this file. The rules for every
phase:

- a file the slice creates has zero errors;
- an existing file the phase touches ends with no more errors than its
  baseline row;
- `shellcheck scripts/*` stays clean.

Check with:

```sh
npx eslint <touched files> -f json | jq -r '.[] | "\(.filePath|sub(".*/quotient/";""))\t\(.errorCount)"'
```

Compare the output against `lint-baseline.tsv`.

## Notes

- Line numbers cited in design.md have drifted slightly. For example,
  `absent()` is now at `src/server/paths.ts:61`, not `:140-148`. The cited
  symbols all exist. Phase sheets should cite symbols, not lines.
- `test-rig` already points `XDG_CONFIG_HOME` inside the rig and keeps its
  stub launchers outside `root`. PHASE-04's project-form helper can link to a
  stub launcher.
- `hostile-audit` needs a real jail and a paid model to give a verdict. The
  gate only syntax-checks it. PHASE-01/VA-1 runs it with a stub form to show
  the fixture's server gets past start-up (design sec-4), without relying on
  the verdict.
- There is no changelog. The release note goes in the version-bump commit
  body (precedent: 61fd1a9).
