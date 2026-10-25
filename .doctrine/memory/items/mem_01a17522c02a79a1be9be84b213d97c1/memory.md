`src/drift.test.ts` ("no doctrine ids …") scans `docs`, `examples`, `help`, `README.md`, `flake.nix` and `nix/` and fails on any doctrine id (DEC-NNN, SL-NNN, RV-NNN, …). It runs in `just test`, so a comment like `(DEC-029)` in nix/check.sh turns the whole gate red.

Write the rationale in plain words in shipped files; cite ids only in `.doctrine/` artefacts, commit messages and phase sheets.

Also: when backgrounding a gate run, print the gate's own exit (`rc=$?; echo GATE_EXIT=$rc`) — a trailing `tail` makes the wrapper exit 0 regardless (SL-003 PHASE-06, 2026-10-26).
