# The form-family builder (design sec-2): one family per caller, from the
# caller's nixpkgs, a caller-supplied jail.nix and a pi. Linux only.
#
# A family is the read and write forms, the baseline they are compared against,
# the prefix that names them, and the empty-environment bwrap every launcher
# must exec. quotient ships no family: the operator's flake calls this.
{
  pkgs,
  jail-nix,
  pi,
  prefix ? "quotient",
  packages ? [ ],
  options ? (c: [ ]),
  env ? { },
  secretEnv ? { },
  exposure ? [ ],
  protect ? [ ],
  piFiles ? { },
  persistHome ? null,
  network ? true,
}:
let
  inherit (pkgs) lib;

  # bwrap with no environment of its own. Without it bwrap keeps the server's
  # environment and, as PID 1 in the jail's pid namespace, exposes it at
  # /proc/1/environ. Safe because the launcher has already expanded every value
  # into argv before `env -i` runs. Not overridable.
  emptyEnvBwrap = pkgs.writeShellScriptBin "bwrap" ''
    exec ${pkgs.coreutils}/bin/env -i ${pkgs.bubblewrap}/bin/bwrap "$@"
  '';

  # The jail.nix flake or its lib: the builder instantiates the jail itself, so
  # no caller can hand it a bwrap that keeps an environment.
  jail = (jail-nix.lib or jail-nix).extend {
    inherit pkgs;
    bubblewrapPackage = emptyEnvBwrap;
  };

  launcherName = capability: "jailed-${prefix}-${capability}";

  # The prefix names every form and launcher, so it must be a safe filename
  # component: an invalid one fails at the call, not at the build.
  prefixOk = builtins.match "[A-Za-z0-9][A-Za-z0-9._-]*" prefix != null;

  # A `piFiles` key is joined under `~/.pi/agent` in the jail, so it must not
  # climb out of it; the host paths must be absolute, because bwrap would
  # resolve a relative one against whatever cwd the launch had.
  piFileKeyOk =
    key: key != "" && !(lib.hasPrefix "/" key) && !(lib.elem ".." (lib.splitString "/" key));
  hostPaths =
    lib.optional (persistHome != null) {
      arg = "persistHome";
      path = persistHome;
    }
    ++ map (path: {
      arg = "exposure";
      inherit path;
    }) exposure
    ++ map (path: {
      arg = "protect";
      inherit path;
    }) protect;
  describePath = entry: "${entry.arg} \"${entry.path}\"";
  badPiFiles = lib.filter (key: !(piFileKeyOk key)) (lib.attrNames piFiles);
  badHostPaths = lib.filter (entry: !(lib.hasPrefix "/" entry.path)) hostPaths;

  # jail.nix's `set-env` shell-quotes its value, which would make a runtime
  # expression a literal. This is the marker its `escape` leaves alone, so the
  # launcher's shell expands the value when it builds bwrap's argv.
  rawEnv = expr: { _noescape = expr; };

  # The server's default state directory, bash-quoted because the value comes
  # from its environment. In a Nix string `\$` before `{` is a literal `${`.
  stateDir = "\"\${XDG_STATE_HOME:-$HOME/.local/state}/quotient\"";

  # The mask line's two shapes share their existence test and their append, so
  # the path and its mount are written once. The argument is already a shell
  # word — `stateDir` is a double-quoted expression, a `protect` path is host
  # text and is escaped here — so caller text never reaches the launcher
  # unquoted.
  maskTest = quoted: "[ -e ${quoted} ]";
  maskAppend = quoted: "quotient_mask+=(--tmpfs ${quoted})";

  # The state directory's line is plain: it is the builder's own default, not a
  # caller's path. A protect path's line also tests that an existing path is a
  # directory, so a file there fails the launch, naming the path, rather than
  # becoming a mount.
  stateMaskLine = "${maskTest stateDir} && ${maskAppend stateDir}";
  protectMaskLine =
    quoted:
    "${maskTest quoted} && { [ -d ${quoted} ] || { printf 'quotient: protect path %s is not a directory\\n' ${quoted} >&2; exit 1; }; ${maskAppend quoted}; }";

  # One line per masked path, no loop: bwrap cannot create a mount point inside
  # the read-only root bind that follows, and a path missing on the host has
  # nothing to reveal.
  maskLines = lib.concatMapStrings (line: line + "\n") (
    [ stateMaskLine ] ++ map protectMaskLine (map lib.escapeShellArg protect)
  );

  # A secret is the caller's shell expression, evaluated in the deferred tail:
  # it is assigned to a private variable, refused if empty, and delivered as
  # NUL-separated `--setenv` pairs on a bash-allocated descriptor, so no value
  # ever reaches bwrap's argv. Nothing is emitted for an empty secretEnv.
  secretNames = lib.attrNames secretEnv;
  # A value that does not expand is a literal handed over as its own text, which
  # is never what a caller means, so it is refused at the call.
  literalSecrets = lib.filter (name: !(lib.hasInfix "$" secretEnv.${name})) secretNames;
  secretRuntime =
    lib.concatMapStrings
      (
        name:
        ''
          quotient_secret_${name}=${secretEnv.${name}}
          [ -n "$quotient_secret_${name}" ] || { echo "${prefix}: secretEnv ${name} is empty" >&2; exit 1; }
        ''
      )
      secretNames
    + lib.optionalString (secretNames != [ ]) ''
      exec {quotient_secret_fd}< <(printf '%s\0' ${lib.concatMapStrings (
        name: ''--setenv ${name} "$quotient_secret_${name}" ''
      ) secretNames})
    '';

  # The deferred tail (sec-2, "Argument order"): one jail.nix `defer`, so a
  # caller's own deferred options precede it and none can follow. `rootFlag` is
  # the one word the capabilities differ in; null is the baseline, which stops
  # after the mask. G7 rests on jail.nix's own --die-with-parent; nothing here
  # adds its negation. The baseline binds no root and does not chdir, so it must
  # not assign `quotient_root` either: shellcheck fails the derivation on the
  # unused variable (SC2034), and a launcher that cannot be built is no
  # baseline.
  tail =
    rootFlag: c:
    let
      isForm = rootFlag != null;
    in
    c.defer (
      c.compose (
        lib.optionals isForm [ (c.add-runtime "quotient_root=$(pwd -P)") ]
        ++ lib.optional (secretNames != [ ]) (c.add-runtime secretRuntime)
        ++ [
          (c.add-runtime ''
            quotient_mask=()
            ${maskLines}
          '')
          (c.unsafe-add-raw-args "\"\${quotient_mask[@]}\"")
        ]
        ++ lib.optionals isForm [
          (c.unsafe-add-raw-args "${rootFlag} \"$quotient_root\" \"$quotient_root\"")
          (c.unsafe-add-raw-args ''--bind "$QUOTIENT_ACTIVE_SESSION_DIR" "$QUOTIENT_ACTIVE_SESSION_DIR"'')
          (c.unsafe-add-raw-args ''--chdir "$quotient_root"'')
        ]
        ++ lib.optional (secretNames != [ ]) (c.unsafe-add-raw-args ''--args "$quotient_secret_fd"'')
      )
    );

  # `persistHome` binds the caller's directory rw onto `~` (sec-2, row 2). The
  # target must stay unquoted so the launcher's shell expands `~`; `rw-bind`
  # would escape it. The launcher creates the directory, since the caller names
  # a path that need not exist yet.
  persistHomePermission =
    c:
    c.compose [
      (c.add-runtime "mkdir -p ${lib.escapeShellArg persistHome}")
      (c.unsafe-add-raw-args "--bind ${lib.escapeShellArg persistHome} ~")
    ];

  # `piFiles` binds store paths read-only under `~/.pi/agent` (row 4), after the
  # home, caller binds and exposure, so neither a persisted home nor a caller
  # option can replace them.
  piFilePermission =
    c: subPath: source:
    c.unsafe-add-raw-args
      "--ro-bind ${lib.escapeShellArg (toString source)} ~/.pi/agent/${lib.escapeShellArg subPath}";

  # The caller's own permissions at their sec-2 positions (row 3): packages,
  # options and env, then the builder's exposure binds. Every path a caller
  # supplies is escaped here; `env` values are escaped by `set-env`.
  callerPermissions =
    c:
    [ (c.add-pkg-deps packages) ]
    ++ (options c)
    ++ lib.mapAttrsToList (name: value: c.set-env name value) env
    ++ map (path: c.rw-bind path path) exposure
    ++ lib.mapAttrsToList (piFilePermission c) piFiles;

  # Base forwards LANG and TERM with `fwd-env`, which exits under `set -u` when
  # the server lacks them; these entries replace base's (one `--setenv` per
  # name) and precede a caller's `env` (sec-2, "Environment and secrets").
  permissions =
    rootFlag: c:
    [
      (c.set-env "LANG" (rawEnv "\"\${LANG:-C.UTF-8}\""))
      (c.set-env "TERM" (rawEnv "dumb"))
    ]
    ++ lib.optional (persistHome != null) (persistHomePermission c)
    ++ lib.optional network c.network
    ++ callerPermissions c
    ++ [ (tail rootFlag c) ];

  rootBindFlag = capability: if capability == "read" then "--ro-bind" else "--bind";

  # The launcher is jail.nix's derivation: base permissions, then the builder's
  # environment and tail, then jail.nix's finalisation.
  launcher = capability: jail (launcherName capability) pi (permissions (rootBindFlag capability));

  # The form is the wrapper around the launcher (design sec-2, "Anatomy of a
  # form"): three guards on the session directory, then a direct exec of the
  # launcher. No chain of wrappers.
  form =
    capability:
    pkgs.writeShellScriptBin "${prefix}-${capability}" ''
      set -euo pipefail

      [ "$#" -ge 1 ] || { echo "${prefix}-${capability}: missing the active session directory" >&2; exit 64; }
      session_dir=$1
      shift
      case "$session_dir" in /*) ;; *) echo "${prefix}-${capability}: session directory must be absolute: $session_dir" >&2; exit 64 ;; esac
      [ -d "$session_dir" ] || { echo "${prefix}-${capability}: no session directory at $session_dir" >&2; exit 64; }
      export QUOTIENT_ACTIVE_SESSION_DIR="$session_dir"
      exec ${launcher capability}/bin/${launcherName capability} "$@"
    '';
in
assert lib.assertMsg pkgs.stdenv.hostPlatform.isLinux
  "quotient form families need bubblewrap, which quotient only wires on Linux; this is ${pkgs.stdenv.hostPlatform.system}";
assert lib.assertMsg prefixOk
  "mkFormFamily: prefix must match ^[A-Za-z0-9][A-Za-z0-9._-]*$, got \"${prefix}\"";
# A secret name becomes a shell variable name, so it is not caller text that
# can be quoted away: reject a name that is not a POSIX identifier.
assert lib.assertMsg (lib.all lib.isValidPosixName secretNames)
  "mkFormFamily: secretEnv names must be valid POSIX names, got ${lib.concatStringsSep ", " (lib.filter (name: !(lib.isValidPosixName name)) secretNames)}";
assert lib.assertMsg (literalSecrets == [ ])
  "mkFormFamily: secretEnv ${lib.concatStringsSep ", " literalSecrets} must be a shell expression containing $, not a literal";
assert lib.assertMsg (badPiFiles == [ ])
  "mkFormFamily: piFiles keys must be non-empty relative paths without a \"..\" segment: ${lib.concatStringsSep ", " badPiFiles}";
assert lib.assertMsg (badHostPaths == [ ])
  "mkFormFamily: persistHome, exposure and protect paths must be absolute: ${lib.concatStringsSep ", " (map describePath badHostPaths)}";
{
  read = form "read";
  write = form "write";

  # The same instantiation with only the root bind, the session bind and
  # --chdir omitted, sharing every other argument: run only to be subtracted
  # from a form, never as a package. No form wrapper.
  baseline = jail "${prefix}-baseline" pi (permissions null);

  inherit prefix;
  bwrap = emptyEnvBwrap;

  # What the operator's policy must list as exposed: every rw bind source the
  # builder adds beyond the root and the session directory.
  exposure = exposure ++ lib.optional (persistHome != null) persistHome;
  # The policy's protect paths: the check asserts each is masked.
  inherit protect;
  secretEnvNames = secretNames;
  inherit network;
}
