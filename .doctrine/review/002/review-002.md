# Review RV-002 — code-review of SL-001

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Review scope: the `src/reduce/reduce.ts` and `src/reduce/reduce.test.ts` delta for
SL-001 PHASE-01, against the locked design sections 1-2 and the phase's EX/VT/VA
criteria.

Lines of attack:

- Confirm request classification remains owned by `countRecord`, with exactly
  one context measurement or gap for each counted assistant send, result-bearing
  compaction, and summarization retry.
- Check full-footprint arithmetic, finite/nonnegative input validation, finite
  sum, monotonic peak, measured-zero versus failed placeholder semantics, and
  failed-send cumulative-token exclusion.
- Check ignored/replayed records remain ignored and no `totalTokens` or nested
  subset fallback was added.
- Confirm PHASE-01 leaves `readUsage`, `accrue`, `countFailedSend`, legacy
  accounting behavior, public `Status`, gate, policy, and server files unchanged.
- Assess whether tests exercise the material boundaries rather than implementation
  details, and inspect red/green plus full-suite/typecheck/build evidence.

Evidence includes the source/test diff and delegated read-only test/review runs.
Fixtures establish quotient arithmetic only; launched-pi normalization and
resumed-session behavior remain unverified under ASM-001. The repo's Doctrine
`check gate` is unavailable because its `justfile` has no `gate` recipe; direct
verification commands are reported separately.

## Synthesis

**Overall:** solid

**Synopsis:** PHASE-01 adds context peak/gap tracking at the existing reducer
classification seam. Cost accounting, cumulative token behavior, public status,
policy, and gate behavior remain unchanged. One minor test-coverage gap found in
review was repaired before phase completion. Focused context tests (6/6), reducer
tests (43/43), full suite (321/321), typecheck, and build passed. The project's
Doctrine gate could not run because `just gate` is absent. ASM-001's installed-pi
normalization and resumed-session claims remain unverified; fixture success does
not establish runtime parity.

**Haiku:**

One peak per request

Peak survives a context gap

Costs stay on their course
