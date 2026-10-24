gate: test typecheck build nix-build forms-probe forms-check hostile-audit pack-check

# Not yet in `gate` (IMP-002): typescript-eslint strict, zero warnings, and shellcheck.
lint:
    npx eslint . --max-warnings 0
    shellcheck scripts/* nix/check.sh

typecheck:
    npx tsc --noEmit

test:
    npm test

build:
    npm run build

nix-build:
    nix build .#default --no-link -L

# 77 (no Nix, no bwrap, no user namespaces) fails the gate too: it requires them.
forms-probe:
    scripts/form-probe

# Text-only conformance: both sample families and one negative control per
# refusal, over the working tree's lib. Nothing is launched.
forms-check:
    nix flake check -L ./nix/checks --override-input quotient path:$PWD

hostile-audit:
    bash -n scripts/hostile-audit

pack-check:
    npm pack --dry-run
    scripts/pack-check
