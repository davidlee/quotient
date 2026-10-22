# Profiles

A profile names the delegate a call runs: its capability, model, thinking
level and tools. The caller picks one by name with `profile`.

## Where profiles are found

Two layers, read once when the server starts:

1. `<launch dir>/.quotient/profiles/<name>.md`
2. `$XDG_CONFIG_HOME/quotient/profiles/<name>.md` (`~/.config/quotient/profiles/`
   when `XDG_CONFIG_HOME` is unset)

Per name, the launch-dir document wins. There is no built-in profile: the
package's `examples/profiles/` are copies to start from. A missing layer is
empty. An unreadable layer, or an invalid document in either layer, whether it
wins or not, stops the server from starting cleanly: every call then refuses
`profile-invalid`, naming the path. Edits take effect when the server restarts.

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
`profile-invalid`.

## The capability pin

The policy's `profiles` maps each allowed name to `read` or `write`. A call
refuses `profile-not-allowed` for a name the map does not list, and
`profile-capability-mismatch` when the document's `filesystem` differs from
the pin. A document therefore cannot raise its own capability, and no write
delegate can rewrite either profile layer: both are protected stores
(`quotient help policy`, Protected stores). The pin is checked on every call,
because the policy is re-read on every call.
