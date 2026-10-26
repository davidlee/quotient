# RSK-003: Session locks judge liveness by pid and start time across pid namespaces

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

`observeLiveness` (`src/server/session.ts`) reads a pid missing from this
server's `/proc` as `stale`. So a session lock held by a live server in another
pid namespace, or on another host sharing the session store, can be judged
stale and taken over.

SL-004 (DEC-067 as amended 2026-10-26) adds boot id, pid-namespace id and
hostname to a run's owner, and an `ownerLiveness` rule — but for run resolution
only; session locks keep today's rule. Follow-up: judge session-lock staleness
with `ownerLiveness` too.
