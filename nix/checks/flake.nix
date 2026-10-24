{
  description = "quotient's own checks for the form-family builder: the probe family scripts/form-probe runs. Not a shipped package.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/f20cd90e28fe0403873f473b29e42662cd86e8c4";
    jail-nix.url = "sourcehut:~alexdavid/jail.nix/404e7da9da5ab9aa643666682b2ba1312fa5fbe8";
    quotient.url = "path:../..";
    # One nixpkgs: the caller's. jail-nix has no inputs of its own.
    quotient.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    { self, nixpkgs, jail-nix, quotient }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      # The probe pi. It runs inside the jail and attempts every operation for
      # real — an open for write, never `test -w` — printing one PASS/FAIL line
      # per assertion and exiting non-zero if any failed. Its capability is
      # build-time, because the root's writability is what the two forms differ
      # in. Only bash and coreutils are on the jailed PATH, so no grep or awk.
      #
      # The tree is the literal scripts/form-probe creates on the host: the probe
      # runs outside the Nix sandbox because it needs user namespaces.
      probePi =
        pkgs: capability:
        pkgs.writeShellScriptBin "pi" ''
          set -uo pipefail

          probe_root=/tmp/quotient-form-probe
          root=$probe_root/root
          out=$root/out
          exposure=$probe_root/exposure
          world=$probe_root/world
          state=$world/state/quotient
          session=$state/sessions/this
          other=$state/sessions/other
          runs=$state/runs/r
          protect=$world/protect
          protect_missing=$world/protect-missing
          protect_space="$world/protect dir"
          ro=$world/ro
          secret=probe-secret

          capability=${capability}

          failed=0
          pass() { printf 'PASS %s\n' "$1"; }
          fail() { printf 'FAIL %s (got %s, wanted %s)\n' "$1" "$2" "$3"; failed=$((failed + 1)); }
          expect() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3" "$1" "$2"; fi; }

          # A real attempt: it fails when the mount refuses it.
          attempt() {
            if [ "$1" = write ]; then
              ( : > "$2" ) 2>/dev/null && echo landed || echo refused
            else
              ( : < "$2" ) 2>/dev/null && echo landed || echo refused
            fi
          }

          # The environ is NUL-separated; key presence is the assertion.
          canary_in() {
            local entry
            while IFS= read -r -d $'\000' entry; do
              case "$entry" in
                FORM_PROBE_CANARY=*) echo present; return ;;
              esac
            done <"$1"
            echo absent
          }

          # Substring presence over NUL-separated fields (cmdline, environ).
          contains() {
            local entry
            while IFS= read -r -d $'\000' entry; do
              case "$entry" in *"$2"*) echo present; return ;; esac
            done <"$1"
            echo absent
          }

          # `hold` is G7's subject: the host finds this process by the run's
          # nonce, which the form passed in pi's argv. The jail's /proc is its
          # own pid namespace, so a pid read here names nothing on the host.
          # No exec: this bash process's own argv carries the nonce, and a
          # single-command `sh -c` or a coreutils applet (which dispatches on
          # argv[0]) would replace or lose it.
          mode=assert
          [ "$#" -ge 1 ] && mode=$1
          if [ "$mode" = hold ]; then
            nonce=''${2:-}
            [ -n "$nonce" ] || { printf 'FAIL G7-hold: no nonce in pi argv\n' >&2; exit 1; }
            : >"$session/held"
            sleep 60 & wait
          fi

          # G1: the root is readable at its own absolute path.
          expect "$(cat "$root/hello.txt" 2>/dev/null)" quotient-form-probe \
            "G1 $capability: the root's file is readable at its own path"

          # G1-cwd: the jail starts in the root (`--chdir "$quotient_root"`).
          # A relative read alone would also pass on an inherited cwd, so this
          # asserts the resolved directory; the root's path is build-time fixed.
          expect "$(pwd -P 2>/dev/null)" "$root" \
            "G1-cwd $capability: the jail's working directory is the root"

          # G2: the root's capability — what the two forms differ in.
          root_want=refused
          [ "$capability" = write ] && root_want=landed
          expect "$(attempt write "$root/probe-marker")" "$root_want" \
            "G2 $capability: a write in the root is $root_want"

          # G3: this call's session directory is writable in both capabilities.
          expect "$(attempt write "$session/probe-marker")" landed \
            "G3 $capability: the session directory is writable"

          # G4: the jail's /tmp is its own; the host checks the marker's absence.
          expect "$(attempt write /tmp/quotient-form-probe-marker)" landed \
            "G4 $capability: /tmp is writable in the jail"

          # The caller's literals and packages: `env` reaches bwrap's argv,
          # `packages` reaches PATH.
          expect "''${FORM_PROBE_LITERAL:-}" probe-literal \
            "env-literal $capability: env reaches pi's environment"
          expect "$(command -v grep >/dev/null 2>&1 && echo present || echo absent)" present \
            "pkg-path $capability: packages are on the jailed PATH"

          # G5: an exposure path is rw at its own path, the piFiles file is ro,
          # and a host dir bound read-only by the caller's options is not
          # writable.
          expect "$(attempt write "$exposure/probe-marker")" landed \
            "G5-exposure $capability: an exposure path is writable"
          expect "$(cat "$HOME/.pi/agent/settings.json" 2>/dev/null)" probe-settings \
            "G5-piFiles $capability: the piFiles file is bound at ~/.pi/agent"
          expect "$(attempt write "$HOME/.pi/agent/settings.json")" refused \
            "G5-piFiles-ro $capability: the piFiles file is read-only"
          expect "$(attempt write "$ro/probe-marker")" refused \
            "G5-world-ro $capability: a non-exposed host dir bound ro is not writable"
          # The parent must be visible, or the refusal above would be true of a
          # path that is simply absent: this row fails if `options` is dropped.
          expect "$([ -d "$ro" ] && echo present || echo absent)" present \
            "G5-world-ro-parent $capability: the caller's ro bind puts the host dir in the jail"

          # An exposure inside the root: the root bind follows it, so `read`
          # covers it.
          out_want=refused
          [ "$capability" = write ] && out_want=landed
          expect "$(attempt write "$out/probe-marker")" "$out_want" \
            "exposure-root $capability: an exposure inside the root is $out_want"

          # A protect path missing on the host is not masked and does not fail
          # the launch. The present protect path is asserted in the same row, so
          # this fails if `protect` is dropped (`landed`) and never reports if an
          # unconditional mask made bwrap fail.
          expect "$(attempt read "$protect/marker")/$([ -e "$protect_missing" ] && echo present || echo absent)" \
            refused/absent "protect-missing $capability: protect is in effect and an absent protect path reaches no mount"

          # G6: another session, the run directory and a protected path stay
          # unreadable under the caller's read-only bind and the state mask.
          expect "$(attempt read "$other/marker")" refused \
            "G6-sessions-other $capability: another session's directory is unreadable"
          expect "$(attempt read "$runs/marker")" refused \
            "G6-runs $capability: the run directory is unreadable"
          expect "$(attempt read "$protect/marker")" refused \
            "G6-protect $capability: a protected path is masked"
          expect "$(attempt read "$protect_space/marker")" refused \
            "G6-protect-space $capability: a protected path with a space is masked"

          # The secret is delivered in the environment, never on bwrap's argv.
          expect "$(printf %s "''${FORM_PROBE_SECRET:-}")" "$secret" \
            "secret-env $capability: secretEnv reaches pi's environment"
          expect "$(contains /proc/1/cmdline "$secret")" absent \
            "secret-cmdline $capability: the secret is absent from /proc/1/cmdline"

          # Of the server's environment only HOME, LANG and TERM reach the jail
          # (jail.nix's fwd-env, the builder's set-env defaults); the canary must
          # not.
          expect "$(canary_in /proc/1/environ)" absent \
            "canary-proc1 $capability: the canary is absent from /proc/1/environ"
          expect "$(canary_in /proc/self/environ)" absent \
            "canary-pi $capability: the canary is absent from pi's environment"

          if [ "$failed" -ne 0 ]; then
            printf 'probe (%s): %s assertion(s) failed\n' "$capability" "$failed" >&2
            exit 1
          fi
          printf 'probe (%s): all assertions passed\n' "$capability"
        '';
      # Every path the probe family names at build time is fixed under
      # probeRoot (design sec-5): scripts/form-probe creates that tree fresh and
      # removes it. `P/world` bound read-only by the caller's `options` is the
      # operator mistake the state mask exists for.
      probeRoot = "/tmp/quotient-form-probe";

      probeArgs =
        pkgs: capability:
        {
          inherit pkgs jail-nix;
          pi = probePi pkgs capability;
          packages = [ pkgs.gnugrep ];
          options = c: [ (c.ro-bind "${probeRoot}/world" "${probeRoot}/world") ];
          env = { FORM_PROBE_LITERAL = "probe-literal"; };
          secretEnv = { FORM_PROBE_SECRET = "$(printf %s probe-secret)"; };
          exposure = [
            "${probeRoot}/root/out"
            "${probeRoot}/exposure"
          ];
          protect = [
            "${probeRoot}/world/protect"
            "${probeRoot}/world/protect-missing"
            "${probeRoot}/world/protect dir"
          ];
          piFiles = {
            "settings.json" = pkgs.writeText "probe-settings.json" "probe-settings\n";
          };
          persistHome = "${probeRoot}/home";
          network = false;
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          probeFamily = capability: quotient.lib.mkFormFamily (probeArgs pkgs capability);
          # G9's subject: the same family with an empty secret, so the launch must
          # fail before the probe pi runs.
          emptySecret = quotient.lib.mkFormFamily (
            (probeArgs pkgs "write") // {
              secretEnv = {
                FORM_PROBE_SECRET = "$(true)";
              };
            }
          );
        in
        {
          probe-read = (probeFamily "read").read;
          probe-write = (probeFamily "write").write;
          probe-secret-empty = emptySecret.write;
        }
      );
    };
}
