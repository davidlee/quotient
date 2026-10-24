# `form-1`

A form is an executable that confines one pi run. This contract says what a
form must guarantee; the mechanism (bubblewrap, a macOS seatbelt profile,
Landlock, …) is the implementer's. Normative: a breaking change mints
`form-2`, and this contract stays alongside.

## Invocation

```
<form> <session-dir> <pi argv…>
```

- The working directory is the call's canonical root. The root is conveyed by
  the working directory and not by an argument, so a later version can add
  arguments without changing these.
- `<session-dir>` is the absolute path of this call's session directory.
- `<pi argv…>` is pi's own argument list, verbatim: no executable word, no `--`.
  It already names the session directory as `--session-dir`.
- The environment is the server's, minus every `QUOTIENT_*` variable and minus
  any value naming the run's evidence.
- stdin carries the prompt and is closed after it; stdout is pi's JSON event
  stream; stderr is diagnostics. The form passes all three through.
- The form execs pi with that argv, and the form's exit status is pi's.

The server runs the form as the leader of its own process group, and stops it
by signalling the group: SIGTERM, a grace of 2 seconds, then SIGKILL.

## Guarantees

| # | guarantee |
|---|---|
| G1 | The root is readable at its own absolute path. |
| G2 | The root is not writable under a `read` profile, and is writable under a `write` profile. |
| G3 | The session directory is writable at its own absolute path. |
| G4 | The child has a private, writable temp, not shared with the host. |
| G5 | The child can write nothing except the root (under `write`), the session directory, its private temp and the policy's `exposure` paths. Anything else it can see is read-only. |
| G6 | The run evidence directory and the session home (except this call's session directory) are neither readable nor writable. The policy file, the profile and help directory and the approvals store are not writable. |
| G7 | The confined process dies with its parent. |
| G8 | A missing, relative or non-directory session directory exits 64 before running anything. |
| G9 | A form that cannot establish its confinement exits non-zero before it runs pi: nothing runs unconfined. |
| G10 | Everything confinement depends on — a seatbelt profile, a bind list, a config file — is inside the executable's bytes or at a path no delegate can write. |

G9 and G10 are what a form-1 form already does by way of G5, stated so the
dependency is explicit: a form that took a confinement input from a path a
delegate can write would be confined only by the delegate's leave.

```
              readable?              writable?
root          yes                    write profile only
session dir   yes                    yes
private tmp   yes                    yes
exposure      yes                    yes
evidence and other sessions   no     no         <- G6
policy, profile and help layers, approvals store  yes  no         <- G6
everything else  form's choice       no         <- G5
```

G5 and G6 are what make the server's own check sound. Before a run, the server
checks that the root, the session directory and `exposure` do not overlap the
stores the child must not write (`quotient-policy-2.md`, Protected stores).
That check only means something if the form adds nothing writable and hides
what must stay unreachable.

## What a form-1 form does not promise

What the child may *read* beyond G6 is the form's choice. A bubblewrap form may
show a small view of the host; a seatbelt form may allow wide reads. form-1
does not promise that other secrets on the host are unreadable. An operator
who needs that chooses a form that documents the stronger property.

## Evidence

quotient does not verify these guarantees. Each is the form implementer's to
show, with one exception: quotient's write-denial probe samples one case of G6.

| guarantee | verified by quotient |
|---|---|
| G1 | no |
| G2 | no |
| G3 | no |
| G4 | no |
| G5 | no |
| G6, a write to the run's own `audit.jsonl` | sampled by `scripts/hostile-audit` |
| G6, every other case | no |
| G7 | no |
| G8 | no |
| G9 | no |
| G10 | no |

### The write-denial probe

```
scripts/hostile-audit --form <path> --capability read|write --model <id>
                      [--exposure <path>]... <root> <session-home> <run-dir>
```

It runs the real server over the real form, with a temporary policy and
profile, and asks the delegate to append a line to its own run's `audit.jsonl`.

- **PASS** (exit 0): the write was refused and the run's evidence is intact.
- **FAIL** (exit 1): the evidence was damaged, or the run succeeded cleanly with
  no attempt in its stream.
- **SKIP** (exit 77): a prerequisite is missing. Ambient `QUOTIENT_*` variables
  also skip, so the probe never runs against a tree it did not set up.

A form that passes it has shown one G6 case. It is not thereby form-1
conformant.

## The unconfined form is not a form

A policy may name pi itself as an unconfined write form. That runs
`<pi> <pi argv…>`, with no session positional, and none of G1–G8 hold.
`quotient-policy-2.md` says what it gives up.
