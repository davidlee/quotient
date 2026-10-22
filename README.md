# quotient

An MCP server with one tool, `pi_agent`, which delegates a bounded piece of
work to [pi](https://github.com/earendil-works/pi), a command-line coding agent
that can run on a cheaper model. MCP (the Model Context Protocol) is how agents
such as Claude Code and Codex call external tools; quotient speaks it over
stdin and stdout.

Each call runs one pi process in a directory you allowlisted, under limits you
set, confined by a *form*: an executable you choose that decides what the
delegate can read and write. Each profile has a *capability*, `read` or
`write`, and the policy names one form per capability. The call answers with
a transcript reduced to its essentials, a status (usage, cost, counts) and a
verdict: whether the run succeeded, and if not, why. Use it to hand recon,
review or small edits to a cheaper model without handing it your machine.

## Install

quotient needs Node 22 or later, and `pi` installed where your forms can run it.
pi is a prerequisite, not a dependency.

```sh
npm install -g @davlee/quotient
```

or, with nix:

```sh
nix profile install github:davidlee/quotient
```

`quotient --version` confirms the install, and `quotient help` lists the built-in
help sections.

## Setup

[`help/setup.md`](help/setup.md) (`quotient help setup`) walks through the
policy, the profiles, choosing a form and adding the server to Claude Code or
Codex. It takes about five minutes.

## Documentation

- `quotient help`: built-in help, including the agent-facing guide, which is
  also what the server tells the calling agent.
- [`docs/contract/pi-agent-result-1.md`](docs/contract/pi-agent-result-1.md):
  the result document every call answers with: fields, states, causes and
  refusals.
- [`docs/contract/quotient-policy-1.md`](docs/contract/quotient-policy-1.md):
  the policy schema, where files are found, the admission order, the protected
  stores, and what the unconfined form gives up.
- [`docs/contract/form-1.md`](docs/contract/form-1.md): what a form must
  guarantee, and which guarantees quotient verifies.
- [`docs/design.md`](docs/design.md): why it is built this way.

`quotient reduce` is the reducer on its own: it turns a `pi --mode json` event
stream into the same transcript and status.

## License

MIT. See [`LICENSE`](LICENSE).
