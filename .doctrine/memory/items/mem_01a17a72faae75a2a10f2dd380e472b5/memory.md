The rig's policy `roots` is `[rig.root]`, and a call with `cwd: rig.root` is admitted with exactly that root.
A test that then replaces the admitted root with a symlink (to test re-resolution, e.g. readmit's
`root-missing`) also changes what the roots entry canonicalises to: `resolveRoot` realpaths both, so the
moved target is still "allowlisted" and an allowlist-order bug cannot show. Found in SL-004 PHASE-08 (Codex F4):
the first version of "root now a symlink to a directory outside the roots" passed before the fix.

How to apply: create a subdirectory under the roots entry, admit with `cwd` set to it, and replace that
subdirectory with the symlink. Then the roots entry stays put and the symlink target is genuinely outside.
