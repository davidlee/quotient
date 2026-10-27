# `pi-agent-ack/1`

The document `pi_agent_ack` answers: one verdict per run id. Normative: a
change that breaks it mints `pi-agent-ack/2`, and this contract stays
alongside.

## What acknowledgement is

Acknowledging a run removes it from the implicit selections a wait makes — a
`pi_agent_wait` with no selectors, or with `lanes`
(`docs/contract/pi-agent-wait-1.md`). Nothing else: an acknowledged run stays
addressable by id, a wait naming it still reports it with its result, and its
evidence is untouched. A named wait does not need acknowledgement; ack is there
for recovery, so that a caller that lost its ids can find, with a selector-less
wait, only the runs nobody has dealt with yet.

Acknowledgement belongs to the server process, not to a caller: there is no
caller identity over stdio, so any caller of the same server can acknowledge
any of its runs, and a new server knows no acknowledgement.

## The envelope

A `tools/call` of `pi_agent_ack { runs }` answers with an MCP tool result: one
`text` content item whose text is a JSON document.

- **Answered:** the document is `pi-agent-ack/1`, and `isError` is `false`,
  whatever the verdicts.
- **Refused:** the document is a `pi-agent-result/2` refusal
  (`docs/contract/pi-agent-result-2.md`), and `isError` is `true`. The only
  refusal is `request-invalid`: `runs` is missing or not an array of strings, a
  field other than `runs` is present, or an id fails the run-id grammar of
  `pi-run-handle/1` (`docs/contract/pi-run-handle-1.md`). The request is checked
  whole before any acknowledgement applies, so a refused ack acknowledges
  nothing.

A client tells the two apart by `schema`. In the modern protocol era the tool
result also carries `resultType: "complete"`.

```json
{
  "schema": "pi-agent-ack/1",
  "runs": [
    { "taskId": "run-20261026T120301123Z-7-3f9a0c1d2e4b", "acknowledged": true },
    { "taskId": "run-20261026T120302001Z-8-77aa01bc9d10", "acknowledged": false, "reason": "not-settled" }
  ]
}
```

## Fields

| path | type | nullable | meaning |
|---|---|---|---|
| `schema` | string | no | `"pi-agent-ack/1"` |
| `runs` | array | no | one verdict per id, in request order |
| `runs[].taskId` | string | no | the id, as the request gave it |
| `runs[].acknowledged` | boolean | no | `true` when the run is now acknowledged |
| `runs[].reason` | string | no | present only when `acknowledged` is `false`: a token of the Reasons table |

## Verdicts

A run in a terminal state this server holds — `settled` or `lost` — is
acknowledged. A lost run can be acknowledged: it has no result to collect, and
acknowledging it is how a caller says it has dealt with it. Acknowledging an
already acknowledged run answers `acknowledged: true` again: ack is idempotent.

## Reasons

| reason | meaning |
|---|---|
| `not-settled` | this server holds the run and it is not terminal: `queued` or `running` |
| `unknown` | this server holds no record of the run: an id that names nothing, and any run resolved from its evidence directory — settled, lost, foreign or unreadable — started by another server or before a restart |

A run this server does not hold can never be acknowledged: acknowledgement is
held by the server that started the run. A caller that waits by name drops a
run's id once it has used the result, whatever `ack` answered.

## Version and compatibility

`pi-agent-ack/1` is new in this release. A later build may add a reason to the
Reasons table without minting a new version: a consumer must read a reason it
does not know as "not acknowledged". Renaming, removing or retyping a field, or
changing what acknowledgement removes a run from, mints `pi-agent-ack/2`.
