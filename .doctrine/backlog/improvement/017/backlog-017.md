# IMP-017: Tool results carry structuredContent and declare outputSchema

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

Source: field notes from Nemesis SL-024 and Malebolge (`nemesis-meta.local.md` § Tooling improvements); code checked at 0.6.1 on 2026-11-21 (recon `run-20261121T031456215Z-1-1772b2f8f56b`, key lines re-read by the orchestrator).

Tool results are JSON text only (`src/server/documents.ts:86`); `tools/list`
declares no `outputSchema` (`src/server/server.ts:462`). The other half of
the field note (shared guide repeated in every tool description) is already
fixed: the profile table renders once, in the server instructions
(`src/help/help.ts:314`, pinned by `src/help/help.test.ts:452`).

## Proposal

Where the client negotiates a protocol version that supports it, return
`structuredContent` with the same document and declare `outputSchema`. Keep
the text content for older clients.
