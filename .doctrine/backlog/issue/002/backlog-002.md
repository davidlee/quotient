# ISS-002: hostile-audit's ambient QUOTIENT_* guard fails open under a bash without compgen

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->
## Evidence

Observed 2026-10-26 during SL-003 PHASE-05 VH-1 (both runs, read and write):

    scripts/hostile-audit: line 64: compgen: command not found

`scripts/hostile-audit:64` is
`ambient=$(compgen -e | grep -E '^QUOTIENT_' | sort || true)`. Nixpkgs' plain
`bash` is built without programmable completion, so `compgen` does not exist;
the `|| true` swallows the failure and `ambient` is always empty. The guard that
refuses (SKIP 77) on an ambient `QUOTIENT_*` variable never fires: it fails open.

## Fix

Enumerate the environment without a completion builtin, e.g.
`env | cut -d= -f1 | grep -E '^QUOTIENT_'` (or `printenv`), and add a test
that sets `QUOTIENT_X` and expects exit 77.
