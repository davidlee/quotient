## Decision

Each `protect` mask line in the generated launcher tests that an existing path is a directory. If the path exists and is not a directory, the launcher exits non-zero before bwrap, with a message naming the path and saying `protect` takes directories. The default state-dir line is unchanged. Docs state that `protect` takes directories.

## Context

SL-003 PHASE-03 review: `--tmpfs` cannot mask a file, so a file in `protect` made every launch fail with bwrap's `Destination is not a directory`. Nix cannot know at build time whether a host path is a file. Skipping files (`[ -d ]` guard) would leave them exposed silently.

## Alternatives

- Document only: leaves the cryptic bwrap error.
- Mask files with `--ro-bind /dev/null`: widens the mask's mechanism beyond sec-2's tmpfs.

## Basis

Operator, in session 2026-10-25: "agreed" to failing at launch with a clear message plus docs. Amends SL-003 design sec-2's mask paragraph (the mask line shape).
