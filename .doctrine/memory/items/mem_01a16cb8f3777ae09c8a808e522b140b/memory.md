Observed 2026-10-24 (SL-003 design run, doctrine at ~/.local/share/doctrine/bin):

- `doctrine design apply <SLICE> --input <json|path|->`. There is no `--payload`.
- A batch declaring inq-1..inq-10 where inq-10 `needs` inq-8 was refused
  with `Error: unknown node: inq-8`, although inq-8 was earlier in the same
  `declare` array. Splitting it (inq-1..9 first, then inq-10 at the next
  revision) applied cleanly. Earlier needs edges in the same batch (inq-3 →
  inq-2) did apply, so the trigger is unclear. If it recurs, declare the
  dependent node in a follow-up apply.
- Each apply needs the current `known_revision`; the result prints
  `revision N`, so chain applies on it.
- Disposing an inquiry: declare `cp-N` with `disposes: inq-N` and
  `dispose: {form: "create", kind: "decision", title, facet, acceptance}`.
  It mints an accepted DEC; `form: "non-durable"` takes a `note`.
