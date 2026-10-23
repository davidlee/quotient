# Review RV-001 — design of SL-001

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Independent external review via quotient/pi, profile `review`, using read-only
read/grep/find/ls tools. Attack surfaces: request classification and replay,
independent context/cost validity, migration completeness, audit snapshots,
active contract semantics, packaging and installed-artifact verification.
The user's settled design decisions remain constraints.

Initial session: `9bcf77a5bf2e8b5d42a0501744d1c4f9`.
Focused recheck: `7db7f56784f3e8bcd30c25de31944ff2`.
The raw reports are retained in quotient's run evidence; convenient copies are
`/tmp/sl001-pi-design-review.md` and `/tmp/sl001-pi-design-recheck.md`.

## Synthesis

The pass found a real migration omission in the packaging and hostile-audit
scripts, ambiguity in the retained unmeasured-cost counter, and an unqualified
comparison of crossing-time versus final drained measurements. The design now
includes both scripts, exact counter populations and overlap rules, explicit
active-contract prose migration, prefix-scoped audit comparisons and a buffered
drain test. The stale totalTokens rationale is explicitly part of the gate edit.

The initial review overstated an automatic publication failure: pack-check is
an explicit release gate, not an npm publish hook. Its valid concern is that the
generated /1 policy will fail against the /2-only candidate until migrated.
Likewise, the result-prose and totalTokens points reinforce rules already in
the draft rather than establish contrary design decisions.

The focused external recheck accepted every design repair and introduced no
new findings. These verdicts concern the design, not implemented behavior.
No build, implementation test, installed-package check, real-form hostile probe
or live provider/session trace was run in this pass. ASM-001 preserves the
unverified launched-pi normalization and resumed-event assumptions. In
particular, acknowledging that assumption does not prove historical messages
are absent from a resumed runtime stream.

The installed-package gate must exercise the intended committed 0.2.0 tree,
since it clones HEAD. The hostile-audit script needs fixture migration, while
its real provider/form execution remains a separate evidence claim. The user
owns npm publication after audit and before reconciliation; the reminder stays
in the design and slice notes.
