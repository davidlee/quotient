# SL-003 research — optional jail.nix form builder

## Header

- Round: pre-design, 2026-10-24. Baseline: `research/baseline.toml` (stamped by
  `doctrine slice research 3`).
- Producers: three quotient `pi_agent` delegates (deepseek-flash, read-only form).
  - Thread 1 governance — profile `research`, cwd quotient, session
    `085ec6b36f7148b209d024f42bfe3f08`, raw: `raw/governance.md`.
  - Thread 2a jail.nix + prior art — profile `research`, cwd satan, session
    `880cc50a44fa27bec3336a935ef8279c`, raw: `raw/jailnix-and-prior-art.md`.
    It reports fetching jail.nix @ `404e7da` and nix-config @ `269b59a` from
    satan's lock; line numbers refer to those trees. Local store copies:
    jail.nix `/nix/store/rphl9ccg3zj6i3xshx1r9lqpm0nn5mcg-source`, agents flake
    `/nix/store/nw63simmyvcwhzznnv5lq8xmnv3x86yi-source/flakes/agents`.
  - Thread 2b quotient code map — profile `read`, cwd quotient, session
    `f6c673fe4fc89bf1f49c5adf9b84ba7d`, raw: `raw/code-map.md`.
- Assembly, verification and synthesis: orchestrating agent (Claude Opus 5.5).
- No ADRs, policies, standards or specs exist here. Governance = knowledge
  records plus `docs/contract/` (authoritative over `docs/design.md`,
  `docs/design.md:3-4`).

## Verification legend

- ✓ — the consuming agent read the cited site and confirmed the claim.
- unmarked — researcher claim: cited, not checked. Design may lean only on ✓
  rows or rows it verifies at point of use.
- ✗ — checked and corrected; the correction is stated.

## Thread 1 — governance applicability

### Binding constraints

- ✓ **form-1 invocation**: `<form> <session-dir> <pi argv…>`, root by cwd, env
  minus `QUOTIENT_*`, form execs pi — `docs/contract/form-1.md:8-24`.
- ✓ **G1–G10** — `docs/contract/form-1.md:28-46`. G5 closes the write set to
  root (write), session dir, private temp, `exposure`; G10 puts every
  confinement input in the executable's bytes or at a delegate-immutable path.
- ✓ **DEC-010** consequence: "IMP-003 helper should emit single-file scripts
  (writeShellScript)" — `.doctrine/knowledge/decision/010/record-010.toml:18`.
  Also: a project form replaces only a *confined* machine slot and inherits its
  `extensions`; a project cannot express unconfined (`:15`).
- ✓ **DEC-008** consequence: "forms should carry a narrow stable toolchain to
  limit re-approval" — `.doctrine/knowledge/decision/008/record-008.toml:18`.
- **Usable** project form = real path outside every `roots`, `exposure` and the
  session home — `docs/contract/quotient-policy-2.md:245-249`. Store paths
  satisfy it.
- **Digest covers the executable's bytes only**; approved forms must be
  immutable to every delegate on the host — `docs/contract/quotient-policy-2.md:269-274`.
- **No policy schema change** (DEC-011 compatibility rule) —
  `.doctrine/knowledge/decision/011/record-011.toml:15`.
- **DEC-116** (satan, operator, 2026-10-22): v1 rejected "generic bwrap forms +
  lib.mkForms in quotient" because forms depended on the private agents flake;
  generic forms named as follow-ups. Read via `doctrine show DEC-116` in
  `~/dev/satan` this session ✓.

### Checked, not applicable

- DEC-001…DEC-006 — SL-001 usage accounting; the builder touches no server path.
- ASM-001 — pi's event stream, not confinement.
- CON-001 — discharged, scoped to SL-001.
- DEC-012 / DEC-013 — store reader and the `allow` verb; store paths are already
  canonical.
- `quotient-policy-1.md` — historical.
- `pi-agent-result-2.md` refusals — the slice adds none.

### Revision candidates

- ✓ `flake.nix:16-18` — "quotient exports no forms (DEC-116) … this flake builds
  the server and nothing that runs a delegate." Rewrite.
- ✓ `README.md` (The policy, `forms` bullet) — "quotient ships no forms".
- `help/setup.md:27-31` (step 3: choose a form) and `:63-71` (unconfined
  fallback) — name the builder.
- A quotient DEC is needed: DEC-116 is satan's, so this is a new record
  (follow-up of DEC-116), not a supersede.
- `form-1.md` unchanged; the shipped check adds no row to its Evidence table
  (`docs/contract/form-1.md:77-89`).

### Selection gap (slice Scope 5 / OQ-5)

Project forms answer it per root: a root links `.quotient/forms/write` to an
approved store path and gets its own toolchain under one policy
(`docs/contract/quotient-policy-2.md:216-249`; DEC-007). Remaining limits:

1. One identity per (root, capability) (`docs/contract/quotient-approvals-1.md:61-64`):
   two toolchains in one root still need two roots.
2. The machine slot must exist and be confined, and its `extensions` are
   inherited (`docs/contract/quotient-policy-2.md:251-255`): the builder's
   family also serves as the machine default.
3. Nested roots / worktrees need their own `roots` entry and approval (DEC-007).
4. Every rebuild is a new identity → re-approval (DEC-008 ✓). Trades policy
   churn for approval churn.

## Thread 2 — code map

### jail.nix (verified against the local store copy)

- ✓ Flake output is `lib = import ./lib`, **not per-system** — `flake.nix:1-5`.
- ✓ `lib.init pkgs` / `lib.extend { pkgs, additionalCombinators, basePermissions,
  bubblewrapPackage, … }` — `lib/default.nix:4-5`, `lib/jail.nix:1-7`.
- ✓ Always emitted: `--unshare-{user,ipc,pid,net,uts,cgroup}` unless shared,
  `--new-session`, `--die-with-parent` (unless opted out), `--setenv` per env —
  `lib/jail.nix:63-87`.
- ✓ Base permissions = `base`, `bind-nix-store-runtime-closure`, `fake-passwd` —
  `lib/base-permissions.nix`. `base` gives `--proc`, `--dev`, `--tmpfs /tmp`,
  `--tmpfs ~`, `/bin/sh`, coreutils, `--clearenv`, forwards `LANG`/`HOME`/`TERM`
  — `lib/combinators/base.nix:41-54`.
- ✓ No `--chdir` in base: the builder must add `--chdir "$PWD"`.
- ✓ Launcher is `writeShellApplication` (ShellCheck on); it execs bwrap unless
  cleanup hooks exist, in which case it runs bwrap under a trap —
  `lib/jail.nix:91-115`.
- ✓ `persist-home name` = runtime `mkdir -p ~/.local/share/jail.nix/home/<name>`
  + rw-bind onto `~` — `lib/combinators/persist-home.nix`.
- Combinators: `readonly`/`readwrite`, `ro-bind`/`rw-bind`, `tmpfs`,
  `unsafe-add-raw-args`, `network` (shares net + ro-binds resolv/hosts/ssl),
  `set-env`/`fwd-env`, `add-pkg-deps` (PATH + closure), `mount-cwd`,
  `add-runtime`, `wrap-entry` — `lib/combinators/*.nix` (raw thread 2a).
- Linux only (bubblewrap); no darwin guard in the tree.

### What makeJailedPi adds (raw thread 2a, unverified)

- pi itself, from `llm-agents.packages.${system}.pi` — needed.
- `bubblewrapPackage = bwrapEmptyEnv` (bwrap under `env -i`) — closes an
  environ leak; `jailed-agents.nix:69-75`.
- `time-zone`, `no-new-session`, `/usr/bin/env` — shebangs; `:191-196`.
- `persist-home` for `~/.pi`; `network` per profile; `add-pkg-deps` for common
  packages + `extraPkgs`; `--chdir`.
- Consumer-specific: gateway wiring, `op run`, doctrine binds, git guards,
  workspace deps, subagents.

### Credentials (raw thread 2a, unverified)

- Gateway URL by `--setenv`; key by `--args 22 22< <(printf … "$(< keyFile)")`,
  so it is on neither argv nor disk; pi reads it through a generated
  `models.json` ro-bound over `~/.pi/agent/models.json` after the persisted-home
  bind — `jailed-agents.nix:448-515`, `pi-gateway.nix:9-16`.

### satan's family and check (verified at `~/dev/satan/flake.nix`)

- ✓ `quotientFormFamily` `:325-393`: one `jail` generator, `rootBindOption`,
  `mkForm` with session bind, `--tmpfs /tmp`, `--chdir "$PWD"`,
  `--die-with-parent`; wrapper with three exit-64 guards; `baseline`.
- ✓ `formProbes` `:486-510`; `quotientFormsCheck` `:691-` — text-only (nothing
  launched), residue over baseline must equal root + session.
- The check assumes a **two-level exec chain** (form → gateway wrapper → bwrap
  launcher), `:728-735`. A jail.nix-direct build has one level.

### quotient repo hotspots (raw thread 2b; spot-checked ✓ where marked)

- ✓ `flake.nix` — one input (nixpkgs); outputs `packages`, `apps`, `devShells`;
  systems `x86_64-linux`, `aarch64-linux` only.
- `package.json:9-14` `files` = `dist, help, docs, examples`: `nix/` would not
  ship in npm. Correct by design — the builder is a flake output.
- `src/drift.test.ts:319` `SHIPPED_TEXT` excludes `flake.nix` and `nix/`: the
  doctrine-id scan will not see them.
- `src/help/help.test.ts:64` pins `HELP_SECTIONS`; `:266-275` pins setup.md
  content. A new help section is a test edit.
- `scripts/hostile-audit` takes `--form <abs path> --capability --model`; needs
  a source checkout and node — `scripts/hostile-audit:35-37,128-132,249-257`.
- `justfile:1` gate has no nix target.

### Naming precedents

- `<prefix>-<capability>`: `quotient-read`, `quotient-write`
  (`examples/policy.json:20-22`).
- Session car variable `QUOTIENT_ACTIVE_SESSION_DIR` (satan `flake.nix:327`).

## Cross-thread findings

1. ✗→corrected **Persisted home vs G5.** Thread 1 called satan's persisted
   jail home a G5 violation. On this host it is declared in `exposure`
   (`~/.config/quotient/policy.json:33-35`; satan `justfile:108-113`), so it is
   compliant. The builder must therefore either make the persisted home
   optional, or make its host path a value the caller can copy into `exposure`.
   An undeclared persisted home breaks G5 and step 8's soundness.
2. **Persisted home is also a cross-run channel** (inference, unverified).
   A writable `~` shared by every call lets one delegate leave state that pi
   reads on the next call (config, `models.json`, extensions). satan
   ro-binds `models.json` over it for this reason. form-1 does not forbid it,
   since `exposure` is declared writable, but the builder's default should not
   create it silently. Candidate default: a private `--tmpfs ~` (jail.nix base
   already does this), with pi's own configuration supplied read-only.
3. **The check has to be rebased.** jail.nix gives a single launcher; satan's
   two-level descent (`:728-735`) does not apply. The residue-over-baseline idea
   carries over as long as the baseline and the forms share one generator call
   (satan `:318-324`).
4. **Credentials are a caller-supplied jail option.** Everything the gateway
   path needs is expressible with jail.nix combinators (`unsafe-add-raw-args`
   for the FD, `ro-bind` for `models.json`). So the builder can stay
   credential-agnostic by accepting caller options, which answers OQ-2.
5. **jail.nix as an input (OQ-1).** It is a tiny flake with no inputs of its
   own (`flake.nix:1-5` ✓), so a quotient input adds one small lock node.
   A caller can still `follows`/override it. Accepting a caller-passed `jail`
   instance is also cheap (`lib.extend` is the instantiation point).
6. **Output shape (OQ-3).** jail.nix's lib is system-agnostic, so a quotient
   `lib.mkFormFamily { pkgs, pi, … }` taking `pkgs` (not `lib.${system}`) fits
   jail.nix's own convention.
7. **pi provenance.** jail.nix has no notion of pi; the caller must pass pi (no
   pi in nixpkgs is assumed — unverified). This makes `pi` a required argument.
8. **env leak.** `bwrapEmptyEnv` (environ of the bwrap process visible from
   the child) is a makeJailedPi addition, not a jail.nix default. The builder
   should adopt it (via `bubblewrapPackage`) unless design shows `--clearenv`
   plus pid namespacing already covers it. Unverified; check in design.

## Design-input deltas

- Builder signature leans to `mkFormFamily { pkgs, pi, prefix ? "quotient",
  packages ? [], options ? [], home ? <ephemeral> }` with jail.nix as a quotient
  input, overridable.
- Persisted home: off by default; when on, its path is surfaced for `exposure`.
- Credentials: caller options only; document the gateway FD pattern as an
  example, not built in.
- Check: single-level launcher; residue over a shared-generator baseline; plus
  invariant probes (root flag per capability, session bind, `--die-with-parent`,
  `--tmpfs /tmp`, `--chdir`, three exit-64 guards, absence of
  `QUOTIENT_{RUN_DIR,SESSION_HOME,POLICY}`). Ship it as `lib.checkFormFamily`
  (or similar) so consumers run it in their own `checks`.
- Scope 5 resolved: project forms close the gap per root. IMP-003's note can be
  answered; no `forms`-by-root policy change.
- New quotient DEC needed for OQ-4.
