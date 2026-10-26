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

## Synthesis

**What was examined.** SL-003 as landed on main: the builder
(`nix/form-family.nix`), the text check (`nix/check.sh`, `nix/check-family.nix`),
the test flake and fixture corpus (`nix/checks/`), `scripts/form-probe`, and the
shipped docs (`docs/nix-forms.md`, `docs/contract/quotient-policy-2.md`). Lines
of attack per the Brief: conformance, the gate, design text against
DEC-023..037, two independent adversarial rounds (Codex gpt-6.1-sol at 564e081
and 701c96d) plus the responder's own probes, the harvest's open items, VH-1 and
VA-1.

**Closure story.** Round 1 (F-1..F-17) found the design text stale against
DEC-023..028, two false docs claims (F-2, F-17), and a check that read the
bwrap line by stripping quotes, which let an empty argument hide a
`QUOTIENT_` name (F-7, the blocker) and misread multi-word values and
apostrophes. The operator chose to fix inside the slice (option A, DEC-029..037);
PHASE-06..08 landed the fixes, with the check now reading the line through
bash's own parser with every expansion inert (DEC-029). Round 2 (F-18..F-25)
attacked that parser and the path rules: unquoted `$`, globs and braces that
bash expands at launch (F-18, F-20); `..` and tab handling in (j) and (g)
(F-19, F-21); raw-prefix piFiles admission (F-22); descriptor binds outside the
rw accounting (F-23); a falsely refused single-quoted backtick (F-24); a
multi-line env value refused with a misleading reason (F-25, operator chose
evaluation refusal, DEC-036 amended). While weighing F-24's planned fix the
responder found F-26: inside double quotes, `$(…)`, `${…:-…}` and a backtick
open quoting contexts the inert parse cannot follow, so a nested quote hid a
live bind from every rule. The planned F-24 fix would have widened that hole;
the landed fix refuses those contexts instead (DEC-029 Amendment 2). Round 3
(Codex, F-27..F-34, at d7ba2be) found three runtime-reproduced mount gaps — a
quoted `~` compared equal to the home (F-27), a relative target `tmp` that bwrap
mounts at `/tmp` (F-30), and a bind through an earlier `--symlink` onto `/tmp`
(F-31) — and three builder/checker input mismatches: `` \` `` in a single-quoted
value (F-32, tolerated: DEC-029's accepted cost), a newline in a piFiles key
(F-33) and a carriage return in an env value (F-34). F-27/F-30/F-31 are refused
under (c) (DEC-029 Amendment 3); F-33/F-34 are refused at evaluation (DEC-036
Amendment 2).

**Evidence.** Fixture corpus 112/112 (`check-fixtures`), every new case red
before its fix; the responder's word-for-word probe of `shell_words` against
bash's own `eval` over the round-2 desync lines (all refused) and the builder's
own expansions (all read as before); full gate at the round-2 fix commit
af01198 (log: `.doctrine/state/host/rv011-r2-gate.log`, `GATE_EXIT=0`). The
follow-up 443f5f5 changed only residue and docs text; it ran the fixture corpus
(112/112) and `npm test` (428 pass, the docs drift test included), not the full
gate.

**Round-3 evidence.** Fixtures 122/122 (every new refusal case red before its
fix), `nix flake check` of the test flake, `npm test` 428 pass, full gate at
the round-3 fix commit 1347f3b (log: `.doctrine/state/host/rv011-r3-gate.log`,
`GATE_EXIT=0`). Fixes
implemented by a worker agent under the responder's dispositions; the responder
reviewed the diff and narrowed the `~` rule to word starts so builder output
holding a later `~` (`exposure = [ ".../backup~" ]`) still passes.

**Standing risks and accepted tradeoffs.**
- The check is a text check (design sec-5 Risks). Its parser is bash with
  expansions inert, and every construct whose quoting it cannot follow is now
  refused rather than read; the cost is over-refusal of escaped operators,
  `$(`/`$[` anywhere, and parameter expansions beyond a name or plain default.
  The builder emits none of these.
- A double-quoted `$name` or `${name}` is still read as a symbol, not resolved:
  a mount through a variable is a printed residue, the caller's responsibility.
- x86_64-linux is the only verified platform (F-6, tolerated).
- PHASE-02/03 VT-1 mandates point at the wrong file (F-16); the behaviour is
  verified by the probe rows.
- Three adversarial rounds each found parser or path gaps; no fourth round ran
  over the round-3 fixes. The parser and the path rules remain the surface most
  likely to hold a further gap.
- A single-quoted `$name` mount path would read as a symbol, but the builder
  cannot emit one: writeShellApplication's shellcheck fails the build on it
  (SC2016). A bind source under a jail `--symlink` is refused although sources
  resolve on the host (conservative over-refusal).
- Host symlinks inside a bound tree can redirect a mount at launch; the text
  check cannot see them (a runtime residue, like every behaviour claim).

**For the human.** Route: `mkFormFamily` emits a form wrapper and a jail.nix
launcher; `checkFormFamily` runs `check.sh` over their text; `shell_words`
turns the bwrap line into argv via `eval "set -- …"` with every special
character swapped for an inert byte, and a second parse with operators widened
to spaces catches anything unquoted. Every rule (a)–(j) reads that argv. Tests
that bear on it: `nix/checks/fixtures/cases.sh` (the "line-*" and "alias-*"
cases), `eval-refusals`, and `scripts/form-probe` for runtime behaviour.
Sources: `doctrine show DEC-029` (the parser and its three amendments — why bash is
the parser and what it refuses), `doctrine show DEC-031` (the alias rule (j)),
`doctrine show DEC-036` (what the builder refuses at evaluation).

## Reconciliation Brief

### Per-slice (direct edit)

- design.md sec-2 (F-1, F-4, F-12, F-25): fold in DEC-023 (protect paths must be
  directories; the guarded mask line), DEC-024 (secretEnv needs a `$`),
  DEC-032 (piFiles binds in the deferred tail after the mask), DEC-033 with its
  Amendment (path, derivation, or store-context string), DEC-034 (no `HOME`,
  no `QUOTIENT_*` in env/secretEnv), DEC-035 (no `add-cleanup`), DEC-036 with
  its Amendments (no `$` in env values or protect paths; no control character
  other than tab in env values, host paths or piFiles keys — F-25, F-33, F-34). The Interface return set gains `protect`.
- design.md sec-3 "Reading a launcher" (F-1, F-7..F-10, F-18..F-24, F-26, F-27, F-30, F-31):
  replace the normalisation steps with DEC-029 and its three amendments (bash as the
  parser, inert bytes, the split parse, the refused constructs); normalisation
  (DEC-025) survives only for the builder's fixed line shapes. `bind_words`
  covers `--dev-bind`, `--overlay` and the descriptor binds (DEC-026, DEC-030,
  F-23). Paths are compared as the kernel resolves them lexically; a mount
  path that climbs above its anchor, is relative, or lies under an earlier
  `--symlink` destination is refused under (c) (F-21, F-30, F-31); a word that
  opens with a `~` bash does not expand is refused (F-27); piFiles binds
  are admitted only when both operands resolve under the store and
  `~/.pi/agent/` (F-22).
- design.md sec-3 Interface table (F-1): add `PROTECT` (DEC-027).
- design.md sec-3 Assertions (F-1, F-21, F-23): add (j) (DEC-031: no mount shows
  protected state at another path; a climbing path or a descriptor source
  overlaps everything); (g) counts overlay upper/work dirs (DEC-030) and a
  `--bind-fd` source as a descriptor no exposure path names (F-23); (c) gains
  the climb refusal and the plain-words refusal.
- design.md sec-3 Residues (F-3, F-26): replace the list with what `check.sh`
  prints — runtime binds via `--args` or `RUNTIME_ARGS`; mounts whose source or
  target is a variable expanded at launch; protected state reached through a
  literal path into the real home; runtime behaviour (host symlinks inside
  bound trees included, F-31). Drop the multi-word and
  command-substitution residues (both now read or refused).
- design.md sec-3 Negative controls (F-1): the `env.QUOTIENT_DEBUG` row is now
  made by doctor (the builder refuses that name, DEC-034); note the
  `check-fixtures` corpus (DEC-028) as the primary verdict suite beside the
  controls.
- design.md sec-5 "The test flake" (F-1): list `check-fixtures`,
  `eval-refusals` and the `example-*` checks (DEC-037), and the sample families.
- design.md sec-5 Risks (F-6): add "x86_64-linux is the only verified platform;
  the builder accepts any Linux". Update "Unchecked caller binds" to match the
  new residue list (F-26).
- notes.md (F-16): PHASE-02/03 VT-1's `test_file` should have been
  `nix/checks/flake.nix`; their `verify-vt` FAILs are known mis-targeted
  mandates, evidenced by form-probe's `canary-proc1` / `secret-cmdline` rows.
- docs/contract/quotient-policy-2.md:188-190 (F-17): step 8 compares the child's
  view, not only its writable view — the read root at read-only exposure is
  compared too, and an unreachable store (run evidence, attempts ledger,
  session home) is refused at any exposure (src/server/childview.ts:89-95,
  :184-186). A shipped-docs edit owned by this slice.

### Governance/spec (REV)

- None. SL-003 descends from no spec requirement whose text these findings
  contradict; every governing change is a per-slice DEC already amended in
  place (DEC-029, DEC-033, DEC-036).

## Reconciliation Outcome

### Direct edits applied
- design.md sec-2: `protect` in the returned family; piFiles moved into the deferred tail after the mask (DEC-032); guarded protect mask line (DEC-023); piFiles value types (DEC-033 + Amendment); `HOME` reserved (DEC-034); secretEnv `$` rule (DEC-024); new "Refusals at evaluation" table (DEC-024, 033, 034, 035, 036 + Amendments 1–2) (F-1, F-4, F-11, F-12, F-25, F-33, F-34)
- design.md sec-3: `PROTECT` input (DEC-027); "Reading a launcher" rewritten to bash-as-parser (DEC-029 + Amendments 1–3), mount operations incl. `--dev-bind`, overlays, descriptor binds (DEC-026, DEC-030), lexical path resolution and the relative / climbing / under-symlink refusals, piFiles admission; Assertions (c), (e), (g), (i) updated and (j) added (DEC-031); tail order includes piFiles; Residues match `residues()` in check.sh; negative controls note `check-fixtures` (DEC-028) and the doctor-made QUOTIENT_DEBUG control (F-1, F-3, F-7..F-10, F-18..F-24, F-26, F-27, F-30, F-31)
- design.md sec-5: test flake lists check-fixtures, eval-refusals, example-* (DEC-037) and the sample families; probe table gains `pi-files-defer`; Risks gain x86_64-linux-only and the new residue list (F-1, F-6, F-26)
- notes.md: Learned line on the mis-targeted PHASE-02/03 VT-1 mandates (F-16)
- docs/contract/quotient-policy-2.md: step 8 compares the child's whole view, read root included; an unreachable store refuses at any exposure (lines 183, 188–190, 202; F-17). Lines 183 and 202 are adjacent instances of the same error, applied with operator agreement. `npm test` 428/428 pass.

### REVs completed
- None: the brief lists no governance/spec items.

### Withdrawn / tolerated
- As dispositioned in the ledger; no further writes.

Operator agreed in session 2026-10-26 ("agreed"). Reconcile pass complete — handoff to /close.
