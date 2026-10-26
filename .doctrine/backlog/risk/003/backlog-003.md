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

## Known limits of `ownerLiveness` (SL-004 PHASE-02 Codex pass, 2026-10-26)

Recorded at the user's direction, not pursued now. Detail: SL-004 notes.md
§ PHASE-02 execution.

- **Hostname is not machine identity (F1).** "Same hostname, different boot →
  `stale`" misfires for two machines with one hostname (e.g. `localhost`)
  sharing a run dir, or an nspawn container (its own boot_id) sharing the
  host's hostname: a live owner reads `stale`, its run a false `lost`.
- **Start time depends on the reader's time namespace (F2).** The kernel
  offsets `/proc/<pid>/stat` field 22 by the reader's time-namespace boottime
  offset, so same host/boot/pidns with different time namespaces reads a live
  owner `stale`. Session locks share this today. Inference from kernel source;
  not reproduced. Candidate fix: `ns/time` as a fourth identity component.
