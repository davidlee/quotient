# QUE-001: Should mkFormFamily accept a literal $ in an env value or protect path?

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->
## Context

From SL-003 PHASE-04 (finding F-28, Codex round 6). `nix/form-family.nix`
single-quotes a caller's `env` value and each `protect` path so that they reach
the launcher as literals. `writeShellApplication` runs shellcheck over the script
it writes, and a single-quoted `$` is SC2016, so a literal containing `$` fails
the derivation: the launcher is not built at all. It fails closed, but it is a
limitation the user meets as an opaque shellcheck error.

## Options

- Accept and document it: say in docs/nix-forms.md that `env` values and
  `protect` paths cannot contain `$`, and refuse it at evaluation with a clear
  message (as secretEnv's literal check does).
- Lift it: disable SC2016 for the emitted lines, or emit literals by another
  quoting route. That restores the `dollar` sample family as the test for P3
  ("a caller's text is a literal").

Owner: the operator. Docs say nothing about it yet.
