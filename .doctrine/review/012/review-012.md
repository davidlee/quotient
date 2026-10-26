# Review RV-012 — code-review of SL-003

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Scope: commit 1347f3b (RV-011 round-3 fixes F-27, F-30, F-31, F-33, F-34),
and how it interacts with `shell_words`, `parsed_words`, `canonical_target`,
`climbs`, `unreadable_mounts`, `spelled_path`, `protected_aliases` in
`nix/check.sh` and the refusals in `nix/form-family.nix`. Post-close review,
pre-release (0.4.0 not yet tagged). Reviewer: Opus subagent.

Invariants (design sec-1/sec-3, DEC-029 Amendments 1–3, DEC-031, DEC-036):
- the check never reads a bwrap line otherwise than bash would at launch;
  a line it cannot read exactly is refused, never read approximately;
- G5: every host path the jail can write is in EXPOSURE ((g));
- G6: protected state (default state dir in any spelling, PROTECT paths) is
  masked and never mounted elsewhere ((i), (j));
- /tmp mounted exactly once, as base's --tmpfs /tmp ((d)); the tail order holds ((c));
- whatever the builder emits, the check reads (no false refusal of builder text).

Lines of attack:
1. False acceptance (primary): a launcher violating G5/G6/(d)/(c) that passes —
   tilde third parse vs first parse agreement; relative/symbol-anchored paths;
   `--symlink` destination tracking (order, canonical form, chains, symlink
   targets that are themselves relative/climbing); `..` against a symbol anchor.
2. False refusal (secondary): builder-emitted text (jail.nix quoting, `~` in
   words, tab, store paths) that 1347f3b now refuses.
3. Builder/checker agreement on control characters (DEC-036 Amendment 2).
4. Maintainability of the round-3 additions: duplication, naming, comments.

Stopping rule (operator): minor / false-refusal only → record, tag 0.4.0;
major false acceptance → fix before tagging.

## Synthesis

**Overall:** acceptable — after fixes.

**Synopsis.** A targeted review of SL-003's round-3 fixes (1347f3b) before
tagging 0.4.0, by an Opus reviewer. The tilde third parse (F-27) held against
every spelling tried; the control-character work (F-33/F-34) was sound apart
from F-6. Path rules were not: F-1 (major, runtime-proven) defeated the
round-3 symlink rule through `link/..`, landing a host directory on the jail's
/tmp and exposing protected state unmasked; F-2..F-5 were a false refusal and
three contrived false acceptances in the same functions (two pre-existing).
All six were fixed under ISS-003 (operator: fix all, no slice). Verifying
those fixes, the reviewer found F-7 (a regression the F-4 fix introduced) and
F-8 (a gap F-3 left); both fixed and re-verified. Every fix has a fixture case
red before, green after (corpus 122 → 131).

**Standing risks.** Each adversarial round over these path rules has found
something, including the verification pass over this round's own fixes; the
F-7/F-8 fixes were verified by the same reviewer only. A single-quoted `'$x'`
path still reads as a variable to the check (the build's shellcheck refuses
it, not the check). Declared residues unchanged: runtime binds (`--args`,
`RUNTIME_ARGS`), launch-time variables, literal paths into the real home,
host symlinks.

**Tradeoffs accepted.** The F-1 rule refuses any `..` in a target once the
line carries a `--symlink`, broader than strictly needed; nothing the builder
or the pinned jail.nix emits reaches it. The F-8 rule also refuses `$1` and a
quoted lone `$`, which no checked line legitimately carries.

**Haiku**

A link, then two dots —
the kernel walks the long way;
the text took the short.
