# pi-mcp — operator guide

## What this is

`pi-mcp` is a stdio MCP server that exposes one tool, `pi_agent`. One call runs
one one-shot pi delegate under a wrapper form — a flake-provided launcher that
owns the confinement — and answers with its reduced transcript, status and
verdict. The server holds no jail argv of its own: the form decides what the
child can reach. A call's filesystem capability and tool set come from a
tracked profile document; admission comes from the operator policy described
here. The tracked profiles are documented in `pi/mcp/profiles/` (`read.md`,
`write.md`, `research.md`).

## Launch environment

The server has exactly three configuration inputs, all read from the process
environment:

| variable | holds |
|---|---|
| `PI_MCP_POLICY` | absolute path of the policy file |
| `PI_MCP_RUN_DIR` | absolute path of the run/evidence directory |
| `PI_MCP_SESSION_HOME` | absolute path of the session home |

Each value must be absolute. These three variables are the server's whole
configuration surface: `main.ts` hands the process environment to `serve`, and
the server reads no argv and discovers no config file. A missing, empty or
relative `PI_MCP_POLICY`, `PI_MCP_RUN_DIR` or `PI_MCP_SESSION_HOME` refuses the
call `policy-unavailable` before the policy is read (`admitCall` in
`policy.ts`). Nothing is defaulted from the caller's working directory.

## Policy fields

The policy is one JSON object. Every required field must be present, every
field is type-checked, and an unknown field refuses `policy-invalid` — at the
top level and inside `maxima` or `forms` — rather than being silently dropped.

| field | type | required | meaning | bad value |
|---|---|---|---|---|
| `mode` | string | yes | `per-call` is the only posture this build serves | `posture-unsupported` for any other value (`policy-invalid` if not a string) |
| `roots` | array of absolute path strings | yes | roots a call's `cwd` may name; allowlisting is by path component | `policy-invalid` |
| `maxima` | object | yes | per-run spend and time bounds; all four units required | `policy-invalid` |
| `maxima.requests` | positive finite number | yes | provider requests per run | `policy-invalid` |
| `maxima.tokens` | positive finite number | yes | input, output, cached and cache-write tokens per run | `policy-invalid` |
| `maxima.cost_usd` | positive finite number | yes | provider cost in US dollars per run | `policy-invalid` |
| `maxima.wall_clock_s` | positive finite number | yes | wall-clock seconds per run; the hard backstop | `policy-invalid` |
| `profiles` | array of strings | yes | profile names a call may request | `policy-invalid` |
| `forms` | object | yes | wrapper forms, one per filesystem capability | `policy-invalid` |
| `forms.read` | absolute path string, or `{ "path": ..., "extensions": [...] }` | no | form used by a `read`-capability profile | `policy-invalid`; absent form refuses `wrapper-unavailable` at step 5 |
| `forms.write` | absolute path string, or `{ "path": ..., "extensions": [...] }` | no | form used by a `write`-capability profile | `policy-invalid`; absent form refuses `wrapper-unavailable` at step 5 |
| `child_binds` | array of absolute path strings | yes (may be empty) | fixed mounts the form adds beyond the root and session directory | `policy-invalid` |
| `enabled` | boolean | yes | the operator switch; `false` refuses every call | `policy-invalid`; `false` refuses `disabled` at step 2 |
| `transcript_budget_bytes` | non-negative integer | no | byte ceiling for the returned transcript; `0` sets no ceiling | `policy-invalid` |

A form value has two shapes. The string shape is an absolute path and declares
no extensions. The object shape carries `path` plus an optional `extensions`
array; only `builtin:mcp` is accepted, because that is the one extension the
launch forms pass. Any other key inside a form object refuses `policy-invalid`.

The fields `agent`, `root`, `filesystem`, `session_home`, `run_dir` and
`evidence_dir` belong to the static posture, which this build does not serve.
Their presence — like a `mode` other than `per-call` — refuses
`posture-unsupported`, never a silent downgrade.

## A minimal policy

Placeholder absolute paths; replace them with this host's real form launchers.

```json
{
  "mode": "per-call",
  "roots": ["/home/operator/work"],
  "maxima": {
    "requests": 20,
    "tokens": 100000,
    "cost_usd": 1.5,
    "wall_clock_s": 600
  },
  "profiles": ["read", "research"],
  "forms": {
    "read": "/nix/store/00000000000000000000000000000000-pi-mcp-read/bin/pi-mcp-read",
    "write": "/nix/store/00000000000000000000000000000000-pi-mcp-write/bin/pi-mcp-write"
  },
  "child_binds": ["/home/operator/.pi"],
  "enabled": true,
  "transcript_budget_bytes": 8192
}
```

## Profiles and forms

The policy's `profiles` names which tracked profiles a call may use. A name
outside that list refuses `profile-not-allowed`; a name the start-up snapshot
does not hold refuses `profile-unknown`.

A profile's `filesystem` (read or write) selects `forms.read` or `forms.write`
respectively. A capability with no declared form refuses `wrapper-unavailable`,
because the form is the confinement and there is no other way to run. A form
that does not pass `builtin:mcp` while its profile names an `mcp__*` tool
refuses `profile-invalid`.

The profile snapshot is read once at start-up and held for the process
lifetime. A profile edit on disk is inert until the server is restarted;
restarting is a deployment act, not something a delegate can do from inside a
call.

A call's `ceilings` may only lower the policy's `maxima`; a ceiling above a
maximum refuses `ceiling-above-maximum` rather than being silently clamped. A
call's `tools` may only narrow the profile's tool set (it is an intersection,
in the profile's order); asking for a tool the profile does not grant refuses
`tools-not-allowed`.

## Publishing a policy

What the server enforces:

- **Read per call.** The policy is read and validated in `admitCall` for every
  call, so an edit applies to the next call. An in-flight run keeps the maxima
  it was admitted with: the gate judges its clamped snapshot and ignores the
  maxima in any re-read (`gate.ts`).
- **`enabled` is re-read at every gate tick.** The tick re-reads and re-parses
  the whole file (`policySwitch` in `gate.ts`). `enabled: false` aborts the run
  through the ladder with cause `switch`; so do an absent, unreadable or
  malformed file, because a switch whose source cannot be read is not evidence
  that it is off.
- **Absent, unreadable or malformed refuses every call.** A file that cannot be
  read refuses `policy-unavailable`; one that cannot be parsed or fails the
  schema refuses `policy-invalid`.
- **The child's view may never make the policy file writable.** `childview.ts`
  treats the policy file as a protected store with `never-writable` tolerance:
  a read-write root or fixed bind that is or contains the policy file refuses
  `view-overlaps-protected`. Reading it is tolerated.

What the operator must do:

- Keep the file read-only (for example mode `0444`) and outside every root and
  `child_binds` entry.
- Publish atomically: write a temp file in the same directory, then rename it
  over the policy path. A gate tick that catches a half-written file sees an
  unparsable policy and halts the in-flight run with cause `switch`. Fail-closed
  is the intended direction for a control channel.

## Known limitation: `child_binds`

Today every fixed bind is treated as read-write by the child-view check, so a
read-only mount that contains the policy file over-refuses. And nothing checks
a policy's `child_binds` against the binds the selected form actually adds; the
policy's list is taken as the description. Tracked as IMP-048.

## Refusals

Every refusal is a successful MCP tool result carrying the reason and a detail
string; none is a JSON-RPC error.

| reason | raised at | meaning |
|---|---|---|
| `request-invalid` | request shape, before step 1 | the arguments are not a well-formed `pi_agent` call |
| `policy-unavailable` | step 1 | a launch variable is unset or relative, or the policy file cannot be read |
| `policy-invalid` | step 1 | the policy is not JSON or fails the schema |
| `posture-unsupported` | step 1 | `mode` is not `per-call`, or a static-only field is present |
| `disabled` | step 2 | `enabled` is `false` |
| `profile-invalid` | before every call; step 3; step 5 | the start-up snapshot failed to load (every call refuses, whatever its shape); the name fails the profile grammar; or the profile needs an extension its form cannot pass |
| `profile-unknown` | step 3 | the name is not in the start-up snapshot |
| `profile-not-allowed` | step 3 | the name is not in the policy's `profiles` |
| `root-missing` | step 4 | the call's root does not exist |
| `root-not-a-directory` | step 4 | the call's root exists but is not a directory |
| `root-not-allowlisted` | step 4 | the canonical root is outside every `roots` entry |
| `wrapper-unavailable` | step 5 | the policy declares no form for the profile's filesystem capability |
| `ceiling-above-maximum` | step 6 | a requested ceiling is above its `maxima` unit |
| `tools-not-allowed` | tools narrowing | the call asked for a tool the profile does not grant |
| `session-invalid` | step 7 | the session id fails the session grammar |
| `session-root-mismatch` | step 7 | the session is bound to a different root |
| `session-capability-mismatch` | step 7 | the session is bound to a different filesystem capability |
| `session-busy` | step 7 | another live or unknowable owner holds the session, or a claim needs an operator |
| `view-overlaps-protected` | step 8 | the child view exposes a protected store more strongly than it tolerates |
| `audit-unavailable` | audit probe before the run | the attempts ledger cannot be appended to, so no run is launched |
| `audit-failed` | run audit before spawn | the run's audit cannot be written and its directory is discarded |
| `server-error` | outer `tools/call` catch | the server threw before a run was established |
