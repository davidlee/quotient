# Notes SL-002: Project forms by root, operator-approved

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-24 · audit concluded (RV-009) · this commit

### Produced
- PHASE-01..06 done; release 0.3.0 — commits 9aabdf9..e660bd6 (fork branch `sl-002`, fast-forwarded to main), db1fff6; `just gate` green at e660bd6 (425/0, pack-check 4/4)
- per-phase deltas and review refinements — § Execution log below
- minted: RSK-001 — unapproved form link hashed in full before the approval check
- RV-009 — audit ledger, done; synthesis and reconciliation brief in `review-009.md`
- RV-006 — F-1, F-3 verified against shipped tests; concluded, done
- source-delta registry rows for PHASE-01..06 (bootstrapped at audit, RV-009 F-6)
- seven test retitles so `slice verify-vt 2` passes (RV-009 F-3)
- operator chore, not backlog: rebuild and restart the quotient MCP server so the ISS-001 fix is live
- `.worktrees/sl-002` fork and branch `sl-002` still present (merged)

### Learned
- mem.pattern.quotient.pi-agent-orchestration — 30-request calls, rotating sessions near 120k, commit before the gate, review workers; record-delta per phase; VT keywords in test titles

### Open
- RV-009 F-1, F-2, F-4 — reconciliation brief items (design sec-2, sec-3, selector add) for /reconcile
- DEC-012, DEC-013 — proposed; settle at reconcile with operator assent
- RSK-001 — deferred robustness gap (a size cap is policy the design doesn't state)
- IMP-003 — the Nix helper should emit single-file forms (after SL-002)
- IMP-004, IMP-005 — follow-up refactors from the arch pass (unchanged)

## Design triage (2026-10-24, exploring)

Evidence: `research/research.md` rounds 1–2 (ids X*, Y*, F*, S* below refer
to its rows).

### Shaping decisions (accepted)

- DEC-007 — machine policy holds grant + limits + default forms; profiles and
  help machine-only; project supplies forms in `<root>/.quotient/`, root =
  longest matching `roots` entry.
- DEC-008 — project forms run only when operator-approved by resolved real
  path + sha256; resolved once at admission; `form-unapproved`; `.quotient/`
  not a protected store.

### Constraining governance

- `quotient-policy-2.md:9-11` — policy never looked up in the project tree.
- `quotient-policy-2.md:180-193` — protected stores, existing or not.
- `quotient-policy-2.md:3-5` + DEC-004 — breaking change mints a new schema
  version; refuse old with guidance; keep old contract.
- `docs/design.md:66-72` — profiles/help frozen at start-up (kept).
- `src/drift.test.ts:88-104, 226-265` — refusal reasons, policy keys and env
  vars must be documented in contracts.

### Open questions (→ design inquiries)

1. Approval store: location, format, write path, and its place in step 8
   (Y3).
2. `.quotient/` layout: fixed `forms/{read,write}` executables or
   `forms/<cap>/bin/…` (Y6).
3. Exec-time race: require project forms to resolve outside every writable
   path, or exec a held descriptor (Y1).
4. Policy schema: does anything in the policy document change (an opt-in
   switch for project forms? none?) — and therefore /2 vs /3 (X3, DEC-004).
5. Approve verb: arguments, what it shows before approving, how it records
   (F10, F11).
6. Evidence: what the `spawn` audit record carries (resolved path, sha256,
   source) and how it is pinned (Y5).
7. Root matching: longest-match return of the canonical entry; refusal and
   admission behaviour unchanged (Y4).
8. Legacy launch-dir layers: start-up failure message and scope (X3).

### Risks

- Re-approval friction on every form rebuild (mitigation operational).
- Hash covers the exec chain, not host state read at run time (S3, Y7).
- Breaking: launch-dir profiles stop loading; satan affected (S5).
- An unconfined orchestrator can run the approve verb; documented as the
  operator's act only.

### Assumptions

- Forms are normally Nix store paths or other immutable locations outside
  the project's writable tree (S1, S2).
- One server per client session serves every root in the machine policy.

## Design review 1 (2026-10-24, informal, Codex gpt-6.1-sol)

Pre-drafting second opinion on DEC-007..011. Codex thread
`01a16b88-df39-7c13-88c1-194fa0dec4f8`; verdict "proceed with amendments".
All cited sites verified before disposition. Operator agreed to all
dispositions.

| # | finding | disposition |
|---|---|---|
| 1 | blocker: session dirs writable (form-1 G3) but not excluded from form real-path rule | integrated: DEC-010 forbidden set = roots ∪ exposure ∪ session home (G5 writable set) |
| 2 | major: deleting project links falls back to broader defaults; deletion ≠ revocation | integrated: approval entry is the selection (DEC-008); no fallback once approved; `quotient revoke` (DEC-009); DEC-007 wording |
| 3 | major: `--dry-run` then `allow` can approve an unreviewed repoint | integrated: `allow <path> <cap>=<sha256>` records only on match; bare `allow` reports (DEC-009) |
| 4 | major: concurrent allow lost update; corrupt store unspecified | integrated: lock across read-modify-write; malformed store refuses and is never overwritten (DEC-009) |
| 5 | major: staying on /2 unjustified | partly contested: no /2 document changes power without an operator act; integrated the missing rationale as an explicit compatibility rule in the contract (DEC-011); /2 kept by operator choice |
| 6 | minor: root-keyed identity; `canonicalPath` swallows all errors (`src/server/paths.ts:29`) | integrated: documented (DEC-007 consequence); `.quotient` lookup treats only ENOENT as absent (DEC-010) |
| 7 | minor: "in-flight unaffected" overclaims (GC/deletion before spawn) | integrated: guarantee narrowed to "selection never changes mid-call; failed launch, no fallback" (DEC-008) |
| 8 | note: hash doesn't freeze confinement inputs | integrated: MUST embed or keep delegate-immutable; form-1 publishing requirement (DEC-010) |
| 9 | note: unknown refusal reasons | integrated: pi-agent-result/2 gains a must-handle-unknown rule (DEC-011); validator already accepts any reason (`src/server/result.ts:388`) |

Defect class: the design proved approval *checking* but not operator
ownership of *selection, fallback and revocation*; 2/3/7 were siblings.
Follow-up: re-run Codex on the drafted design.md (operator request).

## Further review passes (2026-10-24, after RV-006)

RV-006 (Codex gpt-6.1-sol, second design review) concluded; F-1..F-6
verified — `doctrine review show RV-006`. Amended DEC-007..010.

A further design pass would probe, in order of value:

- The governing-approval rule under concurrent `allow`/`revoke` and admission
  (store read once per call vs. lock-holding writers) — believed sound by
  rename atomicity; not yet attacked.
- The relocation residual: whether a cheap refusal (requested `cwd` lexically
  inside an approved root but resolving outside it → `form-invalid`) is worth
  adding. Operator chose to document, not block; revisit only if relocation
  is seen in practice.
- Contract prose for `quotient-approvals-1.md`, once drafted in execution —
  better reviewed as code/docs (audit) than as design.

Otherwise no further design pass is needed: remaining risk is implementation
fidelity, which plan VT criteria and `/audit` cover.

## Execution log

Orchestrated via quotient `pi_agent` workers in the doctrine fork
`.worktrees/sl-002` (branch `sl-002`): a write agent rooted at the repo root is
refused `view-overlaps-protected` (ISS-001 itself) while the quotient MCP server
runs from this checkout. Workers have no git; the orchestrator commits and runs
`just gate` (pack-check needs git).

### PHASE-01 — done

- `resolveLocations` and test-rig `admit` lost the dead `launchDir` parameter.
- `scripts/hostile-audit` and `scripts/pack-check` now `mkdir -p "$launch"`
  explicitly (the old `.quotient` mkdir created it as a side effect).
- Legacy-layer start-up failure distinguishes a non-directory entry ("remove or
  replace it") from a layer of documents ("move these documents"), and names
  both layers in one line when both are present.
- Deferred to PHASE-06 (review of PHASE-01): `help/profiles.md:10,14` and
  `help/setup.md:17,52-53` still teach the launch-dir layer; `help.ts:226`
  renders "`cwd` is the launch dir: where `./.quotient` is found", and the
  `help.test.ts` guard only catches the absolute `<launch>/.quotient` form.

### PHASE-02 — done

- `src/server/approvals.ts`: closed-world reader, `governingApproval`, locked
  atomic writer; contract `docs/contract/quotient-approvals-1.md`.
- Review hardening beyond the design's letter: roots and paths must be
  canonical absolute (`resolve(x) === x`, refused not normalised) so duplicate
  detection and longest-match cannot depend on file order; the temp file is
  unlinked then created `wx`/0600 and removed on failure; a change's result is
  re-parsed before publishing; the lock is released only while it still carries
  this pid.

### PHASE-03 — done

- `src/server/forms.ts`: `lookupProjectForm`, `probeProjectForm`, `chooseForm`;
  `rootsEntry` deepest match; `selectSlot`/`SlotSelection`/`SlotRefusal`;
  `FormSource` and `writablePaths` in `policy.ts`; step-5 refusal rows in
  `docs/contract/pi-agent-result-2.md`.
- Review: `chooseForm(slot, governing, base, probe)` takes the probed base, so a
  refusal names the link actually inspected (matters for PHASE-05's explicit
  base); `governed` takes only the confined form variant; base-selection and
  symlink-canonical tests strengthened and mutant-checked.

### PHASE-04 — done

- `callTool` step 5 composes slot → extensions → approvals store → governing
  approval → lookup base → probe → `chooseForm`; spawn execs the probed real
  path (the hashed object, resolved once); the spawn record names the form
  source. Review verified no hash/exec TOCTOU and fail-closed on an unusable
  location or malformed store.
- The unusable-`approvalsPath` branch is defensive only: XDG-only profiles
  refuse at step 3 first.
- Deferred: RSK-001 (full synchronous hash of an unapproved link target).

### PHASE-05 — done

- `src/approve.ts`: `quotient allow [<path>]` report (pure render; per
  capability it shows the verdict admission would reach, via the same
  `chooseForm`), `allow <path> <cap>=<realpath>@<sha256>…` (re-probes under the
  lock, all-or-nothing, keyed by roots entry), `quotient revoke`.
- Review refinements beyond the design's letter — PHASE-06 must document them:
  - a governing approval deeper than the roots entry shadows any roots-entry
    approval; the report says so and prints the `quotient revoke <deeper root>`
    instead of an inert `allow`, and recording is refused (checked under the
    lock);
  - usage errors (exit 2): empty `<path>`, duplicate capability in `allow` or
    `revoke`; `revoke` has its own usage line;
  - `revoke` with no store fails (exit 1) without creating the config dir or a
    lock.

### PHASE-06 — done

- Contracts, help, README and examples describe shipped behaviour; the
  `help.test.ts` guard now also catches relative `./.quotient` layer mentions.
- A docs accuracy review (claims checked against code) corrected: `revoke`
  returns the machine form only once no link remains (else `form-unapproved`);
  a missing link with nothing approved runs the machine form; the deeper-
  approval refusal, report verdict lines, revoke/usage exit codes and the
  non-directory legacy advice are documented.
- 0.3.0; release note is the bump commit body (no changelog; precedent 61fd1a9).
