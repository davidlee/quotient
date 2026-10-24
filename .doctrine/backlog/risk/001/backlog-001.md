# RSK-001: Unapproved project form link hashed synchronously in full before approval check

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

`probeProjectForm` (src/server/forms.ts, `digestOf`) does
`sha256Hex(readFileSync(real))` on the project form link's target before the
approval is consulted. The link target is any executable outside the writable
paths, so a delegate that can plant `<root>/.quotient/forms/<cap>` pointing at a
multi-GB binary makes every call in that root block and buffer the whole file
just to refuse `form-unapproved`. Options: stream the digest, or cap the size
(a policy the SL-002 design does not state). Raised by the PHASE-04 review.
