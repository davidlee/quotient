gate: test typecheck build hostile-audit pack-check

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
