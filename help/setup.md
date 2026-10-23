# Setup

quotient needs Node 22 or later, and `pi` installed where your forms can run
it. `quotient --version` confirms the install.

Installation ships examples; it does not copy profiles into user configuration.

1. **Write the policy.** Copy the package's `examples/policy.json` to
   `~/.config/quotient/policy.json` (or set `QUOTIENT_POLICY` to its absolute
   path). List the directories delegates may work in under `roots`. Make the
   file read-only: `chmod 0444`. `quotient help policy` is the schema.
2. **Copy the profiles.** Copy the package's `examples/profiles/*.md` to
   `~/.config/quotient/profiles/`, or to `.quotient/profiles/` in a project to
   make them that project's. Set each profile's `model` to one your pi can
   reach. Every profile a call may use must be listed in the policy's
   `profiles`, with its capability. `quotient help profiles` is the grammar.
   The examples include `read` (off), `research` (low), `write` (off),
   `review` (max, read-only), `judgement` (high, read-only) and `implement`
   (high, writable). Choose a model that supports the selected thinking level.
   For an existing installation, copy only the profiles you want to add and
   merge their capability pins into the policy.
3. **Choose a form for each capability.** A form is the executable that
   confines pi: it decides what the delegate can read and write. Put each
   form's absolute path under `forms.read` and `forms.write`.
   `quotient help form` says what a form must guarantee.
4. **Add the server to your client.** `quotient help clients` prints the
   snippets for Claude Code (`.mcp.json`) and Codex (`config.toml`) with this
   install's paths. For Codex, keep the `tool_timeout_sec` the snippet sets:
   the default of 60 seconds is shorter than most delegate runs.
5. **Restart the client,** and call `pi_agent` with a `prompt` and a `profile`.

Profiles and help are read once, when the server starts: restart it after
changing them. The policy is read on every call.

## The unconfined form

If you have no form for writing, a policy may declare
`"write": { "unconfined": "/absolute/path/to/pi" }`. quotient then runs pi
directly: the delegate can read and write whatever your user can. The
protected-store check still runs, but nothing enforces it. It is never a
fallback: a policy must name it, and a read form cannot be unconfined.
Declare it only where the delegate is trusted as much as you are. `quotient help policy` (The unconfined form)
lists exactly what it gives up.

## Overriding help

Every section except `result`, `policy` and `form` can be replaced by a file
named `<section>.md` in `<launch dir>/.quotient/help/` or
`$XDG_CONFIG_HOME/quotient/help/`; the launch dir wins. `agent` is what an MCP
client receives as the server's instructions, and `tool` is the `pi_agent`
tool's description.
