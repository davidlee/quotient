# Profiles

A profile names the delegate a call runs: its capability, model, thinking
level and tools. The caller picks one by name with `profile`.

## Where profiles are found

One directory, read once when the server starts:
`$XDG_CONFIG_HOME/quotient/profiles/<name>.md` (`~/.config/quotient/profiles/`
when `XDG_CONFIG_HOME` is unset).

An earlier version also read `<launch dir>/.quotient/profiles/`. That layer is
gone: a server that finds one fails start-up, telling a directory to move its
documents into the XDG directory and an entry that is not a directory to remove
or replace it. There is no built-in profile: the package's
`examples/profiles/` are copies to start from. An absent directory is empty. An
unreadable directory, or an invalid document in it, stops the server from
starting cleanly: every call then refuses `profile-invalid`, naming the path.
Edits take effect when the server restarts.

## Document grammar

A profile is a markdown file whose first non-empty line opens an HTML-comment
header, followed by one `key: value` line per field, then a line holding just
`-->`:

```
<!-- quotient-profile
filesystem: read
model: llm-gateway/deepseek-flash
thinking: off
tools: read, grep, find, ls, bash
-->
```

- `filesystem` (required): `read` or `write`, the capability the profile needs.
- `model` (required): one non-empty token, passed to pi's `--model`. It may not
  end in pi's `:<level>` shorthand; set `thinking` instead.
- `tools` (required): a comma-separated list of tool names, passed to pi's
  `--tools`. A call's `tools` may only narrow it.
- `thinking` (optional): one of `off`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, `max`. When omitted, pi uses its own default.

Each field appears once, with a non-empty value after a space or tab. The
header has no blank line and no other key. The file's base name is the
profile's name and must match `^[a-z][a-z0-9-]{0,31}$`. Everything after the
header is prose for a human and is not parsed.

A profile that names an `mcp__*` tool needs a form that passes `-e
builtin:mcp` (`quotient help policy`, Fields); otherwise calls refuse
`profile-invalid`. A project form inherits the machine form's extensions, so it
cannot grant one a profile needs (`quotient help policy`, Project forms).

## The capability pin

The policy's `profiles` maps each allowed name to `read` or `write`. A call
refuses `profile-not-allowed` for a name the map does not list, and
`profile-capability-mismatch` when the document's `filesystem` differs from
the pin. A document therefore cannot raise its own capability, and no write
delegate can rewrite the profile directory: it is a protected store
(`quotient help policy`, Protected stores). The pin is checked on every call,
because the policy is re-read on every call.
