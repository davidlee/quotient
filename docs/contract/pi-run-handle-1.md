# `pi-run-handle/1`

The document `pi_agent_start` answers, and the run document every surface that
describes a run shares: a handle, each entry of a `pi-agent-wait/1` answer
(`docs/contract/pi-agent-wait-1.md`) and an MCP task. Normative: a change that
breaks it mints `pi-run-handle/2`, and this contract stays alongside.

## The envelope

A `tools/call` of `pi_agent_start` answers with an MCP tool result: one `text`
content item whose text is a JSON document.

- **Started, or found by its key:** the document is `pi-run-handle/1`, and
  `isError` is `false` — whatever state the run is in, a terminal one included.
  A handle is never an error because of the run it names.
- **Refused:** the document is a `pi-agent-result/2` refusal
  (`docs/contract/pi-agent-result-2.md`), and `isError` is `true`. Nothing was
  started and no handle exists.

A client tells the two apart by `schema`. In the modern protocol era the tool
result also carries `resultType: "complete"`.

```json
{
  "schema": "pi-run-handle/1",
  "taskId": "run-20261026T120301123Z-7-3f9a0c1d2e4b",
  "status": "working",
  "statusMessage": "queued in lane build behind run-20261026T120259870Z-6-0b1c2d3e4f5a",
  "createdAt": "2026-10-26T12:03:01.123Z",
  "lastUpdatedAt": "2026-10-26T12:03:01.123Z",
  "ttlMs": null,
  "pollIntervalMs": 2000,
  "state": "queued",
  "lane": "build",
  "key": "step-2",
  "session": "9c0f2b6e4d1a4c8e9f7b3a5d2c1e0f4a",
  "artifacts": {
    "dir": "/var/lib/quotient/runs/run-20261026T120301123Z-7-3f9a0c1d2e4b"
  }
}
```

`pi-run-handle/1` is `schema` plus the run document below, exactly.

## The run document

Every surface describes a run with the same seven MCP Task fields, their names
verbatim from the tasks extension: `taskId` to `pollIntervalMs` below. A handle
and a wait entry add quotient's extras in snake_case, `state` to `artifacts`; a
created task and a `tasks/get` answer carry the Task fields only (see Tasks). A
client that knows tasks reads the Task fields; the extras are quotient's.

| path | type | nullable | meaning |
|---|---|---|---|
| `taskId` | string | no | the run's handle (below); the same string is its task id |
| `status` | string | no | the Task status: `working`, `completed`, `cancelled` or `failed`, collapsed from `state` by the Status table |
| `statusMessage` | string | no | the message beside the status, by the Status table |
| `createdAt` | string | no | ISO 8601 time the run was published: the `ts` of its first audit record |
| `lastUpdatedAt` | string | no | ISO 8601 time of the latest audit record, or of the moment `result.json` was written, whichever is later |
| `ttlMs` | null | yes | always `null`: the result lives as long as the evidence directory, which the operator prunes, not the server |
| `pollIntervalMs` | number | no | the interval to poll the run at, in milliseconds: `2000` |
| `state` | string | no | the finer quotient state `status` collapses: a token of the States table |
| `lane` | string | yes | the lane the run was started into; `null` when none was named, or when its evidence records none |
| `key` | string | yes | the key the run was started with; `null` when none was given, and always for a run not started by `pi_agent_start` |
| `session` | string | yes | the session the run owns: the one the request named, or one minted when it started. `null` only when its evidence records none: a run directory from a release before this one, or one whose `admitted` audit record cannot be read |
| `artifacts` | object | no | where the run's evidence lives |
| `artifacts.dir` | string | no | the run's evidence directory. Its `result.json`, once present, is the run's `pi-agent-result/2` document |

In a handle or a wait entry every key listed is always present. A run document never holds the run's result;
a wait entry carries it beside the run document (`pi-agent-wait/1`).

## States

| state | terminal | meaning |
|---|---|---|
| `queued` | no | started into a lane whose previous run has not settled; it launches when it reaches the head of the lane |
| `running` | no | launched: re-admitted if it was queued, and its process started or starting |
| `foreign` | no | another quotient server sharing the run directory owns it and may still be running it, or its owner's liveness cannot be known |
| `settled` | yes | a `pi-agent-result/2` document was written to `result.json` |
| `lost` | yes | no result was recorded and none ever will be: `result.json` could not be written, the owner is confirmed dead without having written one, or the evidence names no owner (a run directory from an earlier release, or an `admitted` record without one) |

A server holds `queued`, `running`, `settled` and `lost` for the runs it started.
A run it does not hold — started by another server, or before a restart — is
resolved from its evidence directory: `settled` when a result reads, `lost` on
positive evidence that no one can still write one (a published `lost` record,
an owner confirmed dead, or evidence that names no owner), and `foreign`
otherwise. A
run is never guessed dead. A terminal state never changes: it is derived only
from `result.json`, a recorded loss and the owner's confirmed death, all of
which are permanent, so it reads the same before and after the server ends.
One exception: when neither `result.json` nor the `lost` record can be written
(the run directory itself has become unwritable), the owning server reports the
run `lost` while any other server reads it `foreign` until the owner is
confirmed dead.

Two answers are not states, and no run document carries them: an id with no
evidence directory at all (*unknown*) and a run whose `result.json` exists but
cannot be read now, or whose evidence cannot be read now (*unreadable*). Neither
has a status to report. `pi-agent-wait/1` lists them apart.

## Status

The one mapping from `state` to the Task fields. A cancel request never
decides a status: only a queued or running run says `cancelling`, and a
terminal status is what the written result says.

| `state` | `status` | `statusMessage` | `tasks/get` adds |
|---|---|---|---|
| `queued` | `working` | `queued in lane <lane> behind <predecessor>` (or `queued in lane <lane>` with no predecessor, or `queued` with no lane); `cancelling` once a cancel has marked it | — |
| `running` | `working` | `running`; `cancelling` once a cancel has marked it | — |
| `foreign` | `working` | `owned by another quotient server (pid <pid>)`, or without the pid when none was recorded or it cannot be read | — |
| `settled`, result state `cancelled` | `cancelled` | the result's `causes`, joined with `, ` | nothing: `pi_agent_wait` naming the task id still reads the run's `pi-agent-result/2` document |
| `settled`, any other result state | `completed` | the result's `state` | `result`: the tool result a blocking `pi_agent` would have answered, its `isError` true unless the result state is `completed` |
| `lost` | `failed` | `lost: inspect <dir>` | `error`: `{ code: -32603, message: "run lost: no result was recorded; inspect the evidence directory", data: { dir } }` |

A delegated run that failed is a `completed` task whose result has `isError:
true`: the task finished and produced the answer the blocking call would have
given. `failed` is kept for the one case where no answer exists.

`tasks/get` answers an unreadable run, or a settled one whose `result.json`
cannot be read now, with error `-32603` ("the result could not be read;
retry"), and an unknown or malformed task id with `-32602`.

## Tasks

Only `pi_agent` answers with a task, and only to a request that declares the
tasks extension in its own `params._meta`:

```json
{
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {
      "extensions": { "io.modelcontextprotocol/tasks": {} }
    }
  }
}
```

The declaration is per request: one made at `initialize`, or on an earlier
request, does not carry over. A request without it, in either protocol era,
blocks and answers `pi-agent-result/2`. A version other than `2026-07-28` is
error `-32022`, naming the supported version; a version that is not a string,
or capabilities that are not an object, is `-32602`.

The answer is the run's Task fields, flat, beside `resultType`:

```json
{
  "taskId": "run-20261026T120301123Z-7-3f9a0c1d2e4b",
  "status": "working",
  "statusMessage": "running",
  "createdAt": "2026-10-26T12:03:01.123Z",
  "lastUpdatedAt": "2026-10-26T12:03:01.123Z",
  "ttlMs": null,
  "pollIntervalMs": 2000,
  "resultType": "task"
}
```

`tasks/get` answers the same Task fields, the member the Status table names,
and `resultType: "complete"`. `tasks/cancel` and `tasks/update` answer an empty
result. A refusal at admission is not a task: it answers the
`pi-agent-result/2` refusal.

## The handle

A run's handle is its evidence directory's name, unique per run:

```
run-<UTC stamp>-<call-id slug>-<12 hex>
```

matching `^run-[0-9TZ]+-[A-Za-z0-9_-]{1,32}-[0-9a-f]{12}$`. The same string is
the run's `taskId` in every run document and in MCP tasks. It is opaque: a
client stores and passes it back, and must not parse it or build one. The
server checks every incoming id against this grammar before using it, and a
request carrying an id that fails it is refused `request-invalid`; so no id can
name a path outside the run directory.

## The key

`pi_agent_start` takes an optional `key`: 1 to 128 printable ASCII characters
(space through `~`). It makes a retried start safe.

- The server keeps a digest of each keyed start's request: sha256 over the
  request with its fields normalised — defaults applied, `cwd` resolved against
  the server's launch directory, `tools` as a sorted set, empty `ceilings` as
  none — and `key` itself left out.
- A start whose key the server already holds is a **replay**. With an equal
  digest, it answers the original run's handle as it is now — any state,
  terminal included — and admits nothing. With a different digest it is
  refused `request-invalid` (the detail says the key was used with different
  arguments).
- A key is recorded only when its start publishes a run. A refused start
  records none, so retrying it is admitted afresh.
- Keys live for one server process. A client that reconnects talks to a new
  server, which holds none.

## When a handle is terminal

`state` is usually `running`, or `queued` when the lane is busy. A handle can be
terminal:

- A laned run started with `needs_success` whose predecessor in the lane did not
  complete is settled at once as a `lane-predecessor-failed` refusal; its handle
  answers `settled`.
- A key replay answers the original run in whatever state it is in now.

A queued run may still settle as a refusal later: when it reaches the head of
its lane it is re-admitted against the policy and approvals as they read then
(profiles stay as read at start-up), and a refusal there settles the run without launching. Its result
is a `pi-agent-result/2` refusal whose `session` and `artifacts` are null, while
its run document keeps the run's `session` and `artifacts.dir`: the run was
published, and its directory holds its evidence.

## Session

The run owns its session from the moment it is started, not from launch: a
queued run's session cannot be taken by another call, and a second run naming
it is refused `session-busy`. The session is released when the run settles,
after `result.json` is written. Pass `session` back to a later call to continue
the conversation once the run has settled; a lane cannot chain several runs on
one session.

## Version and compatibility

`pi-run-handle/1` is new in this release. Its Task fields follow the MCP task
extension verbatim; the extras are quotient's. Renaming, removing or retyping a
field, making a non-nullable field nullable, or changing the Status table mints
`pi-run-handle/2`. `statusMessage` is prose for a person: read `status` and
`state`, never parse the message.
