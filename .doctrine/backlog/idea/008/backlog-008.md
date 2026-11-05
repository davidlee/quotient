# IDE-008: Inherited confinement: run inside an enclosing jail with no form, evidence still protected

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->
Run quotient inside an enclosing jail: no relay and no nested form, delegates
inheriting the jail's permissions, and the agents unable to tamper with quotient's
own evidence. The operator expects this to suit about 95% of already-jailed
delegation (flakes:IMP-066). The host stays the right place only when controls
must bind an agent that is itself untrusted.

Why nothing today fits:

- `{ "unconfined": … }` is write-only: `forms.read` cannot use it, because
  "there is no read capability without a form".
- It gives up every guarantee, including G6: the delegate "can read and write
  whatever the server's user can". Evidence is unprotected.
- A form-1 form needs nested confinement inside the jail, which was not tested.
- The relay (flakes `agents/quotient-relay.nix`) puts the server on the host.

Observed 2026-11-05: 0.6.0 in a bare `bwrap` sandbox, given its own policy,
profile and a stub form, with the home outside the root, passed admission and
failed at spawn on the stub. `view-overlaps-protected` compares paths; it fired
only when the root contained the home.

Questions:

1. Protection must be enforced, not asked for: the delegate shares the server's
   uid. What is the smallest mechanism? A thin form that hides the evidence
   directory, Landlock, or evidence written out of reach?
2. Is a read profile honest when the root is writable to the jail? "Read" then
   needs a real read-only view, or it must be refused.
3. Policy and profiles in the jail are agent-writable unless bound read-only. Who
   supplies them, and do ceilings mean anything otherwise?
4. Is this a new form type, a posture, or a second reading of `unconfined`?
