# IDE-008: Inherited confinement: quotient in an enclosing jail, delegates under the nested form family

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->
**Shape settled by DEC-071** (2026-11-05): a nested form, contrary to the original
wording below. Next step is in flakes; this item stays open for quotient's docs.

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

## From flakes:IMP-066 (2026-11-05)

Settled by flakes:DEC-122: the relay is off in every jail, and this item is the
intended route for single-repo quotient in jailed claude. Not blocking anything.

- **Weighting.** The operator is "not much concerned" about agents tampering with
  evidence, but wants it protected here. A grep of jailed pi and claude transcripts
  found no agent editing a transcript. So question 1's smallest mechanism wins;
  this is not an adversarial boundary. The host relay stays the answer where
  controls must bind an untrusted agent.
- **Why in-jail lost on 2026-10-30**, so answer these: nested bwrap inside the jail
  was unproven; policy roots are host paths while the jail sees `/workspace/<name>`;
  the LLM key was read from the host `$HOME`. Jails now have a gateway key.
- **Value to keep in a jail**: cross-harness calls with observability, orchestration
  and ceilings. Confinement is the jail's. Subagents already return final text and
  usage, so this must beat them.
- **Consumer side.** A real `quotient` on a jail's PATH makes `quotient reduce`
  work, so satan's `pi-report-test.sh` section 1 runs there (its guard is
  `command -v quotient`). dev-envs pins quotient 0.6.0; the host runs 0.6.1.

## Probes in a real jail (2026-11-05)

Satan's `jailed-shell`, launched from a throwaway directory. quotient 0.6.1 (the
release package, copied in), a static bubblewrap 0.12 (the jail has none), pi
through the jail's gateway key. Throwaway forms; no repo code changed.

Observed:

- Jail posture: `NoNewPrivs=1`, no seccomp, no capabilities, Landlock ABI 11.
  The home is a persistent jail home; `/nix/store` holds the jail's closure only,
  so bubblewrap must be added to it.
- **Nested bubblewrap works.** A form using `--tmpfs` over the evidence hid it. The
  real file stayed unread and unchanged, checked by content from outside, with
  and without `--unshare-pid`. `/proc/*/root` gave no route to it.
  `/proc/<outer pid>/root` was denied too.
- **Landlock works too**, also blocking the `/proc` route. It is an allowlist, so
  hiding one directory means listing its siblings, and node cannot call it, so it
  needs a helper binary as well.
- **End to end.** Real quotient ran in the jail with roots, policy and form all at
  `/workspace/...` paths: `read` and `write` calls completed, evidence was complete
  and `form_kind` was `confined`. No code change was needed.
  - Under `read`, `--ro-bind "$PWD" "$PWD"` refused a root write (`EROFS`).
  - Under `write`, the root was writable. The policy directory, bound read-only,
    refused a write under both.
  - The delegate's `ls` of the runs directory counted one line, which the `read`
    delegate reported as an `ls` error, not a listing.
- **Strict shape, end to end.** `--ro-bind / /`, with the root, session directory
  and `/tmp` writable: home and the jail's rw dep refused writes, the root accepted
  them. pi failed at first with `EROFS` taking lock directories in `~/.pi/agent`.
  A private tmpfs there, with `models.json` bound read-only, fixed it.

The 2026-10-30 objections: nested bubblewrap is proven. Roots being host paths does
not apply when the policy is written for the jail. The gateway key reached pi.

Inferred, not tested:

- The strict shape is a form-1 form with the jail as its host, so IDE-008 may need
  no new form type and no contract change.
- A form can bind only its delegate. The server must write its evidence, so the
  orchestrating agent in the same mount namespace and uid can reach it. Nothing
  short of the host binds that agent.
- A form does not receive `QUOTIENT_*`, so it must have the protected paths baked in
  (G10) or be told them by a new mechanism.
- Other jail profiles (`jailed-claude`, offline) are assumed to share this posture.

## Settled with the operator (2026-11-05)

1. **Write reach is form-1's, unchanged.** "Inherit" means the delegate reads what
   the jail can and writes only the root, the session directory, its private temp
   and `exposure` paths. A shared cache goes in `exposure`. G5 stands; no contract
   bend. Full inheritance of the jail's write reach was rejected.

## The existing form family, nested (2026-11-05)

`mkFormFamily` already provides what the throwaway form did: the state mask,
private home, `piFiles`, session bind, private `/tmp`, die-with-parent and the
`/proc/1/environ` fix. dev-envs already builds a family per project.

Observed: the host's machine family (`quotient-write`), run under quotient 0.6.1
inside the jail, on a scratch copy of the jail launcher with the form's closure
added as read-only binds. The run completed. The root was writable, the runs
directory hidden, the quotient config not visible, and `/workspace` showed only
the path to the root. So its read view is narrower than the jail's: "reads what
the jail can" above holds for a `--ro-bind / /` form, not for the family.

Two gaps, both flakes-side:

- **Fatal:** `quotientFormFamily` reads the key from
  `$HOME/.config/llm-gateway/keys/pi`, absent in the jail, which holds it only in
  `LLM_GATEWAY_KEY`. The run above used a scratch copy of the launcher taking the
  key from that variable.
- **The form's closure** is not in the jail's store; the probe bound it by hand.

Not fatal here: the launcher's `nix-store --query` finds no store database in the
jail and logs `path … is not valid` for `/etc/hosts`, `/etc/ssl` and the like. The
gateway call still worked. Direct TLS from a delegate was not tested.

Not tested: the `read` family form nested, a dev-envs per-project family, and
`hostile-audit` or `form-probe` in a jail.

This supersedes the inference above that a form must be told the protected paths:
the family masks the state directory from `XDG_STATE_HOME` at launch. A run
directory set elsewhere would need `protect`.
2. **A jail uses the existing form family**, with its narrow read view; a jail adds
   more through `options`. No new builder. This also answers question 4: no new
   form type, posture or reading of `unconfined`.
3. **The jail definition supplies policy and profiles**, generated into the store
   and bound read-only at `~/.config/quotient`. Ceilings in a jail are defaults:
   they bind delegates of the registered server and guard against mistakes, not
   against the orchestrator, which can start its own server. The docs say so.
4. **A jail's policy has `roots: ["/workspace"]`**, static, so it can live in the
   store. A delegate may be rooted in any repo the jail mounts, never beyond the
   jail's mounts. This goes beyond DEC-122's "single-repo" wording, so flakes:DEC-122
   needs a note that in-jail roots are limited by the jail's mounts.

**Agreed shape.** In-jail quotient is a jail configuration, not a quotient feature:
real quotient, the existing form family nested, and a store-generated read-only
policy. Protection binds delegates only. The item's opening line ("no nested form")
and its title predate this.

## Policy shape, probed (2026-11-05)

Observed, with the nested family form and quotient 0.6.1:

- Policy and profiles in one read-only jail mount, no approvals file: calls ran. An
  unwritable store means no `quotient allow` there, so machine forms only.
- `roots: ["/workspace"]` admitted a `write` call rooted in a read-only dep. The
  form's `--bind` did not widen it: the write failed `EROFS` and the dep was
  unchanged. A call in a writable directory succeeded.
- The probe chose its own config with `XDG_CONFIG_HOME`, so any agent in the jail
  can start a server under a policy of its own.

Inferred: a read-only policy binds delegates of the server the jail registers. It
does not bind the orchestrator, so in a jail ceilings are defaults, not controls.
