# Review RV-009 — reconciliation of SL-002

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Mode: conformance, self-audit (raiser `auditor`, responder `author`). Surface
reviewed: the primary checkout on `main` at ee5b8e1; code unchanged since
e660bd6 (Release 0.3.0). Not a dispatched slice, so no candidate branch.

Lines of attack:

1. Path conformance: `slice conformance 2` against a registry bootstrapped at
   audit (`record-delta` per phase, ranges 9aabdf9..e660bd6).
2. Plan VT mandates: `slice verify-vt 2`; for each failure, whether the
   mandated behaviour is tested under other wording.
3. RV-006 F-1 and F-3, the probe-routed design findings: verify each against
   its criterion in the shipped tests (PHASE-04 VT-1, PHASE-05 VT-1).
4. Implementation decisions beyond the design's letter: DEC-012 (approvals
   store refuses non-canonical root/path) against design sec-2 "The approvals
   store"; DEC-013 (`allow` refuses when a deeper approval governs) against
   design sec-3 "quotient allow and quotient revoke".
5. Gate and lint: `just gate`; the per-file lint ratchet
   (`lint-baseline.tsv`) for every touched `src/` file; shellcheck.

Invariants held: design sec-2 Invariants (a call runs the machine slot or an
operator-approved identity; inside an approved root it runs that identity or
refuses); DEC-009 record binds real path and sha256 together.

## Synthesis

**Closure story.** SL-002 delivers what its design promised. `just gate` is
green at e660bd6 (425 tests, typecheck, build, hostile-audit, pack-check 4/4);
every touched `src/` file is within its lint baseline and new files are at
zero; shellcheck is clean. With the source-delta registry bootstrapped (F-6),
`slice conformance 2` reads 42 conformant paths, nothing undelivered, and two
undeclared paths that are in scope (F-4, F-5). After seven test retitles (F-3,
no assertion changed) `slice verify-vt 2` passes every VT criterion. RV-006's
two probe-routed design findings are verified against the shipped tests and
RV-006 is concluded: a call inside an approved root runs that approval's
identity in both roots orders and both retarget variants (server.test.ts:689),
and `allow` refuses a same-bytes repoint without touching the store
(approve.test.ts:356).

Two implementation decisions went past the design's letter, both in the
fail-closed direction, and both are already in the shipped contracts: the
approvals reader refuses non-canonical paths instead of normalising them
(DEC-012), and `allow` refuses to record an approval that a deeper one would
shadow (DEC-013). The design is the stale artefact in each case (F-1, F-2).

**Standing risks.**
- RSK-001: an unapproved form link is hashed in full, synchronously, before
  the approval check. Deferred by choice; a size cap is a policy the design
  does not state.
- The relocation residual (design sec-2): a `cwd` through a delegate-writable
  symlink moves a call to another place's selection. Documented and accepted
  at RV-006 F-1.
- The quotient MCP server in this session runs a pre-0.3.0 build until the
  operator rebuilds and restarts it; ISS-001 stays live until then.

**Tradeoffs accepted.** Approving is the operator's act, but the unconfined
orchestrator can run `quotient allow`, and quotient cannot tell them apart.
Source comments in `src/` cite doctrine ids (e.g. DEC-009, RV-006 F-3). This
is existing house practice (DEC-095, RV-046 in older files); PHASE-06 EX-6
covers shipped prose (contracts, help, README), which is clean.

**Human route.** Admission step 5 (`src/server/server.ts`) composes
`selectSlot` → `checkProfileExtensions` → `lookupProjectForm` (store read,
governing approval, base, probe; `src/server/forms.ts`) → `chooseForm`, and the
spawn execs the probed real path. The operator verb `src/approve.ts` reuses
`lookupProjectForm`, `chooseForm` and `updateApprovals`, the single writer in
`src/server/approvals.ts`. Behaviour worth knowing: a governing approval is
chosen by the deepest recorded root containing the call's canonical root,
independent of how `roots` entries currently resolve. Tests:
server.test.ts:689 (retarget) and :550/:559/:568 (nesting and roots removal).
Sources: `doctrine show DEC-008` (approval is the selection), `doctrine show
DEC-012`, `doctrine show DEC-013`, `doctrine review show RV-006 -f 1,3`.

## Reconciliation Brief

### Per-slice (direct edit)
- RV-009 F-1 — design.md sec-2 "The approvals store", closed-world bullet:
  replace "a non-absolute path" with "a `root` or `path` that is not canonical
  absolute (`path.resolve(x) !== x`), refused rather than normalised;
  duplicates are detected on the canonical form" (DEC-012).
- RV-009 F-2 — design.md sec-3 "quotient allow and quotient revoke": confine
  "recording then adds a deeper approval…" to a shallower governing approval;
  add that when the governing approval is deeper than the roots entry, record
  refuses under the lock naming `quotient revoke <deeper root>`, and the report
  prints that advice in place of an `allow` command (DEC-013).
- RV-009 F-4 — selector registry: `doctrine slice selector add` for
  `src/server/policy.test.ts` as a design-target (load-bearing); mirror it in
  design.md's code-impact / selector listing.

### Knowledge (settle, with operator assent)
- DEC-012, DEC-013 — proposed; settle accepted once the design text above
  matches them.

### Governance/spec (REV)
- None. The shipped contracts (`quotient-approvals-1.md`, `quotient-policy-2.md`)
  already state DEC-012 and DEC-013; no ADR or spec record is affected.
