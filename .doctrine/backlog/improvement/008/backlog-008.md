# IMP-008: Seatbelt (macOS sandbox-exec) form backend

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Add an optional macOS form backend: a Nix builder that produces `form-1`
read/write forms confined by Seatbelt (`sandbox-exec` with a generated SBPL
profile), alongside the existing jail.nix/bubblewrap builder (IMP-003,
`nix/form-family.nix`). The executable form contract (`docs/contract/form-1.md`)
is already the portable abstraction; the server stays backend-agnostic and
unchanged.

## Direction (proposed, not settled)

- **Own a narrow backend; don't adapt agent-sandbox.nix.** Use
  [agent-sandbox.nix](https://github.com/archie-judd/agent-sandbox.nix) as
  reference only. Its interactive-developer defaults conflict with `form-1`:

  | form-1 requirement | agent-sandbox.nix behaviour (per the source analysis) |
  |---|---|
  | G2: root not writable under `read` | workspace writable by default; read-only overrides fiddly, incl. Git |
  | G5: no writes beyond root, session, private temp, `exposure` | grants writable Git metadata, possibly outside the root |
  | G6: evidence dir and sibling sessions inaccessible | no public equivalent of `protect` masks / explicit denies |
  | Quotient owns the process group and kill ladder (signals `-pid`) | darwin launcher calls `setsid()` (`launcher/lib/launch_config/darwin/compute.py`) — delegate leaves the group; a wrapper can't fix it |
  | immutable pi config at expected in-jail paths | no general source→destination mapping like `piFiles` |

  Revisit upstream only if we later want its domain proxy, browser
  accommodations or restricted store view — and then push for a headless API
  with explicit grants/denies and lifecycle control, not depend on its internal
  Python.
- **Builder shape.** Keep the jail.nix builder and its `options` untouched. Add
  an explicit `mkSeatbeltFormFamily` that shares inputs whose meaning agrees
  (packages, environment, secrets, exposure, protected paths). Keep
  platform-specific permissions explicit; don't pretend jail.nix combinators
  translate. Look for a shared core in `form-family.nix` before duplicating.
- **Smallest policy that satisfies form-1.** `form-1` permits broad reads
  outside protected stores, so start with: allow reads, deny protected stores
  (G6), deny writes by default, then grant exactly root (`write` only),
  session dir, private temp and `exposure`. Easier to reason about; less
  confidentiality than a restricted filesystem view.
- **Checks.** `checkFormFamily` inspects bubblewrap launcher syntax
  (`nix/check.sh`). Needs a Seatbelt counterpart (or backend-specific naming),
  plus runtime conformance probes for both backends (cf. `scripts/hostile-audit`).

## Needs real engineering

- **G7 (dies with parent).** No `--die-with-parent` equivalent; `sandbox-exec`
  alone doesn't give it. Needs a supervisor/kqueue `NOTE_EXIT` watch or similar,
  without leaving Quotient's process group.
- **G10 (confinement inputs immutable).** The SBPL profile must live in the
  executable's bytes or the Nix store, never a delegate-writable path; runtime
  parameters (root, session dir) must be passed via `-D` params, not by writing
  a profile file at run time.
- `sandbox-exec` is deprecated by Apple (still functional). Record as a risk at
  design time.

## Tests to cover

Abrupt server death; cancellation through the termination ladder; forked
children; protected-path aliases (symlinks, `/private/var` vs `/var`, firmlinks,
case-insensitivity); concurrent runs with sibling sessions.

## Provenance

Direction above is from a pasted external analysis (2026-10-26). Claims about
agent-sandbox.nix internals have not been verified in this repo. G-numbers
refer to `docs/contract/form-1.md`.
