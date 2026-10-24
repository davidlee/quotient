# Review RV-006 — design of SL-002

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Codex second adversarial design review of SL-002, sec-1 through sec-4, against
accepted DEC-007 through DEC-011, the first-review disposition table, the slice,
the verified research rows, the authoritative contracts, and the affected source.
Full-depth review: delegate-controlled selection and fallback, root aliases and
nested roots, approval identity and writer concurrency, admission-to-exec races,
refusal precedence, legacy-layer migration, contract compatibility, and verification
coverage including the release scripts. Security scenarios inferred from the draft
are distinguished from current-source facts and executed probes in each finding.

The four sec-4 gap-fills are acceptable: an unconfined slot cannot accept a project
executable; an unreadable/malformed store cannot establish whether defaults are
permitted; project-only hashes accurately describe the new approval check; and a
versioned approvals schema supports closed-world parsing. Wrapper-unavailable
continues to precede store/probe failures. Staying on policy/2 is treated as the
accepted DEC-011 constraint, not reopened as a versioning preference.

The review label was set to codex in the existing ledger's authored metadata:
`doctrine review --help` exposes no edit/relabel verb, and
`lib:reference/using-doctrine.md` permits hand-editing fields no verb owns.

## Synthesis

**Overall:** acceptable.

**Synopsis:** All six findings have verified dispositions at design level.
The final F-6 correction separates revoke's exact stored approval key from
allow's current policy-root resolution, preserving revocability after root
removal or directory deletion and preventing accidental parent revocation.
Its regression obligations cover those cases and unknown targets. No new
finding arose from the F-6 revision. Earlier accepted relocation and
operator-owned host-wide immutability limits remain as recorded on F-1/F-2;
this closure does not certify implementation or runtime behavior.
The amended decisions, design and ledger already hold the durable outcome;
this ledger-only pass creates no additional harvest records.

**Haiku:**
Stored roots keep their names
Gone paths still release their claims
Parent grants remain
