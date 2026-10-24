# IMP-004: Extract admission steps from callTool into a step pipeline

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

`callTool` (`src/server/server.ts`) runs admission steps 1–8 inline: 123
lines, complexity 20 (lint limit 8). Each step already returns
`{ ok, reason, detail }`; the obstacle to extracting step functions is the
`refuse` closure that records refusals. Raised by an architectural pass
during SL-002 planning (pi review run `/home/david/.local/state/quotient/runs/run-20261024T025156710Z-5-07a47624d093`); deferred because SL-002's
shared form-resolution function leaves step 5 a few lines.

## Desired outcome

Steps as functions of the shape
`Step<T> = ({ ok: true } & T) | { ok: false; reason; detail }`, recording
left in `callTool`. Revisit when admission grows further or a step needs
context beyond (admission, snapshot, request).
