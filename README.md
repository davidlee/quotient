# quotient - pi.dev subagents for claude and codex

A stdio MCP server with one tool, `pi_agent`, which delegates a bounded piece of
work to [pi](https://github.com/earendil-works/pi), harness of kings.

![quotient](./quotient.jpg)

Essentially, use Pi subagents under Claude / Codex.

You might want to do this for many reasons. Deepseek V4.1 Flash is a pretty good one.

A broker like [LiteLLM](https://www.litellm.ai/) is recommended for credential
management of pi models, but not required.

Each call runs one pi process in a directory you allowlisted, under limits you
set, confined by a *form*: an executable you choose that decides what the
delegate can read and write. Each profile has a *capability*, `read` or
`write`, and the policy names one form per capability. The call answers with
a transcript reduced to its essentials, a status (request-context peak, usage,
cost, counts) and a
verdict: whether the run succeeded, and if not, why. Use it to hand recon,
review or small edits to a cheaper model without handing it your machine.

For a tour of confinement strategies, see [More Convenient Straitjackets](https://doctrine.engineering/articles/more-convenient-straitjackets/)

## Install

quotient needs Node 22 or later, and `pi` installed where your forms can run it.
pi is a prerequisite, not a dependency.

```sh
npm install -g @davlee/quotient
# or
nix profile install github:davidlee/quotient
```

`quotient --version` confirms the install. `quotient help` lists the built-in
help sections; `quotient help <section>` prints one.

## Configure

quotient refuses every call until it has a policy. Three things to put in
place, all under `~/.config/quotient/` by default:

```
~/.config/quotient/
├── policy.json          the policy: roots, limits, profiles, forms (read on every call)
├── approvals.json       forms approved by hand with `quotient allow` (read on every call)
└── profiles/            one file per profile: model, thinking, tools (read at start-up)
    ├── read.md
    ├── research.md
    ├── write.md
    ├── review.md
    ├── judgement.md
    └── implement.md

~/.local/state/quotient/
├── runs/                evidence for each call (the result's artifacts.dir)
└── sessions/            pi sessions, so a call can be continued
```

`QUOTIENT_POLICY`, `QUOTIENT_RUN_DIR` and `QUOTIENT_SESSION_HOME` move these;
`XDG_CONFIG_HOME` and `XDG_STATE_HOME` are honoured. Profiles and help come
from `~/.config/quotient/` alone, read once at start-up; the policy and the
approvals store are read on every call. Nothing is read from a project: a
server that finds an earlier version's `<launch dir>/.quotient/profiles/` or
`/help/` fails start-up, telling a directory to move its documents into the XDG
directory and an entry that is not a directory to remove or replace it.

Installation ships example profiles but does not copy them into user
configuration. Start from the examples in the package:

```sh
examples="$(npm root -g)/@davlee/quotient/examples"
# nix: examples=~/.nix-profile/lib/node_modules/@davlee/quotient/examples
mkdir -p ~/.config/quotient/profiles
install -m 0444 "$examples/policy.json" ~/.config/quotient/policy.json
cp "$examples"/profiles/*.md ~/.config/quotient/profiles/
```

The policy is meant to be read-only (`0444`): edit a copy and reinstall it.

### The policy

```json
{
  "schema": "quotient-policy/2",
  "mode": "per-call",
  "enabled": true,
  "roots": ["/home/operator/work"],
  "maxima": {
    "requests": 20,
    "context_tokens": 180000,
    "cost_usd": 1,
    "wall_clock_s": 600
  },
  "profiles": {
    "read": "read",
    "research": "read",
    "write": "write",
    "review": "read",
    "judgement": "read",
    "implement": "write"
  },
  "forms": {
    "read": "/home/operator/.local/state/quotient/forms/read/bin/quotient-read",
    "write": "/home/operator/.local/state/quotient/forms/write/bin/quotient-write"
  },
  "exposure": [],
  "transcript_budget_bytes": 8192
}
```

- `roots`: the directories a delegate may work in. A call's `cwd` must be
  inside one.
- `maxima`: per-call ceilings. A call may ask for less, never more.
- `maxima.context_tokens`: the maximum measured input + output + cache-read +
  cache-write footprint of one request. Choose this for your model and workload;
  the old cumulative `maxima.tokens` value cannot be converted automatically.
- `profiles`: every profile a call may use, with its capability.
- `forms`: the executable that confines pi, one per capability. quotient ships
  no forms: a form is the operator's choice, and `quotient help form` says what
  one must guarantee. On Linux, the flake's `lib.mkFormFamily` builds a read and
  a write form from your nixpkgs, a jail.nix and a pi;
  [`docs/nix-forms.md`](docs/nix-forms.md) is the manual. Without a write form,
  `"write": { "unconfined": "/absolute/path/to/pi" }` runs pi directly,
  with your user's full access. Read `quotient help policy` (The unconfined
  form) before using it.

`quotient help policy` documents every field.

### A profile

A profile is a Markdown file whose header comment is the configuration; the
rest is notes for humans. Set `model` to one your pi can reach:

```markdown
<!-- quotient-profile
filesystem: read
model: llm-gateway/deepseek-flash
thinking: off
tools: read, grep, find, ls, bash
-->
```

`filesystem` must match the capability the policy gives the profile.
`quotient help profiles` is the grammar.

The package ships six additive examples:

| Profile | Thinking | Filesystem | Intended work |
|---|---|---|---|
| `read` | off | read | Cheap recon and evidence gathering |
| `research` | low | read | Lightweight interpretation and analysis |
| `write` | off | write | Mechanical edits |
| `review` | max | read | Deep, adversarial design review |
| `judgement` | high | read | Reasoning, tradeoffs and decisions |
| `implement` | high | write | Implementation requiring judgement |

These examples name `llm-gateway/deepseek-flash`; configure a reachable model
that supports the chosen thinking level. Profile prose is documentation, so
review criteria and output requirements belong in the call's prompt. Thinking
also consumes the run's time and token budget: size the policy maxima for the
work. Existing installations can copy just the new examples and add their
capability pins to the policy, preserving locally tuned profiles. Restart the
server/client after changing profiles.

## Add it to your client

Claude Code, for all your projects:

```sh
claude mcp add --scope user quotient -- quotient
```

or for one project, checked in as `.mcp.json`:

```json
{
  "mcpServers": {
    "quotient": { "command": "quotient" }
  }
}
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.quotient]
command = "quotient"
cwd = "/home/operator/work"
tool_timeout_sec = 660     # policy maxima.wall_clock_s + 60
```

Keep `tool_timeout_sec`: Codex's default of 60 seconds is shorter than most
delegate runs. `codex mcp add quotient -- quotient` writes the entry without
it. `cwd` is the launch dir: it only defaults a call's `cwd`, and the policy
must still allow it.

`quotient help clients` prints both snippets with this install's absolute path
and a timeout computed from your policy.

Restart the client and call `pi_agent` with a `prompt` and a `profile`. The
server reads profiles and help once, at start-up, so restart it after changing
them; it reads the policy on every call. [`help/setup.md`](help/setup.md)
(`quotient help setup`) is the same walk-through, in the order to do it.

## Delegating from your agent

The calling agent needs no setup to use `pi_agent`. The server's instructions
cover a single call: the profiles, the per-run maxima, and how to read a
result. `quotient help orchestrate` is the guide for an agent that drives many
runs: probing the form, writing briefs, continuing a run that stopped short,
and the verification it must keep for itself.

To make an agent follow that guide, write a short skill that points to it and
adds only what belongs to your project or workflow. For Claude Code, put it in
`~/.claude/skills/pi-orchestrate/SKILL.md`:

```markdown
---
name: pi-orchestrate
description: Use when asked to delegate work to pi workers through `pi_agent` while you keep judgement and verification.
---

Run `quotient help orchestrate` and follow it. In this project, also:

- Briefs name the acceptance criteria the task must meet.
- Never let a worker commit; review and commit its changes yourself.
- Run `just gate` yourself before reporting work as done.
```

Pointing to the guide keeps the skill current as quotient changes. To own the
whole text instead, start from a copy: `quotient help orchestrate > SKILL.md`,
then add the frontmatter and edit it.

## Project forms

A project may substitute the executable that confines its own root: a link at
`<root>/.quotient/forms/read` or `<root>/.quotient/forms/write`. Approval is by
hand, and nothing runs until it is recorded:

```sh
quotient allow                                       # what each link resolves to
quotient allow <root> write=<realpath>@<sha256>      # record that identity
```

The approval pins the executable's real path and the sha256 of its bytes, so a
rebuilt or moved form must be approved again. With nothing approved, a root
whose link is absent runs the machine form and a usable link refuses
`form-unapproved`; only an unusable link refuses `form-invalid`, and so does an
absent link while an approval governs the root. `quotient revoke <root>` removes
the approval, and the machine form returns only once no link remains: while the
link is still there the root refuses `form-unapproved`, so remove the link too.
[`docs/contract/quotient-approvals-1.md`](docs/contract/quotient-approvals-1.md)
is the store; `quotient help policy` (Project forms) is the selection rule.

## Design and guarantees

quotient treats the delegate as untrusted: it may try to widen its own powers,
choose what confines it, or edit the record of what it did. Everything that
decides a call is therefore kept where no delegate can write it.

```
operator writes                          delegate may write
───────────────                          ──────────────────
policy.json      ┐                       its root (write profiles only)
approvals.json   │ read-only to the      its session directory
profiles/, help/ │ delegate              a private temp
                 ┘                       the policy's exposure paths
run evidence, other sessions: unreachable
```

- **Nothing a delegate writes can raise its powers.** Profiles are read once,
  at start-up, and a profile's capability must equal the one the policy pins.
  A project may substitute its own form, but only an executable the operator
  approved by real path and sha256: repointing or deleting the link makes calls
  refuse, never run something else.
- **Approval is the selection.** A root an approval governs runs exactly that
  identity or refuses; there is no fallback to the machine form. The form is
  chosen once per call, at admission, and that is what runs and what the audit
  names.
- **Fail closed, first failure wins.** A call passes a fixed sequence of checks
  (policy, switch, profile, root, form, ceilings and tools, session, the
  child's view) and the first failure is the refusal. A policy, store
  or location quotient cannot read or resolve refuses; it is never read as
  permission. Unknown fields refuse rather than being ignored.
- **One process, one root, one shutdown path.** Each call starts and ends its
  own pi process in its own process group, and every way a run stops goes
  through the same termination ladder (SIGTERM, then SIGKILL) and audit record.

What quotient does not guarantee is stated too:

- **The form does the confining.** quotient checks that the child's view
  reaches no protected store further than that store allows, but that check is
  only as sound as the form's promise to add nothing writable. The write-denial
  probe, `scripts/hostile-audit`, samples one case of that promise. A family
  built with `lib.mkFormFamily` can also be checked with `lib.checkFormFamily`,
  which reads its launchers' text and refuses what breaks the contract; binds
  added at launch and the jail's runtime behaviour are beyond it.
- **The digest covers the executable's bytes only.** What a form reads or runs
  must be embedded in it or kept where no delegate can write, and an approved
  form must be immutable to every delegate on the host.
- **Relocation.** A `cwd` spelled through a symlink a delegate can rewrite is
  governed where it lands. Name roots and `cwd`s by real path.
- **Ceilings are retrospective.** Usage is known after each request, so a run
  can overshoot by the request that crossed a ceiling; the wall clock is the
  hard backstop.
- **The unconfined form gives all of this up.**

[`docs/design.md`](docs/design.md) gives the reasoning;
[`quotient-policy-2.md`](docs/contract/quotient-policy-2.md) (admission order,
protected stores, project forms),
[`form-1.md`](docs/contract/form-1.md) and
[`quotient-approvals-1.md`](docs/contract/quotient-approvals-1.md) define it.

## Documentation

- `quotient help`: built-in help, including the agent-facing guide, which is
  also what the server tells the calling agent, and `quotient help orchestrate`,
  a guide for a caller driving many runs.
- [`docs/contract/pi-agent-result-1.md`](docs/contract/pi-agent-result-1.md):
  historical result fields, states, causes and refusals. The active result
  contract is [`docs/contract/pi-agent-result-2.md`](docs/contract/pi-agent-result-2.md)
  and distinguishes context completeness from cost accounting.
- [`docs/contract/quotient-policy-2.md`](docs/contract/quotient-policy-2.md):
  the active policy schema, where files are found, the admission order, the
  protected stores, and what the unconfined form gives up. Policy /1 is retained
  as historical documentation.
- [`docs/contract/form-1.md`](docs/contract/form-1.md): what a form must
  guarantee, and which guarantees quotient verifies.
- [`docs/contract/quotient-approvals-1.md`](docs/contract/quotient-approvals-1.md):
  the approvals store, how an approval governs a root, and the `allow` and
  `revoke` verbs.
- [`docs/nix-forms.md`](docs/nix-forms.md): building a read and write form
  family on Linux with the flake's `lib.mkFormFamily`, and checking it with
  `lib.checkFormFamily`.
- [`docs/design.md`](docs/design.md): why it is built this way.

`quotient reduce` is the reducer on its own: it turns a `pi --mode json` event
stream into the same transcript and status.

## License

MIT. See [`LICENSE`](LICENSE).
