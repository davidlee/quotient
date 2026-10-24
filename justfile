gate: test typecheck build hostile-audit pack-check

# Not yet in `gate` (IMP-002): typescript-eslint strict, zero warnings, and shellcheck.
lint:
    npx eslint . --max-warnings 0
    shellcheck scripts/*

typecheck:
    npx tsc --noEmit

test:
    npm test

build:
    npm run build

hostile-audit:
    bash -n scripts/hostile-audit

pack-check:
    npm pack --dry-run
    scripts/pack-check
