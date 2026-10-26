# ISS-003: checkFormFamily path rules: symlink .., source links, $ anchors, braced defaults, HOME spellings

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

RV-012 (code review of SL-003's round-3 fixes, commit 1347f3b) found five
defects in `nix/check.sh`'s mount-path rules and one builder/checker mismatch.
Findings and reproductions: `doctrine review show RV-012 --full`.

- F-1 (major): `LINK/..` canonicalises past an earlier `--symlink`, so the
  F-31 rule is bypassed (runtime: a host dir lands at the jail's /tmp).
- F-2: the symlink rule wrongly applies to bind sources (resolved on the host).
- F-3: `'$'*` admits `"$"/x` and `"$$"/x` as variable anchors.
- F-4: a braced default's anchor splits inside the braces, hiding a climb.
- F-5: (j) misses `${HOME:-…}` as a spelling of the home.
- F-6: the builder refuses DEL, which the check reads; env names unchecked.

Operator, 2026-10-26: fix all six; work directly off this item (no slice).
Fix before tagging 0.4.0. Each fix gets a fixture case, red before green.
