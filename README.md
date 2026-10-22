# quotient

A stdio MCP server with one tool, `pi_agent`, which delegates a bounded piece
of work to a [pi](https://github.com/earendil-works/pi) agent. Each call runs one
pi process, confined by a form you choose, under limits you set, in a
directory you allowlisted. It answers with a reduced transcript, a status and
a verdict. Use it to hand recon, review or small edits to a cheaper model
without handing it your machine.

## Install

quotient needs Node 22 or later, and `pi` installed where your forms can run it.
pi is a prerequisite, not a dependency.

```sh
npm install -g @davidlee/quotient
```

or, with nix:

```sh
nix profile install github:davidlee/quotient
```

`quotient --version` confirms the install, and `quotient help` lists the built-in
help sections.

## Five-minute setup

1. **Write the policy.** Copy `examples/policy.json` to
   `~/.config/quotient/policy.json` (or set `QUOTIENT_POLICY` to its absolute
   path). List the directories delegates may work in under `roots`. Make the
   file read-only: `chmod 0444`.
2. **Copy the profiles.** Copy `examples/profiles/*.md` to
   `~/.config/quotient/profiles/`, or to `.quotient/profiles/` in a project to
   make them that project's. Set each profile's `model` to one your pi can
   reach. Every profile a call may use must be listed in the policy's
   `profiles`, with its capability.
3. **Choose a form for each capability.** A form is the executable that
   confines pi: it decides what the delegate can read and write. Put each
   form's absolute path under `forms.read` and `forms.write`. `form-1.md` says
   what a form must guarantee. If you have no form for writing, you can declare
   `"write": { "unconfined": "/absolute/path/to/pi" }`, but read what that
   gives up in `quotient-policy-1.md` first. A read form cannot be unconfined.
4. **Add the server to your client.** `quotient help clients` prints the
   snippets for Claude Code (`.mcp.json`) and Codex (`config.toml`) with this
   install's paths. For Codex, keep the `tool_timeout_sec` the snippet sets:
   the default of 60 seconds is shorter than most delegate runs.
5. **Restart the client,** and call `pi_agent` with a `prompt` and a `profile`.

Profiles and help are read once, when the server starts: restart it after
changing them. The policy is read on every call.

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
