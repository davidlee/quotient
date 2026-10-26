# Setup

quotient needs Node 22 or later, and `pi` installed where your forms can run
it. `quotient --version` confirms the install.

Installation ships examples; it does not copy profiles into user configuration.

1. **Write the policy.** Copy the package's `examples/policy.json` to
   `~/.config/quotient/policy.json` (or set `QUOTIENT_POLICY` to its absolute
   path). List the directories delegates may work in under `roots`. Choose
   `maxima.context_tokens` for the largest measured request footprint; do not
   copy an old cumulative `maxima.tokens` value as an automatic conversion.
   Policy /1 files and `ceilings.tokens` caller fields must be migrated
   explicitly. Make the file read-only: `chmod 0444`. `quotient help policy`
   documents the /2 schema and refusal guidance.
2. **Copy the profiles.** Copy the package's `examples/profiles/*.md` to
   `~/.config/quotient/profiles/`. That directory is the only one read: an
   earlier version's `.quotient/profiles/` in a project fails start-up, telling
   a directory to move its documents and anything else to remove or replace it. Set each profile's `model` to one your pi can
   reach. Every profile a call may use must be listed in the policy's
   `profiles`, with its capability. `quotient help profiles` is the grammar.
   The examples include `read` (off), `research` (low), `write` (off),
   `review` (max, read-only), `judgement` (high, read-only) and `implement`
   (high, writable). Choose a model that supports the selected thinking level.
   For an existing installation, copy only the profiles you want to add and
   merge their capability pins into the policy.
3. **Choose a form for each capability.** A form is the executable that
   confines pi: it decides what the delegate can read and write. Put each
   form's absolute path under `forms.read` and `forms.write`. On Linux with Nix,
   `docs/nix-forms.md` builds a read and a write form pair.
   `quotient help form` says what a form must guarantee. A project may
   substitute its own executable for its root; see Project forms below.
4. **Add the server to your client.** `quotient help clients` prints the
   snippets for Claude Code (`.mcp.json`) and Codex (`config.toml`) with this
   install's paths. For Codex, keep the `tool_timeout_sec` the snippet sets:
   the default of 60 seconds is shorter than most delegate runs.
5. **Restart the client,** and call `pi_agent` with a `prompt` and a `profile`.

Profiles and help are read once, when the server starts: restart it after
changing them. The policy and the approvals store are read on every call.

## Project forms

A project may substitute the executable for its own root. Build the form and
link it at `<root>/.quotient/forms/read` or `<root>/.quotient/forms/write`,
then approve it by hand:

```sh
quotient allow                          # what each link resolves to, and the command
quotient allow <root> write=<realpath>@<sha256>
```

Until it is recorded, a usable link refuses `form-unapproved`; a link that is
unreadable or not executable refuses `form-invalid`, and so does a missing link
while an approval governs the root. With nothing approved, a root whose link is
absent runs the machine form. The approval pins the executable's real path and
the sha256 of its bytes, so rebuild the form and approve it again after every
change. Approving is the operator's act: there is no prompt, and the digest is
the confirmation. `quotient revoke <root>` removes the approval, and the machine
form returns only once no link remains: while the link is there the root refuses
`form-unapproved`, so remove the link too. `quotient help policy` (Project forms)
is the contract.

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
named `<section>.md` in `$XDG_CONFIG_HOME/quotient/help/`. That directory is
the only one read; an earlier version's `<launch dir>/.quotient/help/`
fails start-up, telling a directory to move its documents and anything else to
remove or replace it. `agent` is what an MCP client
receives as the server's instructions, and `tool` is the `pi_agent` tool's
description. `orchestrate` is read on demand, by a caller driving many runs.
