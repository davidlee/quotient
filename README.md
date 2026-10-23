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
`XDG_CONFIG_HOME` and `XDG_STATE_HOME` are honoured. A project can carry its
own profiles in `.quotient/profiles/`, which win per name over the user's. The
policy is never read from a project.

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
  no forms; `quotient help form` says what one must guarantee. Without a write
  form, `"write": { "unconfined": "/absolute/path/to/pi" }` runs pi directly,
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
it. `cwd` is the launch dir, where `.quotient/profiles/` is looked for.

`quotient help clients` prints both snippets with this install's absolute path
and a timeout computed from your policy.

Restart the client and call `pi_agent` with a `prompt` and a `profile`. The
server reads profiles and help once, at start-up, so restart it after changing
them; it reads the policy on every call. [`help/setup.md`](help/setup.md)
(`quotient help setup`) is the same walk-through, in the order to do it.

## Documentation

- `quotient help`: built-in help, including the agent-facing guide, which is
  also what the server tells the calling agent.
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
- [`docs/design.md`](docs/design.md): why it is built this way.

`quotient reduce` is the reducer on its own: it turns a `pi --mode json` event
stream into the same transcript and status.

## License

MIT. See [`LICENSE`](LICENSE).
