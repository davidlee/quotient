# `quotient-approvals/1`

The operator's record of which form identity runs for a project root and a
capability. One store per host, at a fixed path, written only by
`quotient allow` and `quotient revoke`. This contract covers the file, what an
entry governs, and what those two verbs promise.

An approval is not a permission. The policy already decides whether, where and
how a call may run; an approval only decides **which executable** of a
capability's machine form is run inside one root, and it never widens anything the
policy grants.

## Where it is

| path | holds |
|---|---|
| `<xdgConfig>/quotient/approvals.json` | every recorded approval |

- `<xdgConfig>` is the value of `XDG_CONFIG_HOME` when it is absolute, else
  `$HOME/.config`, as in `quotient-policy/2`.
- No environment variable moves the store, and no delegate can write it. A host
  with neither an absolute `XDG_CONFIG_HOME` nor an absolute `HOME` has no
  usable store, and a call that would need to read one is refused rather than
  given a default.
- The store is optional. An absent file is an empty store, and a server with an
  empty store runs the machine's forms exactly as a server that has no such
  store always did.
- The store is read on every call that reaches form selection, so recording or
  revoking an approval applies to the next call. Nothing waits for a restart.

## Format

One JSON object. The format is closed-world: the keys below are the whole of it,
at the top level and inside every entry. Anything else makes the store malformed.

```json
{
  "schema": "quotient-approvals/1",
  "approvals": [
    {
      "root": "/home/operator/work/satan",
      "capability": "write",
      "path": "/nix/store/9f2c8d1a2b3c4d5e6f708192a3b4c5d6-quotient-write/bin/quotient-write",
      "sha256": "015d8525091cab07a98291a1d7368a5d80b1367bd5f0ecc7e931400a6ad4b7fd",
      "approved_at": "2026-10-24T05:12:44.000Z"
    }
  ]
}
```

| field | type | meaning |
|---|---|---|
| `schema` | the string `"quotient-approvals/1"` | the schema this document is written against; any other value makes the store malformed |
| `approvals` | array of entries | the recorded approvals, at most one per root and capability |
| `root` | a canonical absolute path string | the canonical roots entry the approved form matched when it was recorded; keyed by root, so a store entry outlives the `roots` entry it was recorded under |
| `capability` | `read` or `write` | the capability the approval covers; a `read` approval never decides a `write` call |
| `path` | a canonical absolute path string | the approved real path of the form: the executable quotient runs, never the project's link |
| `sha256` | 64 lowercase hex characters | the digest of that file's bytes, as reviewed |
| `approved_at` | a string | when it was recorded, verbatim; quotient records an ISO 8601 UTC timestamp and never interprets one |

At most one entry per (`root`, `capability`). Two entries for one pair would be
two identities for one call, and the tie-break would be file order. A duplicate
makes the store malformed, and `quotient allow` replaces an entry rather than
adding a second.

`root` and `path` must be **canonical**: the path itself, with no trailing
separator, no `.` or `..` segment and no repeated separator, so that `path.resolve`
of the stored value returns it unchanged. `/work/one` and `/work/one/` name one
directory, and a store holding both would key one root twice, leaving the order of
entries to decide which identity runs. A non-canonical value makes the store
malformed, so it is refused rather than normalised — an entry nobody wrote in that
form is a store to fix.

## What an approval governs

An approval governs **by containment**: a call is governed by the entry for its
capability whose `root` is the deepest one containing the call's canonical root —
the directory the call physically runs in, after symlinks are resolved. It does
not matter how the call's `cwd` was spelled, and it does not matter whether
`root` is still listed in the policy's `roots`:

- an approval keeps governing after its root leaves the policy, so removing a
  root from the policy never silently reverts its calls to the machine default;
- an approval inside the call's root does not govern it, and neither does a
  sibling whose path merely shares a prefix (`/work/one` does not contain
  `/work/oneevil`).

A governed call runs exactly the recorded identity or is refused
`form-unapproved`; there is no fallback to the machine form. That includes the
case where the project's link is gone: a governed call with no link at the
approval's root is refused `form-invalid`, because a delegate that can write the
project must not be able to downgrade confinement by deleting a file. Only
`quotient revoke` returns a root to the machine default.

## `quotient allow`

```text
quotient allow [<path>]                             report, never writes
quotient allow <path> <capability>=<realpath>@<sha256>...   record
```

`<path>` defaults to the current directory and is resolved the way a call is:
against the machine policy, canonicalised, and matched to the longest `roots`
entry that contains it. A path inside no entry, or a policy that cannot be read,
exits 1 naming why. A malformed invocation exits 2 with `allow`'s own usage
line: an empty `<path>`, an identity that is not
`<capability>=<realpath>@<sha256>`, or one capability given twice.

**Report.** For each capability of the machine forms: what is at
`<roots entry>/.quotient/forms/<capability>`, what it resolves to, its digest,
which approval governs calls there now (which may sit at a shallower root than
the roots entry), the machine slot a project form would replace (`slot`:
confined with its extensions, unconfined with its `pi`, or none and why), and
the exact `quotient allow` command that would record what is shown. An absent
link shows the machine form that stands instead. A link that is not usable shows
the refusal's detail and contributes nothing to the suggested command. A
governing approval whose link is missing or changed says so and suggests
`quotient revoke`, and a deeper approval that would keep governing is printed as
an `advice` line with the revoke it needs — no record command is offered for
that capability, because recording would change nothing. When admission would
refuse a call at `<path>`, the block ends with `admission calls at <path> are
refused: <reason>`, so the report does not look settled while calls are refused;
the tail then says why nothing is offered (`nothing to approve: …`). The report
never writes, and exits 0 whenever it printed.

**Record.** Each `<capability>=<realpath>@<sha256>` is split at its last `@` (a
digest contains none) and checked again, inside the store's lock, against the
project's link at the roots entry and against the machine form:

- the form must be usable: the link must resolve to a regular file that is
  executable, and that file must lie outside every path a delegate admitted under
  the policy can write;
- the capability's machine form must be confined, since a form that is declared
  unconfined has no executable to substitute;
- the resolved real path **and** the digest must both equal the ones given;
- no deeper approval may govern — checked first, though listed last: an approval
  at a deeper root than the roots entry would keep deciding calls here, so the
  pair is refused with `read: the approval for /work/one governs calls at /work,
  so recording at /work would change nothing; run "quotient revoke /work/one"
  first`.

All of them or nothing: one failing pair in a batch writes nothing, and the
command exits 1 naming both identities — the one reviewed and the one that is
there now. The digest is the confirmation. The record is the exact identity that
was reviewed, and a form rebuilt with different bytes, or moved, must be
reviewed and recorded again.

## `quotient revoke`

```text
quotient revoke <approval-root> [<capability>...]
```

`<approval-root>` must equal a recorded `root` exactly, after making it absolute
and normalising it lexically. `revoke` reads neither the policy nor the
filesystem: an approval keeps governing after its root leaves the policy or its
directory moves or disappears, and resolving the argument as a path would reach a
different key — at worst a parent's approval. It removes that root's entries for
the named capabilities, or all of them when none are named, and never touches
another root's: revoking a child leaves a governing parent alone. A root or
capability with no recorded entry exits 1 and lists the stored roots, so a
mistyped root is never a silent success; with no store at all the message says
`stored roots: none` and nothing is created, because `revoke` reads before it
takes the lock. A malformed invocation exits 2 with `revoke`'s own usage line: no
`<approval-root>`, a capability other than `read` or `write`, or the same
capability twice.

Afterwards calls there are governed by whatever contains them: a shallower
approval if one does, else the machine form if no link remains, else
`form-unapproved` because a link is there and nobody approved it.

## Writing: one lock, one rename

The store has one writer, and it is `quotient allow` / `quotient revoke`, not
the server.

1. It creates `<store>.lock` exclusively (mode `0600`) and writes its pid there.
   If the lock already exists the command fails, naming the pid it holds and
   saying to remove it by hand if no `allow` or `revoke` is running. There is no
   automatic reclaim: the holder is an operator command, so a stale lock is the
   operator's to remove, and breaking another writer's lock on their behalf could
   resurrect an identity that writer replaced.
2. It reads the store under the lock. A malformed or unreadable store aborts the
   command; the store is never overwritten.
3. It reads back what the change returned through the same reader it reads a
   store with. A list this build would refuse — a duplicate pair, a
   non-canonical root — aborts the command, and the store is untouched.
4. It writes `<store>.<pid>.tmp` beside the store (mode `0600`) and flushes it.
   The temp name is cleared before it is created and created exclusively, so a
   file or link planted at that name is replaced rather than reused or written
   through.
5. It renames the temp file over the store, so a reader sees the old store or the
   new one and never half of either.
6. It removes the temp file on every path, including a failed rename, so no
   debris is left beside the store.
7. It removes the lock on every path, including a refusal and an error — but only
   while the lock still carries its own pid: a lock another writer has replaced is
   theirs to remove.

The lock is not a security boundary against an attacker: anyone who can write the
store's directory can write the store. It exists so two operator commands cannot
interleave, and so no writer resurrects an identity another writer replaced.

## A malformed store

A store that does not meet the format above — not JSON, not an object, the wrong
schema, an unknown key, a duplicate pair, a non-absolute path, an unknown
capability, a bad digest, a non-string timestamp — is **malformed**.

- Every call that would select a form is refused `form-unapproved`, naming the
  store's path and what is wrong with it. Whether an approval governs a call is
  itself the selection, so a call cannot be decided without the store; failing
  closed is the only answer that cannot run an identity nobody approved.
- `quotient allow` and `quotient revoke` refuse it too, and never overwrite it.
  The operator repairs or removes the file.
- A malformed store does not pre-empt a refusal that precedes it: a missing
  machine form still refuses `wrapper-unavailable`, and a profile whose tools the
  machine form cannot deliver still refuses `profile-invalid`.

## Approving is the operator's act

`quotient allow` records what the operator reviewed. Quotient cannot tell an
operator from an unconfined orchestrator that can run the same command, and does
not try: an orchestrator able to run `quotient allow` is trusted as the operator.
The digest argument is the confirmation, and there is no interactive prompt, since
an agent that can run the verb could answer a prompt too.

What the digest pins is the executable's bytes and nothing else. What the form
reads or executes when it runs — a seatbelt profile, a bind list, a config file —
is not hashed, so a form that depends on such an input must embed it or keep it
where no delegate can write it. Approved forms should be immutable to every
delegate on the host, not only to the delegates of the policy in force: a store
path is the easy way to get that. Deleting or repointing the project's link, or
corrupting the store, can stop calls in a root, but it cannot make an unapproved
identity run.
