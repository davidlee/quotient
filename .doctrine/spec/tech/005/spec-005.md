# SPEC-005: Config and profiles

<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

A component of the quotient server (SPEC-002), realising PRD-001's operator
authority over *who* a delegate is and *what the agent is told*. It owns three
things that share one idea of the operator's configuration location:

- **Locations** — one pure resolver from the environment to every path quotient
  reads or writes (`src/config.ts`).
- **Profiles** — the operator's named delegate definitions, read once at
  start-up into a frozen snapshot (`src/server/profiles.ts`). A profile is a
  markdown file: a header in an HTML comment carries its configuration, and
  everything after it is notes for humans that quotient does not read today
  (whether it should is IMP-012, Open items):

  ```
  <!-- quotient-profile
  filesystem: read
  model: provider/model-name
  thinking: low
  tools: read, grep, find, ls
  -->
  Notes for the operator: what this delegate is for.
  ```
- **The help corpus** — one sectioned source of guidance for the human
  (`quotient help`) and the model (the server's instructions and tool
  descriptions), with a per-section operator override (`src/help/help.ts`,
  `help/*.md`).

A **snapshot** is the set of documents loaded at start-up and held unchanged
for the server's life. **Start-up refused** means a check at start-up failed:
the server still runs, but refuses to start runs (see *Failed start-up is not
an exit*, below).

It does not own: the policy file's contents and the admission checks over a
profile (the capability pin, the root allowlist, tools narrowing) — SPEC-003;
serving help over MCP — SPEC-002; printing it on the command line — SPEC-006.

```
environment (XDG_*, HOME, QUOTIENT_*)
        │  resolveLocations (pure)
        ▼
 ┌──────────────────────────────────────────────────────────┐
 │ <xdgConfig>/quotient/  policy.json   → SPEC-003 (per call) │
 │                        approvals.json→ SPEC-003 (per call) │
 │                        profiles/     → profile snapshot ┐  │
 │                        help/         → help snapshot   ─┤  │ read once
 │ <xdgState>/quotient/   runs/, sessions/ → SPEC-002      │  │ at start-up
 └─────────────────────────────────────────────────────────┼──┘
   <launch dir>/.quotient/{profiles,help}  present → start-up refused
```

## Responsibilities

- Resolve every location from the environment by one pure function, so every
  reader agrees on where things are.
- Keep authority out of the project tree: nothing that decides a run is read
  from the directory the server was launched in, or from a run's root.
- Load, validate and freeze the profile snapshot at start-up.
- Define the profile document: its header grammar, its name grammar, and the
  capability it declares for the policy to pin.
- Load and freeze the help snapshot at start-up, resolving each overridable
  section from the operator's layer before the built-in.
- Render the help sections that depend on live state (the profile table, the
  per-run maxima, the client snippets) from inputs the caller supplies.
- Record a digest of each snapshot so every run names the profiles and help it
  ran under.

## Contracts

The normative text lives in shipped documents; this spec does not restate it.

- **Locations**: `docs/contract/quotient-policy-2.md`, "Where things are" — the
  environment variables, their XDG defaults, and the fall-through rule.
- **Profile document**: `help/profiles.md` (`quotient help profiles`) — the
  header grammar, field vocabulary, name grammar and the capability pin.
- **Help sections and overrides**: `help/setup.md`, "Overriding help" — which
  sections may be overridden and what each one is to a client.

Mechanism summary, for orientation:

- *Fall-through.* Only an **unset** `QUOTIENT_*` variable falls through to its
  XDG default. Set-but-empty or relative is unusable and refuses the call
  `policy-unavailable` (so a typo never moves the policy). A relative `XDG_*`
  value is ignored; `HOME` counts only when absolute. The approvals store has no
  variable. `QUOTIENT_LAUNCHER` is a hint for the client snippets, never a
  location, and never refuses.
- *One layer.* Profiles come from `<xdgConfig>/quotient/profiles/` and help
  from `<xdgConfig>/quotient/help/` only. The loaders take an ordered list of
  layers (highest wins per name) but production supplies exactly one.
- *Strict loads.* An absent layer is empty. An unreadable layer, or an invalid
  document in any layer — shadowed or not — fails start-up. A help override
  that cannot be read fails start-up the same way; so does an unreadable
  built-in (a broken package).
- *Failed start-up is not an exit.* A server whose start-up failed keeps
  serving: the run-starting tools refuse `profile-invalid` naming the path, and
  the tools over runs already on disk keep working from built-in help. (The
  shipped docs still say "fails start-up"; ISS-005.)
- *Contract sections are not overridable.* `result`, `handle`, `wait`, `ack`,
  `policy` and `form` print the shipped contract verbatim, so help can never
  misstate normative text. `agent` is the server's instructions; `tool`,
  `tool-start`, `tool-wait`, `tool-ack`, `tool-cancel` are the tools'
  descriptions.
- *Digests.* Each snapshot carries a sha256 over its winning sources' names,
  paths and bytes; both land on every run's `spawn` audit record. Audit-only.

## Concerns

- **Elevation through configuration.** A delegate that could edit a profile
  and have the next run use it would choose its successor's powers. Three
  guards close this: profiles are frozen at start-up (a restart is the
  operator's act); the document's declared capability must equal the policy's
  pin (SPEC-003 admission step 3); and the profile and help directories are
  protected stores no write delegate's view may include (SPEC-003 step 8).
- **The project tree is delegate-writable.** An earlier version read a
  launch-dir layer; that placed authority inside a tree a delegate may write.
  Its presence now fails start-up with migration advice rather than being
  silently ignored, so an operator learns what stopped working.
- **Misdirected configuration.** Fail-closed location rules (unusable means
  refuse, not default) keep a mistyped variable from quietly selecting another
  policy.
- **Help drifting from contracts.** Contract sections are served from the
  shipped contract, and drift tests hold those contracts to the code.
- **Name as path.** A caller's `profile` string is a snapshot key, never joined
  into a path.

## Hypotheses

- One XDG layer is enough: operators who want per-project delegates express
  that as differently named profiles plus policy, not as a project layer.
- Freezing at start-up is acceptable friction: profile and help edits are rare
  next to calls, and a client restart is cheap.
- A line-oriented header in an HTML comment is strict enough to parse without a
  YAML or markdown dependency, and invisible when the document is rendered.

## Decisions

- Profiles and help come from the XDG config layer only; a legacy launch-dir
  layer fails start-up rather than being read or ignored.
- The profile header is closed-world: an unknown key, a duplicate key, an
  empty value or a missing required field invalidates the document, and with it
  start-up. New fields are added by extending the grammar, never by tolerating
  unknown ones.
- `model` may not carry pi's `:<level>` thinking shorthand; thinking is its
  own field, so the level is visible and validated.
- The file's base name is the profile's name (`^[a-z][a-z0-9-]{0,31}$`).
- Help is one corpus for human and model; the model's copy is not a separate
  text that could drift.

## Open items

- **The profile body's role (backlog IMP-012).** Today, retrospectively: the
  loader parses only the header, and nothing after it reaches the delegate —
  the caller's prompt is the delegate's only instruction from quotient, and the
  shipped help and examples say so. That is current behaviour, **not durable
  intent.** Whether the body (whole, or a marked section) becomes standing
  instructions to the delegate is open, along with: whether operator notes stay
  private, whether the calling agent sees each profile's standing instructions
  in the server's instructions, and whether instructions are re-sent or fixed
  when a session continues. Constraint on any answer: the instructions must
  stay operator-authored, so they come only from the frozen snapshot. The
  header grammar admits a new field or a body delimiter without breaking
  existing documents.
- **Help sections as a referenced surface (backlog IMP-013).** If refusals
  name the help section that resolves them, section names become a contract a
  refusal points into; renaming or removing a section would then need the same
  care as a refusal reason. Drift tests would keep named sections real.
