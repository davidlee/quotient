{
  description = "quotient — an MCP server with one tool, pi_agent, which delegates bounded work to pi";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.doctrine.url = "github:davidlee/doctrine";

  outputs =
    {
      self,
      nixpkgs,
      doctrine,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);

      # Every tool the gate (`just gate`) needs besides the host's nix: no
      # agents, and no Doctrine (the jails and shells use the host's install).
      # bubblewrap and git are for scripts/form-probe and the form checks;
      # shellcheck for `just lint`; typescript for `tsc`.
      gateTools =
        pkgs: with pkgs; [
          just
          nodejs_22
          typescript
          shellcheck
          bubblewrap
          git
          gawk
        ];

      # `packages` is the server only; `lib` holds an optional form-family
      # builder over a caller-supplied jail.nix; quotient ships no forms. A form
      # is the operator's choice and is named by the policy.
      lib = {
        mkFormFamily = import ./nix/form-family.nix;
        checkFormFamily = import ./nix/check-family.nix;
      };
    in
    {
      inherit lib;

      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          # What dev-envs builds its jails, forms and shell from.
          dev-tools = pkgs.buildEnv {
            name = "quotient-dev-tools";
            paths = gateTools pkgs;
            ignoreCollisions = true;
          };

          # A room has no host binary (`just specs` runs `doctrine`): `dev-tools`
          # plus Doctrine, for the fleet target's `toolsPackage`.
          capsule-tools = pkgs.buildEnv {
            name = "quotient-capsule-tools";
            paths = gateTools pkgs ++ [ doctrine.packages.${system}.default ];
            ignoreCollisions = true;
          };

          # `npm pack` semantics come from package.json's "files", so dist/,
          # help/, docs/ and examples/ land in the output. `prepack` runs tsc in
          # the sandbox; the npm install hook wraps the bin so it carries node.
          default = pkgs.buildNpmPackage {
            pname = "quotient";
            inherit (packageJson) version;
            src = ./.;
            npmDepsHash = "sha256-tlTyRMIn9LGekczh9IqvFVqr+dKIv4gdZFpq16485wk=";
            nodejs = pkgs.nodejs_22;
            npmBuildScript = "build";
            # The bin is a wrapper over dist/cli.js, so `process.argv[1]` names a
            # store path that the next rebuild and GC remove. The wrapper exports
            # the path it was run as, which `quotient help clients` prints.
            nativeBuildInputs = [pkgs.makeWrapper];
            postInstall = ''
              wrapProgram $out/bin/quotient --run 'case "$0" in /*) QUOTIENT_LAUNCHER=$0 ;; *) QUOTIENT_LAUNCHER=$PWD/$0 ;; esac; export QUOTIENT_LAUNCHER'
            '';
            meta = {
              description = "An MCP server with one tool, pi_agent, which delegates bounded work to pi";
              homepage = "https://github.com/davidlee/quotient";
              license = pkgs.lib.licenses.mit;
              mainProgram = "quotient";
            };
          };
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/quotient";
        };
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = gateTools pkgs;
          };
        }
      );
    };
}
