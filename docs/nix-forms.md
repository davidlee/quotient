# Building forms with Nix

quotient confines every delegate with a *form*: an executable that runs one pi
process in a jail. quotient ships no forms, and
[`form-1.md`](contract/form-1.md) is what one must guarantee. On Linux, the
quotient flake also carries an optional Nix library function that builds a pair
of them — a read form and a write form — over the public
[jail.nix](https://git.sr.ht/~alexdavid/jail.nix) combinator library. This is
that builder's manual.

Two functions:

- `quotient.lib.mkFormFamily` builds a *family*: `read`, `write` and a
  `baseline` for comparison, from your nixpkgs, your jail.nix and your pi.
- `quotient.lib.checkFormFamily` builds a Nix check that reads a family's text
  and refuses it if it departs from the contract. It launches nothing.

The builder is Linux only, because bubblewrap is; the check follows whatever
family it is given. Neither adds a flake input to quotient: you supply `pkgs`,
`jail-nix` and `pi`.

## 1. What it builds

A family carries:

| | what it is |
|---|---|
| `read` | `bin/<prefix>-read`: the form for a read profile |
| `write` | `bin/<prefix>-write`: the form for a write profile |
| `baseline` | `bin/<prefix>-baseline`: a launcher with no root bind, no session bind and no `--chdir`, for comparison only |
| `bwrap` | the empty-environment `bwrap` wrapper every launcher execs |
| `exposure`, `protect`, `secretEnvNames`, `network`, `prefix` | what the policy and the check need to know about the family |

Each form is a small wrapper that validates the session directory the server
hands it and execs a launcher built by jail.nix. The launcher builds bwrap's
arguments, and jail.nix appends the isolation flags. The baseline is a launcher
without the form wrapper and without the three permissions that make a form, but
it still carries the state mask and any secret descriptor: run it to compare
with a form, never as a policy form.

The `baseline` exists so the check can subtract it: whatever a form's bind set
has over the baseline's must be exactly the root bind and the session bind. It
is not a weaker form to fall back on.

## 2. A minimal consumer

<!-- example: consumer -->
```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    quotient.url = "github:davidlee/quotient";
    jail-nix.url = "sourcehut:~alexdavid/jail.nix";
    # Any source of pi: what the builder needs is a derivation with bin/pi.
    pi.url = "github:earendil-works/pi";
  };

  outputs =
    { self, nixpkgs, quotient, jail-nix, pi }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      family = quotient.lib.mkFormFamily {
        inherit pkgs jail-nix;
        pi = pi.packages.${system}.default;
      };
    in
    {
      # Named after the forms themselves, so an attribute and the executable a
      # policy names read the same.
      packages.${system} = {
        quotient-read = family.read;
        quotient-write = family.write;
      };

      # `nix flake check` runs this over the family's text.
      checks.${system}.quotient-forms = quotient.lib.checkFormFamily {
        inherit pkgs family;
      };

      # What the policy's `exposure` list must say. Empty here, because this
      # family names no `exposure` and no `persistHome`:
      #   nix eval --json .#exposure
      exposure = family.exposure;
    };
}
```

Nix warns `unknown flake output 'exposure'` about that attribute. The warning is
harmless: `nix eval --json .#exposure` still prints the list.

Install the two forms where the policy will name them:

```sh
mkdir -p ~/.local/state/quotient/forms
nix build -o ~/.local/state/quotient/forms/read .#quotient-read
nix build -o ~/.local/state/quotient/forms/write .#quotient-write
```

Each `-o` link points at a store path, so the executable is
`~/.local/state/quotient/forms/write/bin/quotient-write`. The state directory
holds the server's *protected stores*
([`quotient-policy-2.md`](contract/quotient-policy-2.md), Protected stores): the
jail masks it (see 5), and the server refuses a call whose root contains the
session home or the run directory, which live in it, so a delegate neither sees
nor replaces the forms it runs under.

## 3. Pointing a policy at it

Name the two forms by absolute path:

```json
"forms": {
  "read": "/home/operator/.local/state/quotient/forms/read/bin/quotient-read",
  "write": "/home/operator/.local/state/quotient/forms/write/bin/quotient-write"
}
```

A family that binds host paths read-write must declare them. The family's
`exposure` is that list, and the policy's `exposure` is where it belongs: the
check refuses a read-write bind a family does not report, and the server treats
every entry as writable when it decides whether a call's view reaches a
protected store. Print the list with `nix eval --json .#exposure` in the flake
above. The root and the session directory are not in it: the server knows about
them.

A project may substitute its own form for its root. Build the family, link the
capability's executable at `<root>/.quotient/forms/<capability>`, and approve it:

```sh
ln -s ~/.local/state/quotient/forms/write/bin/quotient-write <root>/.quotient/forms/write
quotient allow                          # what the link resolves to, and the command
quotient allow <root> write=<realpath>@<sha256>
```

**Every rebuild that changes the output is a new form.** `nix build` gives it a
new store path, and the approval pins the executable's real path and the sha256
of its bytes, so the identity to approve with `quotient allow` is that pair.
After such a rebuild, `quotient allow` must record the new one; until it does,
the root refuses, naming both identities. A rebuild that changes nothing keeps
its identity, and its approval stands.

## 4. Arguments

The builder takes these in this order. The paths it binds are absolute —
`exposure`, `protect`, `persistHome` — and a relative one fails evaluation; a
`piFiles` key is a path inside the jail, so it is relative on purpose.

### `pkgs`

Your nixpkgs. The builder is not per-system: it reads the system from `pkgs`,
and asserts at evaluation that the system is Linux. On anything else it fails
with:

```
quotient form families need bubblewrap, which quotient only wires on Linux; this is <system>
```

### `jail-nix`

The jail.nix flake, or its `lib`. The builder instantiates the jail itself, with
its own bubblewrap, so a family cannot be handed a jail that keeps an
environment.

### `pi`

A derivation with `bin/pi`. The form runs this inside the jail; it is not
installed on the host by the builder.

### `prefix` (default `"quotient"`)

Names the forms and the launchers: `bin/<prefix>-read`, `bin/<prefix>-write`,
`bin/<prefix>-baseline`. It must be a safe filename component, matching
`^[A-Za-z0-9][A-Za-z0-9._-]*$`:

```
mkFormFamily: prefix must match ^[A-Za-z0-9][A-Za-z0-9._-]*$, got "<prefix>"
```

### `packages` (default `[]`)

Derivations added to the delegate's `PATH`, which holds coreutils, your packages
and `/bin`. pi is not on it: the launcher execs pi by absolute store path, with
its closure bound at runtime. Add what the delegate's shell needs.

### `options` (default `c: [ ]`)

A function of jail.nix's combinator set: your own jail permissions. The
builder's own permissions go in one `defer`, which lands after every option of
yours — including one you defer yourself — so nothing you add here can cover the
root bind, the session bind or the state mask. `ro-bind`, `rw-bind` and `tmpfs`
are the ordinary ones. `set-env` and `unsafe-add-raw-args` write words onto
bwrap's line where they sit, and the check reads them there, as bash would;
`add-runtime` runs shell code at launch, which the check cannot read. 6 says
what is unchecked. `add-cleanup` is refused at evaluation: a cleanup hook makes
jail.nix run bwrap under a trap instead of exec'ing it, and the form must exec
it so the child dies with the server.

```
mkFormFamily: options cannot use add-cleanup: …
```

### `env` (default `{ }`)

`VAR = "literal"` pairs that reach the delegate's environment. Their values
appear on bwrap's argument list, which the delegate can read at
`/proc/1/cmdline` in the jail, so this is for configuration and not for
credentials. The builder sets `LANG` (`${LANG:-C.UTF-8}`) and `TERM` (`dumb`)
ahead of your entries, which replaces the jail.nix base's forwarding of the two
and is what lets a server started without a terminal launch at all. A name you
set here replaces the builder's.

Two names are not yours: `HOME`, which is forwarded from the server and is where
the jail builds the home, and any `QUOTIENT_*` variable, which is the server's
namespace. Either, in `env` or `secretEnv`, fails evaluation:

```
mkFormFamily: env and secretEnv must not name HOME or a QUOTIENT_ variable: <NAME>
```

A value may not contain `$`. The launcher writes it as a single-quoted literal,
where a `$` is almost always a mistake, so the builder refuses it by name rather
than leave the build to fail on the generated script:

```
mkFormFamily: env values and protect paths cannot contain $: env <NAME>
```

A value that needs expanding at launch belongs in `secretEnv`.

Nor may a value, or a `persistHome`, `exposure` or `protect` path, contain a
newline. The form-family check reads the launcher a line at a time, so the
builder refuses it by name:

```
mkFormFamily: env values and host paths cannot contain a newline: env <NAME>
```

### `secretEnv` (default `{ }`)

`VAR = "<shell expression>"` pairs, evaluated in the launcher at launch, outside
the jail, and handed to bwrap as arguments read from a file descriptor
(`--args`), so the value never appears on bwrap's own command line, which is
what the jail shows at `/proc/1/cmdline`. The value must be an expression that
expands — the builder refuses a literal at evaluation, because the launcher
lives in the world-readable Nix store:

```
mkFormFamily: secretEnv <NAME> must be a shell expression containing $, not a literal
```

Each name must be a POSIX identifier. A value that is empty after evaluation
refuses the launch before pi starts:

```
<prefix>: secretEnv <NAME> is empty
```

A failing expression refuses it too, through `set -e`. With `secretEnv = { }`
none of this is emitted. See 7.

### `exposure` (default `[ ]`)

Absolute host paths the delegate may write, bound writable at their own paths.
The family reports them in `exposure`, and the policy must list them (3). They
are applied before the root bind, so an `exposure` path inside the root is
covered by the root's read-only bind under `read`.

### `protect` (default `[ ]`)

Absolute paths to mask: the builder mounts a private tmpfs over each, so the
delegate cannot read what was there. Use it for a session home or run directory
you moved off the default (see 6).

`protect` takes **directories**. A path that exists and is not a directory fails
the launch before bwrap, naming the path:

```
quotient: protect path <path> is not a directory
```

A path that does not exist on the host at launch is skipped — there is nothing
to reveal — so the same family launches on hosts where the path is absent.
`protect` has no effect inside the root: the mask is applied before the root is
bound, and the later bind at the root shows the real directory again. A path
may not contain `$`, for the reason `env` values may not.

### `piFiles` (default `{ }`)

`"<path under ~/.pi/agent>" = <file or directory>`; each is bound read-only in
the jail, after the state mask and after every option of yours, a deferred one
included, so neither a persisted home nor an option can cover it. Keys are
relative and may not climb out (`..`), or evaluation fails. This is how pi's
`settings.json` and `models.json` reach the delegate without being writable by
it.

A value is a Nix path (copied into the store), a derivation, or a string naming
a path in the store (`"${drv}/share/models.json"`). A plain string naming a host
path would be read from the host at every launch, so it is refused:

```
mkFormFamily: piFiles <key> must be a path or a derivation (or a string naming one in the store), …
```

### `persistHome` (default `null`)

An absolute host path bound writable onto `~`, created at launch if it does not
exist, and added to the family's `exposure`. `null` leaves jail.nix's private
tmpfs home, discarded when the run ends. Read 6 before turning this on: it is a
channel between runs.

### `network` (default `true`)

A shared network namespace plus the name-resolution files pi needs. `false`
keeps the namespace unshared, which suits a local model or a probe.

## 5. What the builder guarantees

These hold for every family, and no argument removes them:

- **The form's own guards.** The form takes the session directory as its first
  argument, refuses a missing one, a relative one and one that is not a
  directory (each with exit 64 and a message naming the prefix), exports it for
  the launcher only, and execs the launcher directly. bwrap's `--clearenv` drops
  the variable, so pi never sees a `QUOTIENT_*` variable.
- **The root is read-only for `read`, writable for `write`,** bound at its own
  canonical path, and nothing of yours can cover it: your options are applied
  first, and the builder's permissions come after them.
- **This call's session directory is writable at its own path**, in both
  capabilities. Every other session is masked with the state directory it lives
  in, and the server refuses a root that contains the session home (6).
- **The working directory is the root**, so a form's `cwd` is always the
  directory the call was admitted for.
- **The child dies with its parent** (`--die-with-parent`), so a killed server
  leaves no delegate behind.
- **A private temporary directory** (`--tmpfs /tmp`), discarded with the run.
- **No environment of the server's beyond four variables.** bwrap always runs
  under `env -i`, and pi sees only `HOME`, `LANG`, `TERM`, `PATH` and the
  variables you set (in `env` and `secretEnv`). No other variable of the
  server's reaches it, no `QUOTIENT_*` variable does, and not at
  `/proc/1/environ` either. This is not overridable.
- **Its own namespaces**: user, IPC, PID, UTS and cgroup, and the network one
  unless `network = true`.
- **The state mask.** A private tmpfs over
  `${XDG_STATE_HOME:-$HOME/.local/state}/quotient` and over each `protect` path
  that exists at launch, applied before the root bind, so other sessions and run
  evidence are unreadable whatever you bind in your options at their own path —
  and the check refuses a bind of them at any other (6). It stops at the root,
  which is why the server refuses a root that contains the session home or the
  run directory (6).
- **The mask, `piFiles`, the root bind, the session bind and the working
  directory are the last mounts the launcher makes.** They are emitted after
  every option of yours, a deferred one included, so no option can cover them.
  Only arguments delivered at runtime follow them, and those are yours to
  control (see 6).

The catalog of the launcher's argument order is worth one read, because it is
what makes the guarantees hold: jail.nix's base, then `LANG` and `TERM`, then a
persisted home, then the network, then your packages, options, environment and
exposure, then the mask, then `piFiles`, then the root bind, the session bind
and the working directory.

## 6. The caller's responsibilities

The builder is a guard against mistakes, not against you: you are the operator.
What you add is yours to get right.

- **What your options add at runtime is unchecked.** The check reads the
  launcher's bwrap line as bash reads it — quotes, empty arguments and spaces in
  a path included — but not what it expands at launch. Mounts delivered from a
  file descriptor (`--args`) or appended to bwrap's runtime list by
  `add-runtime` code are invisible to it, and so is the value of a source or
  target that is a variable inside double quotes. The runtime arguments are expanded last, after the builder's root and
  session binds, so a bind added there can cover them. Nothing stops you, and
  nothing checks you either.
- **The bwrap line must be plain words.** The check refuses a line bash would
  read as more than one command of words, or as words it cannot know until
  launch: an unquoted `;`, `&`, `|`, `<`, `>`, `(`, `)` or `#`, an unquoted `$`
  (an expansion bash would split, an ANSI-C or locale quote), an unquoted glob
  (`*`, `?`, `[`) or brace (`{`), a backtick outside single quotes, a `$(` or
  `$[` anywhere, a `${…}` that is more than a name, `name[@]` or a plain
  `name:-default`, and a `\$` or `` \` ``. Nor may a mount's path climb with
  `..` above `~` or a variable it starts from. jail.nix quotes everything it
  writes, so this meets only raw arguments of your own; single-quote them, and
  do not escape an operator with a backslash, which the check also refuses.
- **`/tmp` belongs to the jail.** The check refuses a mount at exactly `/tmp`,
  because a shared host `/tmp` would leak between runs. Binds below `/tmp` (an
  X11 socket, say) are allowed. A temporary directory that should survive a run,
  or be shared by the read and write delegates, is an `exposure` path bound
  beside `/tmp` with `env.TMPDIR` pointing at it. These are `mkFormFamily`
  arguments, merged with the rest of yours:

  <!-- example: tmpdir -->
  ```nix
  {
    exposure = [ "/var/tmp/quotient-delegates" ];
    env = { TMPDIR = "/var/tmp/quotient-delegates"; };
  }
  ```

- **A persisted home is a channel.** One `persistHome` serves both capabilities
  and every run of the family, so what a delegate writes to `~` shapes the next
  run and is visible to the other capability. Under the default private home,
  that state is discarded instead. Mount points the jail needs are created in
  whatever lies beneath the home, so with a persisted home you will see an empty
  `.local/state/quotient` directory and an empty, read-only placeholder for each
  `piFiles` entry (`.pi/agent/models.json`, say) appear there on the host.
- **A root must not contain the session home or the run directory.** The server
  refuses any root, read or write, that contains one
  ([`quotient-policy-2.md`](contract/quotient-policy-2.md), Protected stores), and
  both live in the state directory by default (`quotient/sessions`,
  `quotient/runs`), so a read root at `$HOME` is refused with
  `view-overlaps-protected`. What a read root may still contain is what a
  delegate may read anyway — the policy, the profile and help directories, the
  approvals store — and anything else in the state directory, such as the forms
  you installed there. The mask lands before the root bind and does nothing
  inside the root, so if you move the session home and run directory and root a
  read profile above the state directory, the delegate reads what is left there,
  read-only.
- **`protect` follows the state directory only.** The mask covers
  `${XDG_STATE_HOME:-$HOME/.local/state}/quotient`, expanded at launch from the
  server's environment, so `XDG_STATE_HOME` is followed. A policy that moves the
  session home or the run directory (`QUOTIENT_SESSION_HOME`, `QUOTIENT_RUN_DIR`)
  needs those directories in `protect` too, or the delegate can read other
  sessions and earlier runs. The subsection in 4 has what `protect` takes and
  where it stops.
- **Every read-write bind must be declared.** The check reads the baseline's
  binds and refuses one the family's `exposure` does not list. That includes
  `--dev-bind` and `--dev-bind-try`: a device bind is a read-write mount, and
  belongs in `exposure` like any other. A writable overlay (`overlay-rw`) writes
  to its upper and work directories on the host, so both belong in `exposure`.
- **Protected state stays where the mask is.** The mask covers the state
  directory and each `protect` path at their own paths. The check refuses a bind
  or overlay whose source is one of them, lies inside one, or contains one — `/`
  and `~` among them — at any other target, because the delegate would read
  every session and the run evidence there. It compares the paths as written,
  with `~`, `$HOME` and `$XDG_STATE_HOME` read as the home and the state home;
  a literal absolute path into your home is beyond it, and yours to avoid.
- **The jail is a host facility.** The forms need bubblewrap on the host and
  unprivileged user namespaces. Where those are missing a launch fails and the
  delegate never starts — and the text check still passes, because it launches
  nothing.
- **The model and the network are yours.** The builder fixes the confinement,
  not what the delegate can do inside it.

## 7. Credentials

The builder has no notion of a provider or a gateway. A gateway that needs a key
is three `mkFormFamily` arguments:

<!-- example: credentials -->
```nix
{
  env = { LLM_GATEWAY_URL = "https://gateway.internal/v1"; };
  secretEnv = { LLM_GATEWAY_KEY = "$(cat /run/secrets/gateway-key)"; };
  piFiles = { "models.json" = ./models.json; };
}
```

- the URL is an `env` literal, which may appear on bwrap's argument list;
- the key is a `secretEnv` expression, evaluated at launch outside the jail and
  handed to bwrap as arguments over a descriptor (`--args`), so it is not on
  bwrap's command line (the jail's `/proc/1/cmdline`) or on disk — the
  launcher's own bytes hold the expression, not the value;
- pi's `models.json` is read-only through `piFiles`.

A key that fails to evaluate, or that evaluates to nothing, refuses the launch
before pi starts; there is no unauthenticated retry and no fallback.

## 8. Verifying a family

`checkFormFamily` reads the family's form and launcher text and asserts the
contract against it. It launches nothing, because bwrap needs user namespaces a
Nix build sandbox does not grant, so it runs as an ordinary check — the one the
flake above carries (see 2):

```sh
nix flake check
```

New files must be added to git before a flake evaluation sees them. The check
receives the family's form paths, its baseline, `prefix` and `bwrap`, and the
policy it should be reading: `exposure`, `secretEnvNames`, **`protect`** and
`network`. So it can refuse a launcher that masks a path the policy does not
protect, or omits one it does. On success it writes a report to `$out`; on
failure it prints every failed assertion with the rule it breaks, the bind
residues in both directions, and a summary line, and exits non-zero. The
residues are printed on success too, so `nix log` shows what the text check
could not see.

Behaviour needs a real launch, which a Nix build cannot do. From a quotient
checkout, against a family built with a real pi and a reachable model:

```sh
scripts/hostile-audit --form <family>/bin/<prefix>-write --capability write \
                      --model <model> [--exposure <path>]... <root> <session-home> <run-dir>
```

It drives the real server over the real form, asks the delegate to write into
the run's own audit ledger, and passes only if the write could not land or the
call failed closed. Exit 0 is a pass, 1 a failure, 77 a missing prerequisite.
Run it for both `--capability read` and `--capability write`.

What these do not prove:

- **The text check proves arguments, not behaviour.** That the mounts behave as
  written is untested by it; only a launch shows that, and only on the host that
  launches.
- **It cannot see runtime binds.** Binds delivered through `--args` or
  `add-runtime` code, a mount whose path is a variable expanded at launch, and
  protected state bound again through a literal path into your home are printed
  as residues and otherwise unchecked.
- **One audit is one sample.** `hostile-audit` tests one protected store — the
  run's audit ledger — with one model, once. It is not a conformance test, and
  passing it does not establish the rest of the contract; the guarantees
  quotient does not verify are listed in [`form-1.md`](contract/form-1.md).
- **Neither runs on another platform.** There is no form family on Darwin: the
  builder fails at evaluation.
