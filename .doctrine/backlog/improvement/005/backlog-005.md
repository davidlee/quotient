# IMP-005: Group ChildViewInput protected stores into one field

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

`ChildViewInput` (`src/server/childview.ts`) carries root, sessionDir,
exposure, sessionHome, runDir, policyPath, profileLayers and helpLayers, each
threaded from `server.ts`. SL-002 adds `approvalsPath` (a ninth). Raised by
the SL-002 planning architectural pass (pi review run `/home/david/.local/state/quotient/runs/run-20261024T025156710Z-5-07a47624d093`).

## Desired outcome

Group the protected stores (`stores: { runDir, sessionHome, policyPath,
approvalsPath, profileLayers, helpLayers }`) so the next store is one field.
