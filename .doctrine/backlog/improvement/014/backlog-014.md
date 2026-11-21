# IMP-014: form-probe: a prebuilt-family mode, to run unmodified where there is no nix

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

`scripts/form-probe` builds the probe family with `nix build` and reads the refusal table with `nix eval`, so it skips (exit 77) where nix is absent. A jail has no nix, so it cannot run there unmodified.

flakes:SL-024 proved the nested form family with a `nix` stand-in on PATH that replays the host's build and eval answers (flakes:DEC-127). A real `jailed-shell` run exited 0 with the same rows as the host: 26 top-level, 73 in all, 0 FAIL. The behavioural rows ran in the jail; the eval-refusal rows are replayed. The fixture is not kept in a form anyone can rerun simply.

## Proposal

A mode that takes a family already built, for example the probe family's output paths and the refusal table as inputs, and runs the behavioural rows with no `nix` on PATH. The evaluation rows either come from that input or report as not run, never as passed.

## Not settled

- How a prebuilt family's closure reaches the jail; SL-024 bound its closure from a file by a scratch `add-runtime` line.
- Whether the probe family should carry flakes:DEC-125's `/etc` store binds. Without them this probe does not cover a nested form's TLS; hostile-audit and a direct probe did that in SL-024.
