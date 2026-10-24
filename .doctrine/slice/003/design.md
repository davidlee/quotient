<!-- doctrine:section sec-1 -->
## 1. Design Problem

quotient runs every delegate through a *form*: an executable that confines one pi run, named by the operator in the policy and specified by `docs/contract/form-1.md`. quotient ships the contract and no forms, so an operator on Linux today writes their own bubblewrap wrapper or falls back to the unconfined write form.

This slice adds two optional Nix library functions to the quotient flake. `quotient.lib.mkFormFamily` builds a *form family* — a `read` form, a `write` form and a comparison baseline — over the public `jail.nix` combinator library. `quotient.lib.checkFormFamily` builds a text-only conformance check for such a family, for the consumer's own `checks`. The design lifts satan's working family and check (`~/dev/satan/flake.nix:325-393`, `:691-`) and rebases them from satan's private agents flake onto `jail.nix` directly.

### Current and target behaviour

| | today | after this slice |
|---|---|---|
| forms | operator writes their own | operator may call `mkFormFamily`, or still write their own |
| conformance evidence | form-1 G1–G10 are the implementer's to show; `scripts/hostile-audit` samples one G6 case | a builder family also gets `checkFormFamily` (text) and, in quotient's own gate, a behavioural script probe |
| flake outputs | `packages`, `apps`, `devShells` | the same, plus a system-agnostic `lib` |
| server, npm package, policy schema, form-1 | — | unchanged |

quotient still ships no forms (DEC-014): `packages` stays the server only, and a policy still names a form by its executable path.

### Boundary

```mermaid
flowchart LR
  subgraph consumer["consumer flake (operator)"]
    call["mkFormFamily { pkgs, jail-nix, pi, … }"]
    chk["checks.forms = checkFormFamily { pkgs, family }"]
  end
  subgraph quotient["quotient flake: lib (this slice)"]
    mk["nix/form-family.nix"]
    cf["nix/check-family.nix + nix/check.sh"]
  end
  jn["jail.nix (caller-supplied)"]
  pol["policy.json forms.read / forms.write"]
  srv["quotient server (unchanged)"]
  call --> mk --> jn
  chk --> cf
  call -- "store paths" --> pol --> srv
```

The consumer supplies `pkgs`, `jail.nix` and pi (DEC-016), so quotient adds no flake input and a server-only consumer carries nothing new. The server never learns that a form came from the builder: it sees an executable path, as today.

### Threat model

The delegate is the adversary: it may try to widen its powers, choose what confines it, or edit the record of what it did (README, "Design and guarantees"). The operator is trusted but fallible, and is the builder's caller.

- What the builder fixes, it guarantees for every family, once. These are the form-1 settings a caller cannot remove (sec-2).
- What the caller adds (toolchain, jail options, environment, exposure) is the caller's. `checkFormFamily` catches the mistakes it can see in the launcher text and refuses them. It is not a defence against a hostile caller, and it cannot see binds delivered at launch through a file descriptor or `add-runtime` code (DEC-017).
- Reads beyond G6 stay the form's choice, as form-1 says; the builder shows the delegate only the Nix store closure, its home and what the caller binds.

### Governing decisions and evidence

- DEC-014: optional builder; still no shipped forms.
- DEC-015: `lib.mkFormFamily` / `lib.checkFormFamily`, taking `pkgs`; the family's shape.
- DEC-016: the caller passes `jail.nix` and pi; no quotient flake input.
- DEC-017: what the builder fixes, what the caller adds, the argument order, the check's refusals.
- DEC-018: private home by default; `piFiles` read-only; `persistHome` opt-in and declared.
- DEC-019: `env` and `secretEnv`; secrets fail closed and travel over a launch-allocated descriptor; network on by default.
- DEC-020: bwrap always runs with an empty environment.
- DEC-021: `checkFormFamily`'s assertions and negative controls.
- DEC-022: verification: test flake, script probe, real-pi audit, all in `just gate`.
- IMP-007 (accepted into this slice): the gate also builds the Nix server package.
- Evidence: `.doctrine/slice/003/research/research.md`; the adversarial review of DEC-014..022 is `research/raw/review-decs-014-022.md`.

<!-- doctrine:section sec-2 -->
## 2. The Builder: `mkFormFamily`

### Interface

```nix
quotient.lib.mkFormFamily {
  pkgs,                  # the consumer's nixpkgs; Linux only
  jail-nix,              # the jail.nix flake, or its lib
  pi,                    # a derivation with bin/pi
  prefix ? "quotient",   # forms are bin/<prefix>-read and bin/<prefix>-write
  packages ? [ ],        # toolchain on the delegate's PATH (add-pkg-deps)
  options ? (c: [ ]),    # extra jail.nix permissions; c is the combinator set
  env ? { },             # VAR = literal string; may appear on bwrap's argv
  secretEnv ? { },       # VAR = shell expression, evaluated at launch, never on argv
  exposure ? [ ],        # absolute host paths bound rw at their own path
  protect ? [ ],         # absolute paths to mask, beyond the default state dir
  piFiles ? { },         # "<path under ~/.pi/agent>" = file or directory, bound ro
  persistHome ? null,    # absolute host path bound rw onto ~, or null for a private home
  network ? true,        # false keeps jail.nix's network namespace unshared
}
=> {
  read, write,           # derivations: bin/<prefix>-read, bin/<prefix>-write
  baseline,              # the same jail without root, session or --chdir; for comparison only
  exposure,              # exposure ++ [ persistHome ] when set: what the policy's exposure must list
  prefix, secretEnvNames, network,
  bwrap,                 # the empty-environment bwrap wrapper the launchers must exec
}
```

`lib.mkFormFamily` is not per-system (DEC-015): it reads the system from `pkgs`. It asserts `pkgs.stdenv.hostPlatform.isLinux` with a message naming bubblewrap, so a Darwin evaluation fails at the call, not at launch. It instantiates `jail-nix.lib.extend { inherit pkgs; bubblewrapPackage = emptyEnvBwrap; }` itself (DEC-016, DEC-020), so a caller cannot hand it a jail whose bwrap keeps an environment. It accepts either the flake or its `lib` by using `jail-nix.lib or jail-nix`.

The operator installs the family's forms with `nix build -o <state>/forms/read .#…read`, giving the examples' layout, and copies `family.exposure` into the policy's `exposure`.

### Anatomy of a form

Each capability is two scripts, and the form execs the launcher directly: there is no chain of wrappers.

```mermaid
sequenceDiagram
  participant S as quotient server
  participant F as form (bin/quotient-write)
  participant L as launcher (jail.nix, writeShellApplication)
  participant B as bwrap via env -i
  participant P as pi (in the jail)
  S->>F: cwd = root; argv = session-dir, pi argv
  F->>F: three exit-64 guards; export QUOTIENT_ACTIVE_SESSION_DIR
  F->>L: exec launcher "$@"
  L->>L: caller runtime; quotient_root=$(pwd -P); secrets → fd
  L->>B: exec env -i bwrap <args> --args $fd -- pi "$@"
  B->>P: clearenv, setenv, mounts, chdir root
```

The form script is builder-fixed and identical to satan's apart from the launcher path:

```bash
set -euo pipefail
[ "$#" -ge 1 ] || { echo "quotient-write: missing the active session directory" >&2; exit 64; }
session_dir=$1
shift
case "$session_dir" in /*) ;; *) echo "quotient-write: session directory must be absolute: $session_dir" >&2; exit 64 ;; esac
[ -d "$session_dir" ] || { echo "quotient-write: no session directory at $session_dir" >&2; exit 64; }
export QUOTIENT_ACTIVE_SESSION_DIR="$session_dir"
exec /nix/store/…-jailed-quotient-write/bin/jailed-quotient-write "$@"
```

`QUOTIENT_ACTIVE_SESSION_DIR` is read only by the launcher, which expands it into the session bind. bwrap's `--clearenv` drops it, so pi never sees a `QUOTIENT_*` variable.

### Argument order

bwrap applies mounts in argument order, and a later mount at or above a path covers an earlier one. The builder therefore places its own guarantees last. It puts its tail in a jail.nix `defer`, so a caller's own deferred options cannot follow it.

```
 1  jail.nix base       --proc, --dev, --tmpfs /tmp, --tmpfs ~, /bin/sh, --clearenv,
                        Nix store closure, fake passwd
 2  builder home        persistHome: mkdir -p <path>; --bind <path> ~        (else the base tmpfs ~ stands)
 3  caller              add-pkg-deps packages; options c; set-env env
    builder exposure    --bind <p> <p> for each exposure path
 4  builder piFiles     --ro-bind <store path> ~/.pi/agent/<path>            (over home and caller binds)
 ── deferred tail (builder) ──
 5  state mask          "${quotient_mask[@]}": --tmpfs <p> for each of
                        ${XDG_STATE_HOME:-$HOME/.local/state}/quotient and protect that exists on the host
 6  root                --ro-bind (read) or --bind (write) "$quotient_root" "$quotient_root"
 7  session             --bind "$QUOTIENT_ACTIVE_SESSION_DIR" (same path)
 8  cwd                 --chdir "$quotient_root"
 9  secrets             --args "$quotient_secret_fd"                         (only --setenv pairs)
 ── jail.nix finalisation ──
10                      --unshare-{user,ipc,pid,uts,cgroup}, --unshare-net unless network,
                        --new-session, --die-with-parent, --setenv per env name
 ── jail.nix ──
11                      "${RUNTIME_ARGS[@]}" -- pi "$@"                      (caller add-runtime binds land here)
```

The launcher builds `quotient_mask` at launch. A path missing on the host has nothing to reveal, and bwrap cannot create a mount point inside a read-only bind, so masking only existing paths keeps a missing `protect` path from failing every launch. Exposure binds precede the root bind (3 before 6), and a later bind at an ancestor covers an earlier one. So under `read`, the root's read-only bind covers any `exposure` path inside the root, and the root stays read-only (G2). G5 caps what the child may write; it does not promise that every `exposure` path is writable, so a path inside a read root is simply not writable there. An `exposure` path containing the root stays writable outside the root's subtree. Under `write`, an `exposure` bind and the root bind show the same host directory (each binds a path onto itself), so nothing changes.

The mask is emitted as one line per path, generated by Nix from the default state path and `protect`, with no loop:

```bash
quotient_mask=()
[ -e "${XDG_STATE_HOME:-$HOME/.local/state}/quotient" ] && quotient_mask+=(--tmpfs "${XDG_STATE_HOME:-$HOME/.local/state}/quotient")
[ -e /srv/quotient/sessions ] && quotient_mask+=(--tmpfs /srv/quotient/sessions)   # one per protect path
```

How this order delivers form-1:

- **G1, G2**: the root bind (6) follows every caller bind in steps 1–4, so none of them can cover it or flip its mode. Binds a caller's `add-runtime` code appends to `RUNTIME_ARGS` land after everything (12): they are the caller's responsibility (sec-1, Threat model).
- **G3**: the session bind (7) follows the state mask (5), so this call's session directory shows through the mask, and no other session does.
- **G4**: base `--tmpfs /tmp` (1). The check refuses a caller bind or tmpfs at exactly `/tmp`, though binds *below* `/tmp` (an X11 socket) are allowed. A temp shared between runs is an `exposure` path bound elsewhere, with `env.TMPDIR` pointing at it.
- **G5**: the only rw binds are the root under `write`, the session directory, `exposure` and `persistHome`. The last is reported in `family.exposure`, so the server's own protected-store check sees it.
- **G6**: the state mask (5) hides the default session home and run directory, when they exist, whatever the caller has bound in steps 1–4, including a read-only `~` or `~/.local`. `protect` covers a policy that moves them. The policy, profiles and approvals stay readable, and writable only if a caller wrongly lists them in `exposure`, which the server refuses (`view-overlaps-protected`).
- **G7**: jail.nix emits `--die-with-parent` unless `no-die-with-parent` is used, and the check refuses its absence.
- **G8**: the form's three guards run before anything else.
- **G9**: the launcher runs under `set -euo pipefail` and every failure before `exec` exits non-zero. A mount bwrap cannot make (an unreadable `piFiles` source, a mask it cannot create) makes bwrap exit non-zero before pi starts.
- **G10**: both scripts, the bind list and `piFiles` sources are store paths; `secretEnv` expressions are in the launcher's bytes.

Mount points the mask or the session bind need are created in whatever lies beneath. Under the default private home that is a tmpfs. Under `persistHome` it is the persisted home, so an empty `.local/state/quotient` directory appears there on the host, which the docs state.

### Home and pi configuration (DEC-018)

The default home is jail.nix base's `--tmpfs ~`: private, and discarded when the run ends. pi state written outside `piFiles` is lost. `piFiles` binds store paths read-only under `~/.pi/agent`, for example `{ "settings.json" = ./settings.json; "models.json" = gatewayModels; }`, after the home and caller binds, so neither a persisted home nor a caller bind can replace them.

`persistHome = "/abs/path"` makes the home persist: the launcher creates the directory, binds it rw onto `~`, and adds it to `family.exposure`. One persisted home serves both capabilities, so it is a channel between runs and between read and write delegates. The docs say so.

### Environment and secrets (DEC-019, DEC-020)

After `--clearenv`, pi sees only:

| variable | value |
|---|---|
| `HOME` | the host `$HOME` (jail.nix `fwd-env`) |
| `PATH` | `packages`, pi and coreutils (jail.nix `add-pkg-deps`) |
| `LANG` | `${LANG:-C.UTF-8}` (builder default; overridable through `env`) |
| `TERM` | `dumb` (builder default; overridable through `env`) |
| each `env` name | its literal |
| each `secretEnv` name | its value at launch |

jail.nix base forwards `LANG` and `TERM` with `fwd-env`, which fails under the launcher's `set -u` when the server's environment lacks them. `set-env` writes one entry per name into the jail's environment map, and jail.nix emits a single `--setenv` per name at finalisation. The builder pushes its `LANG` and `TERM` entries straight after the base and before the caller's `env`. So the builder's entries replace base's, the caller's replace the builder's (satan's launcher shows exactly one `--setenv TERM`, its override), and a server started without a terminal still launches. `HOME` stays forwarded and is a precondition: the server's own XDG paths derive from it, and without it the launcher exits non-zero before bwrap (G9).

Secrets are evaluated outside the jail, in the deferred tail, and delivered as NUL-separated `--setenv` pairs on a descriptor bash allocates (the jail.nix closure-bind pattern, `bind-nix-store-runtime-closure.nix:73-74`):

```bash
quotient_secret_OPENAI_API_KEY=$(cat /run/secrets/gateway-key)   # caller's expression
[ -n "$quotient_secret_OPENAI_API_KEY" ] || { echo "quotient-write: secretEnv OPENAI_API_KEY is empty" >&2; exit 1; }
exec {quotient_secret_fd}< <(printf '%s\0' --setenv OPENAI_API_KEY "$quotient_secret_OPENAI_API_KEY")
# … bwrap … --args "$quotient_secret_fd" …
```

A failing expression exits through `set -e`, and an empty value exits explicitly: either way pi does not start (G9). Values never reach argv, `/proc/1/cmdline` or disk. With `secretEnv = { }` none of this is emitted.

`emptyEnvBwrap` is `writeShellScriptBin "bwrap" ''exec ${coreutils}/bin/env -i ${bubblewrap}/bin/bwrap "$@"''`. Without it, bwrap keeps the server's environment (keys included) and, as PID 1 in the jail's pid namespace, exposes it at `/proc/1/environ`. That is safe because the launcher has already expanded every value, including `~` and `$HOME` in raw arguments, before `env -i` runs, and bwrap consults `HOME` only when no `--chdir` is given.

### Network

`network = true` adds jail.nix's `network` combinator: a shared network namespace plus read-only `/etc/hosts`, `/etc/resolv.conf`, `/etc/ssl` and the systemd resolver. `false` leaves jail.nix's `--unshare-net` in place. pi needs the network to reach a provider, so `false` suits only a local model or a probe.

### Invariants

- The builder never emits `no-die-with-parent`, a second `--chdir`, or a bind over the root path.
- `quotient_root` is assigned exactly once; `quotient_mask` is declared exactly once (`quotient_mask=()`) and extended only inside existence tests; and `quotient_secret_fd` is allocated at most once (exactly once when `secretEnv` is non-empty). All three happen in the deferred tail, after all caller runtime code.
- `baseline` is the same `mkFormFamily` instantiation, sharing every argument, with only the root bind (6), the session bind (7) and `--chdir` (8) omitted. So `form − baseline` is exactly the root and session binds, and anything the caller adds appears on both sides, which is why the check's exposure rule (g) is separate from the residue rule (f). Its launcher is `family.baseline/bin/<prefix>-baseline`; it has no form wrapper.
- Under `read`, no `exposure` path inside the root is writable: the root bind covers it.
- `family.exposure` lists every rw bind source the builder or the caller adds, other than the root and the session directory.

<!-- doctrine:section sec-3 -->
## 3. The Check: `checkFormFamily`

### Interface

```nix
checks.${system}.quotient-forms = quotient.lib.checkFormFamily { inherit pkgs; family = myFamily; };
```

`checkFormFamily` (in `nix/check-family.nix`) is a `pkgs.runCommand` that runs `nix/check.sh` over the family's store paths. It reads scripts as text and launches nothing, because bwrap needs user namespaces and the Nix build sandbox does not grant them (DEC-021). It passes the family's attributes to the script as environment variables:

| variable | from |
|---|---|
| `FORM_READ`, `FORM_WRITE` | `family.read/bin/<prefix>-read`, `family.write/bin/<prefix>-write` |
| `BASELINE` | `family.baseline/bin/<prefix>-baseline` (a launcher; the baseline has no form wrapper) |
| `PREFIX`, `BWRAP` | `family.prefix`, `family.bwrap` |
| `EXPOSURE`, `SECRET_ENV_NAMES` | newline-separated lists |
| `NETWORK` | `1` or `0` |

The check succeeds by writing a report to `$out`. It fails by printing every failed assertion (not only the first), the residues, and a summary line, and then exiting 1. A caller with a hand-built family of the same shape can run it too, which is why the family carries `bwrap` and `secretEnvNames` rather than the check recomputing them.

### Reading a launcher

`check.sh` first resolves, on the raw text, the form's `exec` line to its launcher's store path, the one level of indirection a builder family has (DEC-021; satan's check descends two). Then it normalises each launcher's text once, as satan's does:

1. Strip double quotes, so a raw argument (`--bind "$quotient_root" "$quotient_root"`) and a jail.nix-rendered one read alike.
2. Fold store hashes (`/nix/store/<32 chars>-` → `/nix/store/*-`), so a nixpkgs or jail.nix bump is not drift.
3. Extract the bwrap line, the one beginning `exec <BWRAP>`, as an ordered token list. Order assertions read positions in it.

`bind_words` (lifted from satan) lists every `--bind`, `--ro-bind` and `--bind-try` / `--ro-bind-try` word triple, sorted and unique.

### Assertions

Per capability, labelled as in DEC-021 so a failure names its rule:

| | asserts | guards |
|---|---|---|
| (a) | form script: the three guards as sec-2 writes them, each predicate (`[ "$#" -ge 1 ]`, the `case … /*)` absolute-path test, `[ -d "$session_dir" ]`) on the line with its `exit 64`, and no other `exit 64`; `session_dir=$1`; `shift`; `export QUOTIENT_ACTIVE_SESSION_DIR="$session_dir"`; `exec <launcher> "$@"`; no `--`, no `$2`, no bind or tmpfs flag of its own | G8, invocation |
| (b) | the launcher's `exec` names `BWRAP` | G9 via DEC-020 |
| (c) | this capability's root flag (`--ro-bind` for read, `--bind` for write) on `$quotient_root` present, the other absent; exactly one assignment to `quotient_root` (`=$(pwd -P)`) and exactly one declaration `quotient_mask=()`, with every `quotient_mask+=` on a line that opens with its `[ -e … ] &&` test (sec-2 gives the emitted shape), so no caller runtime code can reassign them; the tail order below | G1, G2, G3 |
| (d) | `--die-with-parent`; `--tmpfs /tmp`; `--clearenv`; `--unshare-{user,ipc,pid,uts,cgroup}`; `--unshare-net` present exactly when `NETWORK=0`, and no raw `--share-net` then; no other `--chdir`; no caller bind or tmpfs whose target is exactly `/tmp` | G4, G7, drift |
| (e) | no `--setenv QUOTIENT_`; no `QUOTIENT_SESSION_HOME`, `QUOTIENT_RUN_DIR` or `QUOTIENT_POLICY`; no baseline bind targeting `$quotient_root` | invocation, G6 |
| (f) | form `bind_words` − baseline `bind_words` = {root bind, session bind}, and baseline − form = ∅ | G5 |
| (g) | every rw bind source in the baseline is in `EXPOSURE` | G5 |
| (h) | no `SECRET_ENV_NAMES` name as `--setenv NAME` on the bwrap line; `exec {quotient_secret_fd}<` and `--args $quotient_secret_fd` each at most once, exactly once when `SECRET_ENV_NAMES` is non-empty, the first preceding the bwrap line | secrets |
| (i) | the launcher builds `quotient_mask` from the default state directory and `protect`, each behind an existence test, and `${quotient_mask[@]}` opens the tail | G6 |

The order rules need no knowledge of jail.nix's internals, because the builder's tail identifies itself. The tail opens with the `${quotient_mask[@]}` token. After it, the only mount flags on the bwrap line are, in order, the root bind and the session bind, followed by `--chdir $quotient_root`. `--args $quotient_secret_fd`, jail.nix's finalisation flags and `${RUNTIME_ARGS[@]}` may follow. That is the order half of (c) and (i). Before it, anything goes, subject to the other assertions. The `/tmp` rule in (d) is positional too: exactly one mount on the line targets `/tmp`, and it is base's `--tmpfs /tmp`.

### Residues and what the check cannot see

The check prints the full residue in both directions whenever (f) fails, and prints these residues on success too, so a reviewer sees them in `nix log`:

- binds delivered by `--args` from a caller's descriptor, or appended to `RUNTIME_ARGS` by caller `add-runtime` code;
- mounts whose source or target contains a space or a command substitution, which `bind_words` does not tokenise;
- everything at runtime: whether the mounts behave as the text says (sec-5's probe).

### Negative controls

Each refusal gets one doctored family in the test flake (sec-5) and one check derivation that runs `check.sh` over it. That derivation succeeds only if `check.sh` exits 1 *and* its output contains the expected rule label. A control therefore fails if the check stops catching its case, and the gate stays a plain `nix flake check`. A control is made one of two ways: with a caller argument, through the real builder; or, where the builder would never emit the fault, by the test flake's `doctor` helper editing a built family's text (sec-5).

| control | made by | label |
|---|---|---|
| a guard's predicate removed | doctor (form) | (a) |
| launcher execs bare `bubblewrap` | doctor (launcher) | (b) |
| read form carrying `--bind` on the root | doctor (launcher) | (c) |
| `options` add-runtime `quotient_root=/` | builder | (c) |
| a caller bind moved after the session bind | doctor (launcher) | (c) |
| `options` `no-die-with-parent` | builder | (d) |
| `options` `tmpfs "/tmp"` | builder | (d) |
| `network = false` with `options` `share-ns "net"` | builder | (d) |
| `network = false` with raw `--share-net` | builder | (d) |
| `env.QUOTIENT_DEBUG` | builder | (e) |
| a baseline bind dropped from a form | doctor (launcher) | (f) |
| `options` rw-bind of a path not in `exposure` | builder | (g) |
| a `secretEnv` name also in `env` | builder | (h) |
| the mask's existence test or token removed | doctor (launcher) | (i) |

<!-- doctrine:section sec-4 -->
## 4. Operator Documentation

The server's text changes only where it says quotient ships no forms (DEC-014, DEC-022 item 5). Shipped text cites no doctrine id: `src/drift.test.ts` enforces that for `docs`, `examples`, `help` and `README.md`, and this slice extends its scan to `flake.nix` and `nix/` (sec-5).

### `docs/nix-forms.md` (new)

The builder's manual, for an operator writing a consumer flake:

1. **What it builds**: a family, its two forms and baseline; Linux only; quotient still ships no forms.
2. **A minimal consumer**: a flake with `quotient`, `jail-nix` and a pi source as inputs, `mkFormFamily { … }` in `packages`, `checkFormFamily` in `checks`, and `nix build -o ~/.local/state/quotient/forms/write .#quotient-write`.
3. **Pointing a policy at it**: `forms.read` / `forms.write` at `…/forms/<cap>/bin/<prefix>-<cap>`; `family.exposure` copied into `exposure`; project forms by linking `<root>/.quotient/forms/<cap>` to a family's store path and running `quotient allow`, with the reminder that every rebuild is a new identity to approve.
4. **Arguments**: one subsection per argument, in sec-2's order, with the defaults.
5. **What the builder guarantees**: the form-1 settings it fixes and that no caller option removes them (sec-2 "Argument order").
6. **The caller's responsibilities**: binds delivered by `--args` or `add-runtime` are unchecked; the check refuses a bind at `/tmp`, so a temp shared between runs is an `exposure` path bound beside `/tmp`, with `env.TMPDIR` pointing at it; a persisted home is a channel between runs and between read and write delegates, and gains an empty `.local/state/quotient`; `protect` must list a session home or run directory moved off the default.
7. **Credentials**: a gateway is an `env` URL, a `secretEnv` key, and a `models.json` in `piFiles`; a failing or empty secret refuses the launch.
8. **Verifying a family**: `checkFormFamily` in `nix flake check`; `scripts/hostile-audit` from a quotient checkout for the G6 write sample; what neither proves.

### Other text

| file | change |
|---|---|
| `README.md`, The policy, `forms` bullet | "quotient ships no forms" becomes: ships none, and on Linux the flake's `lib.mkFormFamily` builds a family; link to `docs/nix-forms.md` |
| `help/setup.md`, step 3 | one sentence after "Put each form's absolute path…": on Linux with Nix, `docs/nix-forms.md` builds a pair |
| `flake.nix`, the comment above `in` | "exports no forms (DEC-116) … builds nothing that runs a delegate" becomes: `packages` is the server only; `lib` holds an optional form-family builder over a caller-supplied jail.nix; quotient ships no forms |
| `docs/contract/quotient-policy-2.md:221-224` | the lookup-base consequence, worktree wording only, meaning unchanged (below) |

The policy contract's sentence today:

> A project nested inside a larger root, or a worktree of it, therefore needs its own `roots` entry and its own approval: the base is never guessed, and the directory the server was launched in has no part in it.

It reads as though every worktree needs setup. As the design inquiry confirmed against `src/server/approvals.ts:165`, only a root that wants a *different* form does. The replacement:

> A project nested inside a larger root inherits that root's form; to use a different one it needs its own `roots` entry and its own approval. A worktree inside an approved root is such a nested project, and worktrees kept beside the root need a `roots` entry and an approval for the directory that holds them. The base is never guessed, and the directory the server was launched in has no part in it.

`form-1.md` is unchanged: a builder family is one implementer's evidence, and the Evidence table records only what quotient itself verifies.

<!-- doctrine:section sec-5 -->
## 5. Code Impact, Verification and Risks

### Module boundaries

```
flake.nix                 lib = { mkFormFamily = import ./nix/form-family.nix;
                                  checkFormFamily = import ./nix/check-family.nix; }
nix/form-family.nix       the builder: argument handling, emptyEnvBwrap, the form script,
                          the jail.nix call, the deferred tail; returns the family
nix/check-family.nix      runCommand wrapper: family attrs → env → nix/check.sh
nix/check.sh              the assertions; bash, shellcheck-clean; no Nix knowledge
nix/checks/flake.nix      quotient's own test flake (own flake.lock): sample families,
                          negative controls, the probe family
scripts/form-probe        host-side behavioural probe over the probe family
```

`check.sh` knows launcher text, not Nix, so `check-family.nix` stays a thin adapter and the assertions can be shellchecked and read on their own. `form-family.nix` imports nothing from `check-family.nix`. They share only the family's shape, which DEC-015 and DEC-021 fix.

### Code-impact commitments

| path | change |
|---|---|
| `flake.nix` | add `lib`; reword the comment (sec-4); `packages`, `apps`, `devShells` and `flake.lock` unchanged |
| `nix/form-family.nix` (new) | sec-2 |
| `nix/check-family.nix`, `nix/check.sh` (new) | sec-3 |
| `nix/checks/flake.nix`, `nix/checks/flake.lock` (new) | test flake, below |
| `scripts/form-probe` (new) | behavioural probe, below |
| `justfile` | `forms-check`, `forms-probe`, `nix-build` recipes, all three in `gate`; `lint` shellchecks `nix/check.sh` too |
| `src/drift.test.ts` | the doctrine-id scan also covers `flake.nix` and `nix/` |
| `src/help/help.test.ts` | the setup section names the builder's doc |
| `docs/nix-forms.md` (new), `README.md`, `help/setup.md`, `docs/contract/quotient-policy-2.md` | sec-4 |

`src/` outside those two tests, the npm package's code and the policy schema do not change. `package.json` `files` does not gain `nix/`: the builder ships through the flake (research, quotient repo hotspots). New files must be `git add`ed before a flake evaluation sees them.

### The test flake

`nix/checks/flake.nix` has inputs `nixpkgs`, `jail-nix` and `quotient`. The recipes pass `--override-input quotient path:$PWD`, so they test the working tree rather than whatever the lock last recorded. Its `checks.${system}`:

- `default-family`: `checkFormFamily` over a family with only the required arguments and a stub pi (`writeShellScriptBin "pi" "exit 0"`);
- `full-family`: the same over a family using every argument: `packages`, `options`, `env`, `secretEnv`, `exposure`, `protect`, `piFiles`, `persistHome` and `network = false`;
- `neg-<control>`: one negative control per row of sec-3's table, each passing only if `check.sh` fails with that row's label.

`doctor { family, form ? (t: t), launcher ? (t: t) }` is a test-flake helper. It copies a family's form script and launcher into a new derivation, applies the text edits, and repoints the copied form's `exec` line at the copied launcher, so `check.sh` follows the doctored pair rather than the original.

It also exposes `packages.${system}.probe-{read,write}`: the full family with the probe script as pi.

### `scripts/form-probe`

```
scripts/form-probe [--keep]      # builds the probe family from nix/checks, runs both forms
```

The probe runs on the host, outside the Nix sandbox, because it needs user namespaces. Every path the probe family names at build time is fixed under `/tmp/quotient-form-probe/` (`P` below), which the script creates fresh and removes afterwards; `--keep` leaves it for inspection:

```
P/root/                      the call's root
P/root/out/                  exposure inside the root
P/exposure/                  exposure outside the root
P/home/                      persistHome
P/world/                     bound read-only by the probe family's options (the operator mistake)
P/world/state/quotient/      XDG_STATE_HOME/quotient: sessions/<this>, sessions/other, runs/r
P/world/protect/             protect, exists
P/world/protect-missing      protect, never created
P/world/ro/                  a non-exposed host dir
```

The environment adds `XDG_STATE_HOME=P/world/state`, a canary `FORM_PROBE_CANARY=…` and a known secret value. Binding `P/world` read-only puts the state directory and both `protect` paths under a caller bind, the case the mask exists for. It runs each form exactly as the server does: cwd = root, argv = session dir + pi argv, stdin closed. The probe pi runs inside the jail, attempts each operation for real (an `open` for write, never `test -w`), and prints one `PASS`/`FAIL` line per assertion:

| assertion | read | write |
|---|---|---|
| G1 root file readable at its own path | ✓ | ✓ |
| G2 write in the root | refused | succeeds |
| G3 write in this session dir | succeeds | succeeds |
| G4 `/tmp` writable, and the marker absent from host `/tmp` afterwards | ✓ | ✓ |
| G5 `P/exposure` writable; `piFiles` file and a non-exposed bound host dir refused | ✓ | ✓ |
| `P/root/out`, an exposure inside the root: write | refused (G2 wins) | succeeds |
| launch succeeds although a `protect` path is missing under a read-only caller bind | ✓ | ✓ |
| G6 `sessions/other`, `runs/r` and the `protect` dir unreadable | ✓ | ✓ |
| canary absent from `/proc/1/environ` and pi's environment | ✓ | ✓ |
| secret absent from `/proc/1/cmdline`, present in pi's environment | ✓ | ✓ |

On the host side the probe also asserts G7: with the form started under a parent shell, SIGKILL to that shell leaves no jailed process. The form `exec`s down to bwrap, so that shell stands where the server does, as the form's parent. This is observed through a pid the probe pi writes to the session dir, and checked within 2 seconds. It also asserts G8: a missing, relative or non-directory session dir exits 64 and leaves no marker. It also asserts G9: an empty `secretEnv` value exits non-zero before the probe pi runs. Exit 0 means all passed, 1 means any failed, and 77 means a prerequisite is missing (no Nix, no bwrap, or user namespaces denied). `just forms-probe` treats 77 as a failure, because the gate requires the prerequisites (DEC-022).

### Verification alignment

| evidence | mode | in `just gate` |
|---|---|---|
| `checkFormFamily` passes on `default-family` and `full-family` | VT | `forms-check` (`nix flake check -L ./nix/checks --override-input quotient path:$PWD`) |
| each refusal caught, by its negative control | VT | `forms-check` |
| G1–G9 behaviour of the probe family, both capabilities | VT | `forms-probe` |
| the server package builds under Nix (IMP-007; catches a stale `npmDepsHash`, the v0.3.0 break) | VT | `nix-build` (`nix build .#default --no-link -L`) |
| shipped text, `flake.nix` and `nix/` cite no doctrine id; setup names the builder doc | VT | `test` |
| `nix/check.sh` and `scripts/form-probe` shellcheck clean | VT | `lint` (not in `gate`: IMP-002) |
| `scripts/hostile-audit` passes against a real-pi builder family, read and write, once | VH | no (needs a model) |
| sec-4 documentation rows | VA | no: a checklist in the plan |

`just gate` therefore needs Linux, Nix, bwrap and unprivileged user namespaces (DEC-022).

### Risks and explicit limits

- **Unchecked caller binds.** Binds delivered by `--args` or `add-runtime` code, and mounts with spaces or command substitutions, escape the text check. They are documented as the caller's responsibility, and the residue printout shows that they exist.
- **jail.nix drift.** quotient does not pin the caller's jail.nix (DEC-016). A change in how jail.nix renders arguments fails the check, which is fail-closed and loud, rather than passing silently. The test flake's lock pins the version quotient's own gate runs against, and bumping it is a deliberate act.
- **Text check versus behaviour.** The text check proves the launcher's arguments, not the jail's behaviour. The probe covers behaviour for one full family on one host, and hostile-audit covers G6's write case with a real pi. A consumer's family gets the text check and, if they run it, hostile-audit.
- **State mask scope.** The mask follows XDG defaults and `protect`. A policy that moves the session home or run directory without updating `protect` loses G6 readability for those paths. The server's write check still holds.
- **Linux only.** There is no Darwin story; the builder asserts this at evaluation.

