# The fixture corpus's wrapper: every sample family's inputs become the
# environment the runner reads, and the runner's verdict becomes the build's.
# One derivation for the whole corpus, so the corpus is one check: it fails when
# any case's verdict flips, and the log names that case.
#
# Each family is a block of the names nix/check.sh already reads, prefixed with
# the family's own name, so the runner resolves one by name and a case table
# never holds a path.
{
  pkgs,
  families,
}:
let
  inherit (pkgs) lib;

  block =
    name: family:
    let
      upper = lib.toUpper name;
    in
    {
      "${upper}_FORM_READ" = "${family.read}/bin/${family.prefix}-read";
      "${upper}_FORM_WRITE" = "${family.write}/bin/${family.prefix}-write";
      # The baseline has no form wrapper: it is the launcher itself.
      "${upper}_BASELINE" = "${family.baseline}/bin/${family.prefix}-baseline";
      "${upper}_PREFIX" = family.prefix;
      "${upper}_BWRAP" = "${family.bwrap}/bin/bwrap";
      "${upper}_NETWORK" = if family.network then "1" else "0";
      "${upper}_EXPOSURE" = lib.concatStringsSep "\n" family.exposure;
      "${upper}_SECRET_ENV_NAMES" = lib.concatStringsSep "\n" family.secretEnvNames;
      # The family's protect paths, so a case can assert a mask line is there.
      "${upper}_PROTECT" = lib.concatStringsSep "\n" family.protect;
    };

  # One block per family the flake builds: a new sample family is wired by
  # naming it beside the others, never here.
  blocks = lib.foldl' (acc: name: acc // block name families.${name}) { } (lib.attrNames families);
in
pkgs.runCommand "check-fixtures" (
  blocks
  // {
    nativeBuildInputs = [
      pkgs.bash
      pkgs.coreutils
      pkgs.gawk
      pkgs.gnugrep
      pkgs.gnused
    ];
    CHECK = "${../check.sh}";
    REPLACE = "${./replace.sh}";
  }
) ''
  status=0
  bash ${./fixtures/run.sh} ${./fixtures/cases.sh} > report || status=$?
  # The whole run reaches the log either way: a case that flipped has to be
  # readable from it, not inferred from a failed exit.
  cat report >&2
  cp report $out
  exit "$status"
''
