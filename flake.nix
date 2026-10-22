{
  description = "quotient — an MCP server with one tool, pi_agent, which delegates bounded work to pi";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);

      # quotient exports no forms (DEC-116). A form is the operator's choice and
      # is named by the policy; this flake builds the server and nothing that
      # runs a delegate.
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          # `npm pack` semantics come from package.json's "files", so dist/,
          # help/, docs/ and examples/ land in the output. `prepack` runs tsc in
          # the sandbox; the npm install hook wraps the bin so it carries node.
          default = pkgs.buildNpmPackage {
            pname = "quotient";
            inherit (packageJson) version;
            src = ./.;
            npmDepsHash = "sha256-GMaeM/qXNQU/SbcTTdv5LKnQ8mJqrTAoolZ2Bm8w3yY=";
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
            packages = [
              pkgs.nodejs_22
              pkgs.typescript
            ];
          };
        }
      );
    };
}
