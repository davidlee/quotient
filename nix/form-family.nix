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

  # jail.nix's `set-env` shell-quotes its value, which would make a runtime
  # expression a literal. This is the marker its `escape` leaves alone, so the
  # launcher's shell expands the value when it builds bwrap's argv.
  rawEnv = expr: { _noescape = expr; };

  # The server's default state directory, bash-quoted because the value comes
  # from its environment. In a Nix string `\$` before `{` is a literal `${`.
  stateDir = "\"\${XDG_STATE_HOME:-$HOME/.local/state}/quotient\"";

  # One line per masked path, no loop: bwrap cannot create a mount point inside
  # the read-only root bind that follows, and a path missing on the host has
  # nothing to reveal.
  maskLine = path: ''[ -e ${path} ] && quotient_mask+=(--tmpfs ${path})'';

  # The deferred tail (sec-2, "Argument order"): one jail.nix `defer`, so a
  # caller's own deferred options cannot follow it. `rootFlag` is the one word
  # the capabilities differ in; null is the baseline, which stops after the mask.
  # G7 rests on jail.nix's own --die-with-parent; nothing here adds its negation.
  # The baseline binds no root and does not chdir, so it must not assign
  # `quotient_root` either: shellcheck fails the derivation on the unused
  # variable (SC2034), and a launcher that cannot be built is no baseline.
  tail =
    rootFlag: c:
    let
      isForm = rootFlag != null;
    in
    c.defer (
      c.compose (
        lib.optionals isForm [ (c.add-runtime "quotient_root=$(pwd -P)") ]
        ++ [
          (c.add-runtime ''
            quotient_mask=()
            ${maskLine stateDir}
          '')
          (c.unsafe-add-raw-args "\"\${quotient_mask[@]}\"")
        ]
        ++ lib.optionals isForm [
          (c.unsafe-add-raw-args "${rootFlag} \"$quotient_root\" \"$quotient_root\"")
          (c.unsafe-add-raw-args ''--bind "$QUOTIENT_ACTIVE_SESSION_DIR" "$QUOTIENT_ACTIVE_SESSION_DIR"'')
          (c.unsafe-add-raw-args ''--chdir "$quotient_root"'')
        ]
      )
    );

  # Base forwards LANG and TERM with `fwd-env`, which exits under `set -u` when
  # the server lacks them; these entries replace base's (one `--setenv` per
  # name) and precede a caller's `env` (sec-2, "Environment and secrets").
  permissions =
    rootFlag: c:
    [
      (c.set-env "LANG" (rawEnv "\"\${LANG:-C.UTF-8}\""))
      (c.set-env "TERM" (rawEnv "dumb"))
      (tail rootFlag c)
    ];

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
{
  read = form "read";
  write = form "write";

  # The same instantiation with only the root bind, the session bind and
  # --chdir omitted, sharing every other argument: run only to be subtracted
  # from a form, never as a package. No form wrapper.
  baseline = jail "${prefix}-baseline" pi (permissions null);

  inherit prefix;
  bwrap = emptyEnvBwrap;
}
