# DEC-072: Output documents are open to added fields: consumers ignore unknown fields

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->



## Note: the reader half (2026-11-21)

The rule above protects an old reader from a new field. It does not protect a new reader from an old document. The server reads results it did not write: `viewFromDisk` resolves any run id in the shared state directory, including runs from an earlier server or a concurrent one of another version. If the validator required the added fields, those results would read as `unreadable`. So the validator treats an absent added field (`ADDED_FIELDS` in `src/server/result.ts`) as `null`, `readResult` fills it in with `null`, and the contract says a reader takes absence as `null`. Writers still emit every field. The drift test holds them to the Fields table. Agreed with the user on 2026-11-21 (option 1).