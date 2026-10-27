```text
`SPEC-006` — CLI
cli · active · tech
tags: cli
category: cli
c4 level: component
descends from: PRD-001
parent: SPEC-002
responsibilities:
  - Dispatch argv to one verb, or serve MCP on stdio when argv is empty.
  - Hold one exit-code convention: 0 done, 1 refused or not completed, 2 malformed invocation.
  - Keep stdout for the verb's product (the protocol alone when serving) and stderr for diagnostics.
  - Route SIGTERM and SIGINT into the server's one shutdown path.
  - Make `quotient help` print what a healthy server started in the same place would serve.
sources:
  - typescript src/cli.ts
  - typescript src/reduce/cli.ts

```

# SPEC-006: CLI

<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

The `quotient` binary's verb surface: a component of the MCP server container
(SPEC-002), realising the operator- and tooling-facing parts of PRD-001. One
executable carries two roles. Bare, it serves MCP on stdio; with a verb, it
runs one short-lived operator command and exits.

```
quotient                 serve MCP on stdio          → SPEC-002
quotient reduce …        the reducer, stand-alone    → SPEC-002 (reducer semantics)
quotient help [SECTION]  list or print help          → SPEC-005 (content, override layer)
quotient allow …         report / record approvals   → SPEC-003 (approval semantics)
quotient revoke …        remove approvals            → SPEC-003
quotient --version       the package version
```

This spec owns only the shape of each verb: argv grammar, which stream
carries what, and exit codes. What a verb *means* is owned by the spec named
on its row; this spec cites it rather than restating it.

## Responsibilities

- Dispatch argv to exactly one verb, or to the server when argv is empty.
- Hold one exit-code convention across every verb.
- Keep stdout for the verb's product and stderr for diagnostics; when serving,
  stdout is the protocol channel alone.
- Translate process signals into the server's one shutdown path.
- Make `quotient help` print what a healthy server started in the same place
  would tell the calling agent.

## Contracts

### Exit codes

One convention across verbs:

| code | meaning |
|---|---|
| 0 | the verb did its job (for bare `quotient`: the server shut down) |
| 1 | the verb ran but could not do its job for a reason the operator can act on; or, for `reduce`, the reduced run did not complete |
| 2 | the invocation was malformed: an unknown verb, flag or section, or a bad argument shape for `reduce`, `allow` or `revoke`. Usage goes to stderr |

Two exceptions, both shipped behaviour:

- `reduce` also exits 2, without usage, when its input cannot be read or the
  reducer throws: it cannot tell a missing file from a mistyped one.
- `help` and `--version` ignore arguments after the ones they use, so
  `quotient --version extra` prints the version and exits 0.

### Verbs

| verb | purpose | exit codes | semantics owned by |
|---|---|---|---|
| *(none)* | serve MCP on stdio until stdin closes or a signal arrives | 0 after shutdown | SPEC-002 |
| `reduce [FILE] [--out DIR] [--budget-bytes N \| --full] [--alert RE]… [-v] [-q]` | reduce a pi `--mode json` stream (FILE or stdin) to `<out>/transcript.md` and `<out>/status.json`; one status line | 0 completed · 1 failed or incomplete · 2 usage, unreadable input, or reducer error | SPEC-002 |
| `help` | list the section names (with aliases) | 0 | SPEC-005 |
| `help SECTION` | print one section (name or alias) as the server would serve it | 0 printed · 1 help layer unreadable · 2 unknown section | SPEC-005 |
| `allow [PATH]` | report what the project's form links resolve to, and the command that would record them; never writes | 0 printed · 1 refused (policy unreadable, path outside every root, …) · 2 usage | SPEC-003 |
| `allow PATH CAP=REALPATH@SHA256…` | record the reviewed identities, all or none | 0 recorded · 1 refused (nothing written) · 2 usage | SPEC-003 |
| `revoke ROOT [CAP…]` | remove recorded approvals for one stored root | 0 removed · 1 nothing recorded there, or store failure · 2 usage | SPEC-003 |
| `--version` | print the package version | 0 | — |
| anything else | print the top-level usage | 2, stdout empty | — |

### Streams

- Bare `quotient`: stdout carries only MCP messages. When stdin is a TTY, one
  hint line on stderr says the binary speaks MCP and names `quotient help`.
- `reduce`: one status line on stdout (`-q` none; with `-v` the transcript goes
  to stdout and the status line to stderr). Alerts the caller declared with
  `--alert` go to stderr.
- `help`: the section on stdout. Conditions a server started here would refuse
  on — a legacy launch-dir layer, a profile snapshot that does not load — are
  warned about on stderr, naming the path, and the section still prints (exit
  0), so `quotient help profiles` can explain the fix while it is being made.
  An unreadable help layer is not warned about but fails (exit 1): there is no
  section to print.
- `allow` / `revoke`: their product on stdout (the report, or one `recorded …` /
  `revoked …` line); a failure or usage on stderr prefixed `quotient <verb>:`.
  Each verb has its own usage text, so a malformed `revoke` never reads like a
  malformed `allow`.

### Signals

SIGTERM and SIGINT each trigger the server's shutdown, the same path as stdin
EOF (SPEC-002). Each is handled once; a second delivery takes the default
action, the operator's way out of a stuck shutdown.

### Environment the verbs read

The verbs resolve locations through the same resolver as the server (SPEC-005):
`allow` reads the policy and the approvals store; `revoke` reads and updates
the approvals store only, independent of the policy and of whether the root
still exists; `help` reaches the help and profile layers and the policy. `help clients` names the binary by
`QUOTIENT_LAUNCHER` when it is an absolute path (a wrapper's own path), else by
the path the script was run as, not its symlink target.

## Concerns

- **Prompting.** No verb prompts. `allow` takes the digest on the command line
  as the operator's confirmation, so it is scriptable and an agent can relay
  the exact command for the operator to run.
- **What help says must match what the server says.** `help` reads the same
  layers a server launched in the same directory would, and renders the same
  per-install parts (profile table, maxima, client snippets). A divergence
  would teach the operator one thing and the calling agent another.
- **`--help` is not a verb.** `quotient --help` and `-h` fall to the
  unknown-verb branch: usage on stderr, exit 2. The usage names `quotient
  help`, so this is discoverable, but it reads as an error.
- **Side effects at import.** `src/cli.ts` is the one module with side effects
  at import; every verb's handler is importable and testable without them.

## Hypotheses

- Operators script `allow` (e.g. after rebuilding a form), so its output and
  exit codes are an interface, not just messages. The `recorded …` / `revoked
  …` lines are asserted verbatim by tests for that reason.
- A calling agent may run `quotient help <section>` through a shell as well as
  receive the same text from the server; section names are therefore part of
  the CLI's stable surface.

## Decisions

- **Bare means serve.** An MCP client launches the binary with no arguments;
  any verb is an operator act. There is no `serve` verb (`quotient serve` is
  unknown, exit 2).
- **Exit 2 means "you asked wrongly"**, so a script can tell it from "the
  system said no" (1). `reduce` is the exception: unreadable input and a
  reducer error also exit 2 (see Exit codes).
- **Signals join the EOF shutdown path** rather than a separate one, so a
  client's timeout cannot orphan a run's process group.
- **Verbs never prompt.** Approval is confirmed by the digest the operator
  passes, not by an interactive question.

## Open items

- **Section names are a public surface.** If refusals come to name the help
  section that resolves them (PRD-001 OQ-2), those names reach the calling
  agent as `quotient help <section>` and must stay stable; renaming a section
  then needs an alias. The `refusals` → `result` alias already exists.
- **An operator view of runs** — e.g. `quotient runs` or `quotient tail <id>`
  over the evidence directory — is an unbuilt candidate for in-flight
  observability aimed at a human (PRD-001 OQ-3). It is not a commitment. If it
  is built, it is a new verb under this spec's exit-code and stream
  conventions; run semantics remain SPEC-002's.

## Requirements

### FR-001 (REQ-047) — Bare quotient serves MCP on stdio

bare-quotient-serves-mcp-on-stdio · functional · pending

Run with no arguments, the binary serves MCP on stdio until shutdown and exits 0; stdout carries only protocol messages, and a TTY on stdin draws one hint line on stderr naming `quotient help`.

acceptance criteria:
  - `quotient` with no arguments serves MCP over stdin/stdout and exits 0 after stdin closes.
  - Nothing but MCP messages is written to stdout while serving.
  - When stdin is a TTY, one line on stderr says the binary speaks MCP and names `quotient help`.

### NF-001 (REQ-048) — One exit-code convention across verbs

one-exit-code-convention-across-verbs · quality · pending

Every verb exits 0 when it did its job, 1 when it ran but could not (or, for reduce, the run did not complete), and 2 for a malformed invocation with usage on stderr; an unknown verb exits 2 with empty stdout. reduce also exits 2, without usage, for unreadable input or a reducer error; help and --version ignore trailing arguments.

acceptance criteria:
  - An unknown verb (including `serve` and `-x`) prints the top-level usage on stderr, nothing on stdout, and exits 2.
  - `allow` and `revoke` usage errors exit 2 with that verb's own usage; refusals exit 1 naming why.
  - `reduce` exits 0 for a completed stream, 1 for a failed or incomplete one, 2 for bad flags or unreadable input.
  - `help` exits 2 for an unknown section and 1 for an unreadable help layer.

### FR-002 (REQ-049) — help prints what the server would serve

help-prints-what-the-server-would-serve · functional · pending

`quotient help` lists section names with their aliases; `quotient help SECTION` prints that section as a server started in the same directory would serve it after a healthy start-up, warning on stderr, without failing, about conditions such a server would refuse on.

acceptance criteria:
  - `quotient help` lists every section, marking aliases (`refusals` for `result`).
  - A contract section prints byte-for-byte the shipped contract; an alias prints its target.
  - With a legacy launch-dir layer or a profile snapshot that does not load, the section still prints (exit 0) and stderr names the offending path.

### FR-003 (REQ-050) — help clients renders this install's client snippets

help-clients-renders-this-installs-client-snippets · functional · pending

`quotient help clients` prints Claude Code and Codex configuration naming this binary (by `QUOTIENT_LAUNCHER` when absolute, else by the path it was run as), the launch dir, and a Codex tool timeout derived from the policy's wall-clock maximum.

acceptance criteria:
  - Both snippets name the binary by the path it was invoked as, not its symlink target.
  - An absolute `QUOTIENT_LAUNCHER` replaces that path; a relative one is ignored.
  - The Codex timeout is the policy's `maxima.wall_clock_s` plus 60 when the policy reads, and a marked placeholder otherwise.

### FR-004 (REQ-051) — allow and revoke are scriptable operator verbs

allow-and-revoke-are-scriptable-operator-verbs · functional · pending

`allow` reports without writing or records the exact identities given, and `revoke` removes approvals for one stored root; neither prompts, each prints a fixed one-line confirmation per change on stdout, and failures go to stderr prefixed with the verb.

acceptance criteria:
  - `quotient allow` with no identities never writes the approvals store and prints the command that would record what it shows.
  - A successful record prints `recorded <cap>=<realpath>@<sha256> for <root>` per identity; a successful revoke prints `revoked <caps> for <root>`.
  - No verb reads from the terminal.

### FR-005 (REQ-052) — Signals shut the server down through the EOF path

signals-shut-the-server-down-through-the-eof-path · functional · pending

While serving, the first SIGTERM or SIGINT triggers the same shutdown as stdin EOF; a second delivery of the same signal takes the default action.

acceptance criteria:
  - SIGTERM to a serving process ends every running run with the shutdown cause and the process exits 0.
  - A second SIGTERM or SIGINT during shutdown terminates the process by the default action.

### FR-006 (REQ-053) — reduce runs the reducer on a file or stdin

reduce-runs-the-reducer-on-a-file-or-stdin · functional · pending

`quotient reduce` reads a pi `--mode json` stream from FILE or stdin, writes transcript.md and status.json to the output directory (default: the file's directory, or the working directory for stdin), and prints one status line unless quiet.

acceptance criteria:
  - `quotient reduce FILE` writes transcript.md and status.json beside FILE and prints one status line on stdout.
  - `-v` sends the transcript to stdout and the status line to stderr; `-q` prints no status line.
  - Each declared `--alert` match is printed on stderr.

### FR-007 (REQ-070) — --version prints the package version

version-prints-the-package-version · functional · pending

`quotient --version` prints the installed package's version followed by a newline and exits 0.

acceptance criteria:
  - `quotient --version` prints the package.json version and a newline, and exits 0.

## Interactions

- SPEC-003 — calls: allow/revoke operate the approvals store
- SPEC-005 — uses: help verb prints the help corpus
