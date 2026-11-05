# IDE-009: Per-root capability: a policy root states read or write, enforced by the server

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->
Let a policy root state its capability, so one server can grant `rw` on one root
and `ro` on another.

Needed by flakes:IDE-010, a dedicated jail whose quotient orchestrator delegates
into a declared list of other repos, each marked `ro` or `rw` (flakes:IMP-066,
operator, 2026-11-05).

Today it cannot be expressed. In `quotient-policy/2`, `roots` is a flat allowlist
and `profiles` pins each profile to a capability for the whole policy. Approvals
are per root and capability, but they select project forms; they grant nothing.
The relay's `ro` mode works by removing write profiles from the whole policy.

The alternative is two relay sockets with one policy each: two MCP registrations,
and calls differ by tool name. The rule belongs with the policy, where the server
enforces it.

Questions:

1. Shape: a root as an object, or a separate `read_roots` list? Either grants
   differently from `quotient-policy/2`, so is it `quotient-policy/3`, or additive?
2. A new refusal for a write profile at a read root, or `root-not-allowlisted`?
3. How does it interact with a project form's approval for the same root?
