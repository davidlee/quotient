The release shape (0.6.1 `1f18594`, 0.7.0 `82bd608`):

1. `just gate` green on the commit being released.
2. `npm version X --no-git-tag-version` bumps `package.json` and `package-lock.json`.
3. `flake.nix` carries no version string, but its `npmDepsHash` covers the lockfile, so the bump changes it. Recompute: `nix run nixpkgs#prefetch-npm-deps -- package-lock.json`, then replace the hash in `flake.nix`.
4. `just nix-build` (stage the files first: flakes read the git index). `nix build --no-link`, so check the store path's `bin/quotient --version`, not `./result` (a stale link).
5. Commit `Release X` with a body summarising interface changes; then `just pack-check` (it clones HEAD, so it must run after the commit) and confirm it installs `quotient X`.
6. `git tag -a vX -m "Release X"`. Confirm version, tag and any push with the user.
