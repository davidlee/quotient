# DEC-013: quotient allow refuses recording when a deeper approval governs the roots entry

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->

Context: SL-002 PHASE-05 review. Design sec-3 says recording "adds a deeper
approval that governs calls inside the roots entry", which assumes the governing
approval is shallower. A stored approval deeper than the roots entry (for
example, one left by an older roots list) governs the calls it covers, so a new
roots-entry approval would change nothing, yet `allow` reported success.

Decision: `quotient allow <path> …` refuses to record when the governing approval
is deeper than the roots entry, and names the `quotient revoke <deeper root>`
that would clear the way. The check runs under the lock, against the store it
read there. The report prints the same advice instead of an inert `allow`
command. Documented in `quotient-approvals-1.md` ("Record", fourth check) and
`quotient-policy-2.md`. The audit should reconcile design sec-3 with this.

Accepted 2026-10-24 by the operator at SL-002 reconcile (reply: "yeah agreed"), after the RV-009 audit found the shipped code and contracts consistent with it.
