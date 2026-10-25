# Review RV-011 — reconciliation of SL-003

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Mode: conformance. Surface: main checkout at 564e081 (slice driven in worktree
`.worktrees/sl-003`, fast-forwarded to main per phase; not a dispatch candidate).

Invariants held: design.md sec-2 (builder argument order, invariants, form-1
G1–G10 mapping), sec-3 (check assertions (a)–(i), 14 negative controls), sec-4
(docs rows), sec-5 (code-impact commitments, verification alignment, risks), as
amended by DEC-023..DEC-028.

Lines of attack:
1. `doctrine slice conformance 3`: undeclared / undelivered paths.
2. `doctrine check gate` on main (test, typecheck, build, nix-build, forms-probe,
   forms-check, hostile-audit, pack-check).
3. Design text vs DEC-023..028: what reconcile must fold in.
4. The check.sh fix rounds (Codex rounds 2, 4–6) that were never re-reviewed:
   an independent adversarial pass (Codex, gpt-6.1-sol) over builder + check.
5. Open items carried by notes `## Harvest`: QUE-001 (F-28), DEC-020 canary
   evidence, DEC-017 residues, N1 residue, x86_64-only, the persisted-home claim.
6. VH-1 (hostile-audit, real pi, read + write) and the VA-1 docs checklist.
