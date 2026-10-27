# `pi-agent-wait/1`

The document `pi_agent_wait` and `pi_agent_cancel` answer: the state of a set
of runs, each as a run document (`pi-run-handle/1`,
`docs/contract/pi-run-handle-1.md`), with its `pi-agent-result/2` document
(`docs/contract/pi-agent-result-2.md`) when it has settled and it was asked for.
Normative: a change that breaks it mints `pi-agent-wait/2`, and this contract
stays alongside.

## The envelope

A `tools/call` of `pi_agent_wait` or `pi_agent_cancel` answers with an MCP tool
result: one `text` content item whose text is a JSON document.

- **Answered:** the document is `pi-agent-wait/1`, and `isError` is `false`. A
  wait answer is never an error because of the runs inside it: a failed,
  cancelled or lost run is reported, not raised.
- **Refused:** the document is a `pi-agent-result/2` refusal, and `isError` is
  `true`. The only refusal is `request-invalid`: the arguments are not
  well formed, or an id fails the run-id grammar. Nothing is waited on, and a
  refused cancel cancels nothing.

A client tells the two apart by `schema`. In the modern protocol era the tool
result also carries `resultType: "complete"`.

```json
{
  "schema": "pi-agent-wait/1",
  "until": "all",
  "timed_out": false,
  "truncated": false,
  "runs": [
    {
      "taskId": "run-20261026T120301123Z-7-3f9a0c1d2e4b",
      "status": "completed",
      "statusMessage": "completed",
      "createdAt": "2026-10-26T12:03:01.123Z",
      "lastUpdatedAt": "2026-10-26T12:04:12.480Z",
      "ttlMs": null,
      "pollIntervalMs": 2000,
      "state": "settled",
      "lane": "build",
      "key": null,
      "session": "9c0f2b6e4d1a4c8e9f7b3a5d2c1e0f4a",
      "artifacts": {
        "dir": "/var/lib/quotient/runs/run-20261026T120301123Z-7-3f9a0c1d2e4b"
      },
      "status_only": false,
      "result": {
        "schema": "pi-agent-result/2",
        "state": "completed",
        "final": true,
        "…": "…"
      }
    },
    {
      "taskId": "run-20261026T120302001Z-8-77aa01bc9d10",
      "status": "working",
      "statusMessage": "queued in lane build behind run-20261026T120301123Z-7-3f9a0c1d2e4b",
      "createdAt": "2026-10-26T12:03:02.001Z",
      "lastUpdatedAt": "2026-10-26T12:03:02.001Z",
      "ttlMs": null,
      "pollIntervalMs": 2000,
      "state": "queued",
      "lane": "build",
      "key": null,
      "session": "4b1e0c9d8a7f6e5d4c3b2a1908f7e6d5",
      "artifacts": {
        "dir": "/var/lib/quotient/runs/run-20261026T120302001Z-8-77aa01bc9d10"
      },
      "status_only": true,
      "result": null
    }
  ],
  "unknown": ["run-20261024T080000000Z-1-aaaaaaaaaaaa"],
  "unreadable": []
}
```

(`"…": "…"` stands for the rest of a whole `pi-agent-result/2` document.)

## Fields

| path | type | nullable | meaning |
|---|---|---|---|
| `schema` | string | no | `"pi-agent-wait/1"` |
| `until` | string | no | the condition waited for: `all` or `any` |
| `timed_out` | boolean | no | `true` when `until` does not hold over the states this answer reports |
| `truncated` | boolean | no | `true` when at least one settled entry's readable result was left out for the byte budget |
| `runs` | array | no | one entry per target that is a run, in target order |
| `runs[]` | object | no | a run document (`pi-run-handle/1` without `schema`), plus the two fields below |
| `runs[].status_only` | boolean | no | `true` when the entry carries no result: results were not asked for, the run has not settled, its `result.json` cannot be read now, or the result did not fit the byte budget |
| `runs[].result` | object | yes | the run's `pi-agent-result/2` document itself — not a tool result, not a string; `null` exactly when `status_only` is `true` |
| `unknown` | array | no | the targets that name no run, in target order |
| `unknown[]` | string | no | a well-formed run id |
| `unreadable` | array | no | the targets whose evidence cannot be read now, in target order |
| `unreadable[]` | string | no | a well-formed run id |

Every key listed is always present.

- **An entry with a result** is settled, and its `status` and `statusMessage`
  are the ones its result gives by the Status table of `pi-run-handle/1`. The
  result is a complete, valid `pi-agent-result/2` — a refusal included: a
  queued run that re-admission refused at launch, or a `needs_success` run
  refused `lane-predecessor-failed`, carries its refusal here.
- **`unknown`** lists the ids that are well formed but name no run: this server
  holds no record and no evidence directory exists. They are not Tasks — there
  is nothing to report a status of — and they are still reported, never dropped.
- **`unreadable`** lists the ids of runs this server does not hold whose
  `result.json` exists but cannot be read or does not validate, or whose
  evidence directory or audit cannot be read, and that carry no recorded loss.
  Their status cannot be derived without the evidence, so they are not Tasks
  either: reporting one `working` could follow an answer that read it
  `completed`. A later wait re-reads them.

## Arguments

`pi_agent_wait`:

| argument | type | default | meaning |
|---|---|---|---|
| `runs` | array of run ids | — | the runs to wait on, each matching the run-id grammar |
| `lanes` | array of lane names | — | wait on these lanes' runs (Selection); each a name in the session-id grammar: 1 to 64 of `A-Za-z0-9._-`, alphanumeric at both ends |
| `until` | string | `"all"` | `"all"` or `"any"` |
| `timeout_s` | number | `45` | a non-negative finite number of seconds; `0` answers now. Capped (Timeout) |
| `status_only` | boolean | `false` | `true` makes every entry status-only |
| `budget_bytes` | integer | `65536` | a positive integer; capped at `1048576` without a word |

Any other field, or a value of the wrong shape, is refused `request-invalid`.

`pi_agent_cancel` takes `runs` (required) and nothing else; see Cancel.

## Selection

| `runs` | `lanes` | targets |
|---|---|---|
| omitted | omitted | every unacknowledged run this server started through `pi_agent_start` |
| given | omitted | exactly the named runs |
| omitted | given | each named lane's unacknowledged `pi_agent_start` runs, as of the wait's arrival |
| given | given | both |

- **The owned-run rule.** The two implicit selections — no selectors, and
  `lanes` — pick only runs started by `pi_agent_start` that are not yet
  acknowledged. A run started by a blocking `pi_agent`, or by `pi_agent` as an
  MCP task, is owned by its caller and is never an implicit target; it is still
  ordered by its lane.
- **Named runs are always reported,** whatever their origin or acknowledgement.
  An id this server does not hold — from before a restart, or from another
  server sharing the run directory — is resolved from its evidence directory;
  an id that resolves to nothing goes to `unknown`.
- An empty array selects nothing from its selector: `runs: []` with no `lanes`
  has no targets.
- A lane's membership is a snapshot taken when the wait arrives, read from each
  run's recorded lane: a settled, unacknowledged run is still selected by its
  lane, and a run started into the lane during the wait is not a target.
- **Order:** named runs in the order given, then the lanes' runs lane by lane
  in start order; a duplicate is dropped at its first position.
- With no selectors, `timeout_s: 0` and `status_only: true`, a wait is a
  listing: it answers at once with the state of every started run no one has
  acknowledged.

**Selection and acknowledgement are per server, not per caller.** There is no
caller identity over stdio: two callers sharing one server see, and can
acknowledge, each other's runs in the implicit selections. A caller running
alongside others waits on the ids it holds.

## The condition

A target is *done* when it is `settled` or `lost`, or its id is in `unknown`.
It is not done when it is `queued`, `running` or `foreign`, or its id is in
`unreadable`. `until: "all"` holds when every target is done; `until: "any"`
when at least one is. A wait with no targets holds at once.

The wait returns when the condition holds, when its timeout passes, or when its
own call is cancelled. Runs this server holds wake it when they settle; a
foreign or unreadable target is re-read from disk every `pollIntervalMs` (2 s)
until it is done, and only while it is waited on.

When the answer is built every target is resolved again, and `timed_out` is the
condition over those states: an answer whose targets all turned done in the
last instant reports `timed_out: false`, and `timed_out` never contradicts the
entries. When the timeout passed first, the answer reports every target as it
is, with `timed_out: true`; the caller waits again.

## Timeout

`timeout_s` defaults to 45 s. Any value is capped at the policy's
`maxima.wall_clock_s` as read when the wait arrives; with no such maximum, or a
policy that cannot be read, at 900 s. A client whose tool calls time out should
ask for less than its own limit.

## The byte budget

A wait over many settled runs could return many full transcripts. The results
an answer includes are bounded by `budget_bytes`:

- The budget counts the UTF-8 bytes of the serialised `result` objects
  included. The envelope, each entry's run document and the `unknown` and
  `unreadable` lists are not counted.
- Entries are laid out in target order. A settled entry whose result reads is
  included when the running total stays within the budget; otherwise it is
  emitted status-only and `truncated` is set. A later, smaller result may still
  fit.
- **The first readable settled result is always included whole,** even when it
  alone exceeds the budget. So any result can be collected by waiting on its run
  alone, and every wait that finds a settled run with a readable result makes
  progress. One answer can therefore exceed `budget_bytes` by at most that one
  result.
- A settled run whose `result.json` cannot be read now is status-only, does not
  set `truncated`, and does not take the first-whole place.

A caller that sees `truncated`, or a status-only settled entry, waits again on
those ids. Results are collected at least once: a wait returns a settled run's
result every time it is targeted, so a lost reply loses nothing.

## What a wait changes

Nothing anyone can observe: not acknowledgement, not lanes, not keys, not runs.
That is why `pi_agent_wait` declares `readOnlyHint: true`, and why a client may
run it beside other calls. The one record it can leave is the attempts-ledger
line every refusal writes: a `request-invalid` wait is recorded there. A
cancelled wait call ends early, gets no reply, and leaves its runs untouched.

## Cancel

`pi_agent_cancel { runs }` stops runs and answers `pi-agent-wait/1` over them:

1. Every id is checked against the run-id grammar first; one malformed id
   refuses the whole call `request-invalid`, and nothing is cancelled.
2. Every named run this server holds is marked before anything is awaited, so
   no lane can launch a marked run while the call is under way.
3. A marked running run is stopped through its termination ladder with cause
   `cancelled`. A marked queued run is settled without launching, as a
   `pi-agent-result/2` with state and termination `cancelled`.
4. The call waits for every marked run to settle, then answers as a wait with
   `until: "all"`, results included within the default budget. Each run reports
   what it actually ended as: one that completed before the ladder reached it
   reports `completed`.

A run already settled or lost is reported as it is. No server cancels another's
run: a `foreign` target is reported `foreign` and not awaited. Ids in `unknown`
and `unreadable` are reported there and not awaited. Since `timed_out` is the
condition over the reported states, a cancel answer reports `timed_out: true`
exactly when a target is `foreign` or `unreadable`.

## Version and compatibility

`pi-agent-wait/1` is new in this release. Its entries follow `pi-run-handle/1`;
a change to that document's fields is a change to these entries. Renaming,
removing or retyping a field here, or changing what `timed_out`, `truncated` or
the budget mean, mints `pi-agent-wait/2`. The defaults and caps (45 s, 900 s,
65536 and 1048576 bytes) may change without a new version; a caller that
depends on one passes it explicitly.
