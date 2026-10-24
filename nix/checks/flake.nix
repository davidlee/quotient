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

      # The paths the sample families name at build time. The check reads them
      # as text and launches nothing, so nothing here needs to exist.
      samplePaths = {
        world = "/tmp/quotient-checks/world";
        exposure = "/tmp/quotient-checks/exposure";
        home = "/tmp/quotient-checks/home";
        protect = "/tmp/quotient-checks/protect";
        extra = "/tmp/quotient-checks/extra";
      };

      # The two sample families the check runs over: one with only the required
      # arguments, so it takes the default network and the no-secret path; one
      # with every argument — a non-default toolchain, a secret on a descriptor,
      # a persisted home and protect, network = false. Both have a stub pi: the
      # check reads launcher text and never launches one.
      sampleBase = pkgs: {
        inherit pkgs jail-nix;
        pi = pkgs.writeShellScriptBin "pi" "exit 0";
      };
      callerOptions = c: [ (c.ro-bind samplePaths.world samplePaths.world) ];
      fullArgs = pkgs: {
        packages = [ pkgs.gnugrep ];
        options = callerOptions;
        env = { CHECK_LITERAL = "literal"; };
        secretEnv = { CHECK_SECRET = "$(printf %s secret)"; };
        exposure = [ samplePaths.exposure ];
        protect = [ samplePaths.protect ];
        piFiles = { "settings.json" = pkgs.writeText "check-settings.json" "settings\n"; };
        persistHome = samplePaths.home;
        network = false;
      };
      sampleFamilies = pkgs: {
        default = quotient.lib.mkFormFamily (sampleBase pkgs);
        full = quotient.lib.mkFormFamily (sampleBase pkgs // fullArgs pkgs);
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
          sample = sampleFamilies pkgs;
        in
        {
          probe-read = (probeFamily "read").read;
          probe-write = (probeFamily "write").write;
          probe-secret-empty = emptySecret.write;
          # The samples' forms, so the launcher text the check reads can be
          # rendered: the default family has no secret fd, the full family has
          # every caller argument.
          default-family-read = sample.default.read;
          default-family-write = sample.default.write;
          full-family-read = sample.full.read;
          full-family-write = sample.full.write;
        }
      );

      # The text check over both samples, plus one control per refusal: a check
      # derivation succeeds only if it refuses its doctored family by that
      # family's rule label, so a check that stops catching a fault turns the
      # gate red here rather than silently passing.
      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          families = sampleFamilies pkgs;
          # A control's `env` is merged into the family's, never substituted for
          # it: a control differs from the passing family in the one thing it
          # names.
          callerEnv = (fullArgs pkgs).env;

          # A control made by the builder: the full family's arguments with one
          # changed, so the control differs from the passing family in one thing.
          control = extra: quotient.lib.mkFormFamily (sampleBase pkgs // fullArgs pkgs // extra);

          check = name: family: quotient.lib.checkFormFamily { inherit pkgs family name; };

          refuse =
            control-name: label: family:
            quotient.lib.checkFormFamily {
              inherit pkgs family;
              name = "neg-${control-name}";
              expectRefusal = label;
            };

          # The doctor: a copy of the family's read form and of the launcher it
          # execs, edited as text, with the copy's exec repointed at the copied
          # launcher — so a control edits what the check reads and neither has
          # to read text itself. `form` and `launcher` receive the file's path
          # in the build and return the shell that edits it; a stale edit fails
          # the build instead of passing silently.
          doctor =
            {
              family,
              form ? (_: ""),
              launcher ? (_: ""),
            }:
            let
              formName = "${family.prefix}-read";
              launcherName = "jailed-${formName}";
            in
            # Every attribute but `read` is the family's own: the check reads the
            # baseline, the write form and the bwrap of the undoctored family.
            family // {
              read = pkgs.runCommand "doctored-${formName}" { } ''
              mkdir -p $out/bin
              form=$out/bin/${formName}
              launcher=$out/bin/${launcherName}
              install -m 755 ${family.read}/bin/${formName} "$form"
              source=$(sed -n 's|^exec \(/nix/store/[^ ]*\)/bin/.*|\1|p' "$form")
              if [ -z "$source" ]; then
                echo "the form execs no launcher" >&2
                exit 1
              fi
              install -m 755 "$source/bin/${launcherName}" "$launcher"

              # Every occurrence of $2 in the file $1 becomes $3, literally. An
              # edit whose text is absent fails the build instead of passing.
              replace() {
                local file=$1 from=$2 to=$3 text
                text=$(cat "$file")
                case $text in
                  *"$from"*) printf '%s\n' "''${text//"$from"/$to}" > "$file" ;;
                  *) echo "the doctored text \"$from\" is not in $file" >&2; exit 1 ;;
                esac
              }

              ${form "$form"}
              ${launcher "$launcher"}
              replace "$form" "$source" "$out"
            '';
            };
        in
        {
          default-family = check "default-family" families.default;
          full-family = check "full-family" families.full;

          # (a) one of the form wrapper's three guards lost its predicate.
          neg-guard-predicate = refuse "guard-predicate" "(a)" (
            doctor {
              family = families.full;
              form = f: ''replace "${f}" '[ "$#" -ge 1 ]' true'';
            }
          );

          # (b) the launcher execs a bare `bubblewrap` instead of the family's
          # empty-environment bwrap. The edit is the bwrap token alone: the
          # launcher's descriptor execs are not part of the fault.
          neg-bare-bubblewrap = refuse "bare-bubblewrap" "(b)" (
            doctor {
              family = families.full;
              launcher = f: ''
                sed -i 's|^exec [^ ]*/bin/bwrap |exec bubblewrap |' "${f}"
                grep -q '^exec bubblewrap ' "${f}"
              '';
            }
          );

          # (c) the read form binds the root read-write.
          neg-read-root-bind = refuse "read-root-bind" "(c)" (
            doctor {
              family = families.full;
              launcher = f: ''replace "${f}" '--ro-bind "$quotient_root"' '--bind "$quotient_root"' '';
            }
          );

          # (c) a caller runtime reassigns the root the tail computed.
          neg-root-reassigned = refuse "root-reassigned" "(c)" (
            control {
              # `export`: shellcheck fails the baseline on an unexported
              # assignment nothing reads (SC2034), and the rule this control
              # breaks counts assignments, not uses.
              options = c: callerOptions c ++ [ (c.add-runtime "export quotient_root=/") ];
            }
          );

          # (c) a caller bind moved after the session bind: the bind set is
          # unchanged, so only the order rule can catch it.
          neg-caller-bind-late = refuse "caller-bind-late" "(c)" (
            doctor {
              family = families.full;
              launcher = f: ''
                replace "${f}" '--ro-bind ${samplePaths.world} ${samplePaths.world} ' ""
                replace "${f}" '--bind "$QUOTIENT_ACTIVE_SESSION_DIR" "$QUOTIENT_ACTIVE_SESSION_DIR"' \
                  '--bind "$QUOTIENT_ACTIVE_SESSION_DIR" "$QUOTIENT_ACTIVE_SESSION_DIR" --ro-bind ${samplePaths.world} ${samplePaths.world}'
              '';
            }
          );

          # (d) the child does not die with its parent.
          neg-die-with-parent-off = refuse "die-with-parent-off" "(d)" (
            control {
              options = c: callerOptions c ++ [ c.no-die-with-parent ];
            }
          );

          # (d) a second mount on /tmp, so the jail would see the host's.
          neg-tmpfs-tmp = refuse "tmpfs-tmp" "(d)" (
            control {
              options = c: callerOptions c ++ [ (c.tmpfs "/tmp") ];
            }
          );

          # (d) with network = false the net namespace is shared by combinator.
          neg-share-net-ns = refuse "share-net-ns" "(d)" (
            control {
              options = c: callerOptions c ++ [ (c.share-ns "net") ];
            }
          );

          # (d) and by a raw flag, which no combinator hides.
          neg-share-net-raw = refuse "share-net-raw" "(d)" (
            control {
              options = c: callerOptions c ++ [ (c.unsafe-add-raw-args "--share-net") ];
            }
          );

          # (e) the server's own namespace reaches the jail through the caller's
          # environment.
          neg-quotient-env = refuse "quotient-env" "(e)" (
            control { env = callerEnv // { QUOTIENT_DEBUG = "1"; }; }
          );

          # (f) a form drops a bind its baseline has.
          neg-baseline-bind-dropped = refuse "baseline-bind-dropped" "(f)" (
            doctor {
              family = families.full;
              launcher = f: ''replace "${f}" '--bind ${samplePaths.exposure} ${samplePaths.exposure} ' ""'';
            }
          );

          # (g) a caller binds a path its policy does not call exposed.
          neg-unexposed-bind = refuse "unexposed-bind" "(g)" (
            control {
              options = c: callerOptions c ++ [ (c.rw-bind samplePaths.extra samplePaths.extra) ];
            }
          );

          # (h) a secret is also named in the caller's environment, so it would
          # reach bwrap's argv.
          neg-secret-in-env = refuse "secret-in-env" "(h)" (
            control { env = callerEnv // { CHECK_SECRET = "literal"; }; }
          );

          # (i) a mask append lost its existence test.
          neg-mask-test-removed = refuse "mask-test-removed" "(i)" (
            doctor {
              family = families.full;
              launcher = f: ''
                replace "${f}" '[ -e ${samplePaths.protect} ] && quotient_mask+=(--tmpfs ${samplePaths.protect})' \
                  'quotient_mask+=(--tmpfs ${samplePaths.protect})'
              '';
            }
          );
        }
      );
    };
}
