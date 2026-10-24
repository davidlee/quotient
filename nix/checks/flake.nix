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
          state=$probe_root/world/state/quotient
          session=$state/sessions/this
          other=$state/sessions/other
          runs=$state/runs/r

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

          # G6: another session and a run directory stay unreadable. Vacuous for
          # now: the probe binds nothing under the state dir until the caller
          # arguments land.
          expect "$(attempt read "$other/marker")" refused \
            "G6-sessions-other $capability: another session's directory is unreadable"
          expect "$(attempt read "$runs/marker")" refused \
            "G6-runs $capability: the run directory is unreadable"

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
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          family =
            capability:
            quotient.lib.mkFormFamily {
              inherit pkgs jail-nix;
              pi = probePi pkgs capability;
            };
        in
        {
          probe-read = (family "read").read;
          probe-write = (family "write").write;
        }
      );
    };
}
