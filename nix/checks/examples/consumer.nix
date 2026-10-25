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
