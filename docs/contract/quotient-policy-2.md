# `quotient-policy/2`

The operator policy: the one document that decides whether, where and how a
`pi_agent` call may run. Normative: a breaking change mints `quotient-policy/2`,
and this contract stays alongside.

## Where things are

quotient finds its inputs from the environment, falling back to XDG. The policy
is authority, so it is never looked up in the project tree the server was
launched from.

| variable | holds | when unset |
|---|---|---|
| `QUOTIENT_POLICY` | absolute path of the policy file | `<xdgConfig>/quotient/policy.json` |
| `QUOTIENT_RUN_DIR` | absolute path of the run evidence directory | `<xdgState>/quotient/runs` |
| `QUOTIENT_SESSION_HOME` | absolute path of the session home | `<xdgState>/quotient/sessions` |
| `QUOTIENT_LAUNCHER` | absolute path a wrapper was run as; `quotient help clients` prints it as the command | the path the bin script was run as |

- `<xdgConfig>` is the value of `XDG_CONFIG_HOME` when it is absolute, else
  `$HOME/.config`. `<xdgState>` is the value of `XDG_STATE_HOME` when it is
  absolute, else `$HOME/.local/state`. A relative `XDG_*` value is ignored, as
  the XDG spec says. `HOME` is used only when it is absolute.
- **Only an unset variable falls through.** A `QUOTIENT_*` variable that is set
  but empty or relative refuses the call `policy-unavailable`, so a typo never
  silently moves the policy. So does having neither a usable XDG base nor an
  absolute `HOME`.
- `QUOTIENT_LAUNCHER` is a hint for the client snippets, not a location: an
  empty or relative value is ignored and never refuses a call. A wrapper sets
  it so the snippet names the stable path a client should run, not the script
  behind the wrapper.
- The run directory and session home are created on first use.
- No `QUOTIENT_*` variable reaches a delegate: the child's environment is the
  server's minus every `QUOTIENT_*` variable and minus any value naming the run's
  evidence.

Profiles and help are found in layers, highest first: `<launch dir>/.quotient/`
over `<xdgConfig>/quotient/`. Both are read once, at start-up.

## Fields

The policy is one JSON object. Every required field must be present and every
field is type-checked. An unknown field, at the top level or inside `maxima`
or a form object, refuses `policy-invalid`: nothing is silently dropped.

| field | type | required | meaning | on a bad value |
|---|---|---|---|---|
| `schema` | the string `"quotient-policy/2"` | yes, checked first | the schema this document is written against | `policy-invalid` |
| `mode` | string | yes | `per-call` is the only posture this version serves | `posture-unsupported` for another string, else `policy-invalid` |
| `enabled` | boolean | yes | the operator switch: `false` refuses every call and stops runs in flight | `policy-invalid`; `false` refuses `disabled` |
| `roots` | array of absolute path strings | yes | the directories a call may run in; a call's `cwd` must be one of them or inside one, compared by path component | `policy-invalid` |
| `maxima` | object | yes | per-run bounds; all four units required | `policy-invalid` |
| `maxima.requests` | positive number | yes | provider requests per run | `policy-invalid` |
| `maxima.context_tokens` | positive number | yes | maximum observed input + output + cache-read + cache-write tokens for one request | `policy-invalid` |
| `maxima.cost_usd` | positive number | yes | provider cost per run, in US dollars | `policy-invalid` |
| `maxima.wall_clock_s` | positive number | yes | wall-clock seconds per run: the hard backstop | `policy-invalid` |
| `profiles` | object: profile name → `"read"` or `"write"` | yes | the profiles a call may request, each pinned to a filesystem capability | `policy-invalid` |
| `forms` | object | yes | the form that runs each capability | `policy-invalid` |
| `forms.read` | a form (below), never unconfined | no | the form for a `read` profile | `policy-invalid`; absent refuses `wrapper-unavailable` at step 5 |
| `forms.write` | a form (below) | no | the form for a `write` profile | `policy-invalid`; absent refuses `wrapper-unavailable` at step 5 |
| `exposure` | array of absolute path strings | yes (may be empty) | the writable host paths the form shares with the child beyond the root, the session directory and its private temp | `policy-invalid` |
| `transcript_budget_bytes` | non-negative integer | no | byte ceiling for the returned transcript; `0` sets none | `policy-invalid` |

A form is one of three shapes:

- an absolute path string: a confined form that passes no extensions;
- `{ "path": "<absolute path>", "extensions": ["builtin:mcp"] }`: a confined
  form that re-enables pi's MCP built-in, for profiles that name an `mcp__*`
  tool. `extensions` is optional, and `builtin:mcp` is its only accepted value;
- `{ "unconfined": "<absolute pi path>" }`: no confinement at all (below).
  Write only; `path` with `unconfined` is `policy-invalid`, and so is an
  `extensions` key beside it.

No form is ever found on `PATH`.

The fields `agent`, `root`, `filesystem`, `session_home`, `run_dir` and
`evidence_dir` belong to a static posture this version does not serve. Their
presence refuses `posture-unsupported`, never a silent downgrade.

## Migration from policy/1

This version serves `quotient-policy/2` only. A policy tagged
`quotient-policy/1` is refused as `policy-invalid` with guidance to choose a
`maxima.context_tokens` value and remove `maxima.tokens`. A /2 policy that
contains `maxima.tokens`, whether alone or alongside `maxima.context_tokens`,
is also refused with field-specific guidance. A /2 policy missing
`maxima.context_tokens` is refused and names the required field. No old token
ceiling is converted automatically: it was cumulative over a run, while this
version measures the peak footprint of one request.

Callers must replace `ceilings.tokens` with `ceilings.context_tokens`. The old
name, alone or alongside the new name, is refused as `request-invalid` with
guidance to use `ceilings.context_tokens`. Unknown fields remain refused.

## Choosing the context threshold

`maxima.context_tokens` is a maximum for one measured request, not a cumulative
run budget. Quotient adds the normalized input, output, cache-read and
cache-write components for each counted request, then compares the observed
peak with this limit. Equality is allowed; a value strictly above the limit
stops the run. The check is retrospective: the request reporting the crossing
has already run. No automatic conversion from the old cumulative `maxima.tokens`
value is possible. Choose a threshold for the intended model and workload.

## Caller ceilings

The optional `ceilings` object on a `pi_agent` call may supply these finite
numeric limits:

| caller field | policy maximum | unit |
|---|---|---|
| `ceilings.requests` | `maxima.requests` | provider requests per call |
| `ceilings.context_tokens` | `maxima.context_tokens` | observed peak request footprint |
| `ceilings.cost_usd` | `maxima.cost_usd` | reported provider cost per call |
| `ceilings.wall_clock_s` | `maxima.wall_clock_s` | seconds per call |

An omitted caller field inherits its policy maximum. A supplied value at or
below the maximum is used; a value above it refuses `ceiling-above-maximum`.
The object is closed: unknown fields refuse the call.

## A minimal policy

Placeholder paths; replace them with this host's.

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
  "profiles": { "read": "read", "research": "read", "write": "write" },
  "forms": {
    "read": "/home/operator/.local/state/quotient/forms/read/bin/quotient-read",
    "write": "/home/operator/.local/state/quotient/forms/write/bin/quotient-write"
  },
  "exposure": [],
  "transcript_budget_bytes": 8192
}
```

## How a call is admitted

Each call is checked in this order, and the first failure wins. Every refusal
is a tool result naming its reason (`pi-agent-result-2.md`, Refusals).

1. **Policy:** read and validated on every call (`policy-unavailable`,
   `policy-invalid`, `posture-unsupported`).
2. **Switch:** `enabled` (`disabled`).
3. **Profile:** the name must be in the start-up snapshot (`profile-unknown`)
   and in `profiles` (`profile-not-allowed`), and the document's `filesystem`
   must be the capability `profiles` pins (`profile-capability-mismatch`). A
   local profile can change model, thinking, tools and prose, never
   capability.
4. **Root:** the call's `cwd`, canonicalised, inside an entry of `roots`
   (`root-missing`, `root-not-a-directory`, `root-not-allowlisted`).
5. **Form:** the profile's capability selects `forms.read` or `forms.write`
   (`wrapper-unavailable`). A profile naming an `mcp__*` tool needs a form that
   passes `builtin:mcp` (`profile-invalid`).
6. **Ceilings and tools:** a call's `ceilings` may only lower `maxima`
   (`ceiling-above-maximum`); its `tools` may only narrow the profile's
   (`tools-not-allowed`).
7. **Session:** grammar, and a session stays bound to the root and capability
   it was first used with (`session-invalid`, `session-root-mismatch`,
   `session-capability-mismatch`, `session-busy`).
8. **Child view:** what the child could write must not reach a protected store
   (`view-overlaps-protected`, below).

## Protected stores

Step 8 compares the child's writable view, which is the root under a write
profile, the session directory and every `exposure` path, against these
stores:

| store | the child may |
|---|---|
| the run evidence directory | neither read nor write it |
| the attempts ledger | neither read nor write it |
| the session home, except this call's session directory | neither read nor write it |
| the policy file | read it, never write it |
| the profile layers, launch-dir and XDG | read them, never write them |
| the help layers, launch-dir and XDG | read them, never write them |

A store is protected whether or not it exists, so a delegate cannot create a
layer and plant a profile for the next restart. A writable path that is,
contains or lies inside a store it may not write refuses. One consequence: a
write call cannot be rooted at the server's launch directory or any parent of
it, because that root contains the launch-dir layers.

Step 8 is sound only if the form adds nothing writable beyond what it is told;
that is the form's promise (`form-1.md`). The check takes `exposure` as the
description of what the form shares, and treats every entry as writable.

## The unconfined form

`{ "unconfined": "<absolute pi path>" }` runs pi directly, with the root as its
working directory. It is not a form-1 form, and it gives up every guarantee
form-1 makes:

- **no read-only guarantee:** there is no read capability without a form, so
  `forms.read` cannot be unconfined;
- **no reach limit** beyond pi's working directory: the delegate can read and
  write whatever the server's user can;
- step 8 still runs, but nothing enforces it;
- a server killed with SIGKILL leaves the run's process group running, where a
  confined form's child dies with its parent.

Declare it only where the delegate is trusted as much as the server's user.

## Publishing a policy

What the server enforces:

- **Read on every call.** An edit applies to the next call. A run in flight
  keeps the maxima it was admitted with.
- **`enabled` is re-read at every gate tick**, about once a second.
  `enabled: false` stops a run in flight with cause `switch`, and so does an
  absent, unreadable or malformed file: a switch whose source cannot be read is
  not evidence that it is on.
- **Fail closed.** A file that cannot be read refuses `policy-unavailable`;
  one that does not parse or fails the schema refuses `policy-invalid`.

What the operator must do:

- Keep the file read-only (for example mode `0444`), and outside every root and
  `exposure` path.
- Publish atomically: write a temporary file in the same directory, then rename
  it over the policy path. A tick that reads a half-written file stops the runs
  in flight, which is the intended direction for a control channel.
- Restart the server after changing profiles or help: both are read only at
  start-up.

Every audit record carries the sha256 of the policy bytes it was admitted
under, and the `spawn` record names the profile document that won.
