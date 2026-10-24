# IMP-007: Gate builds the Nix server package

v0.3.0 shipped broken on Nix (operator, 2026-10-24). `just gate` has no Nix
target, and SL-003's `forms-check` / `forms-probe` (DEC-022) build sample form
families, not the server package, so they would not catch that break.

Add a `nix-build` recipe (`nix build .#default --no-link`) to `gate`. On
2026-10-24 `nix build .#default` succeeded on main (quotient-0.3.1).

Accepted into SL-003 by the operator, 2026-10-24 ("yeah let's do this too");
delivered with its justfile gate changes.
