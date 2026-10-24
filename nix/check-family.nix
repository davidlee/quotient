# The check wrapper: a family's store paths become the environment nix/check.sh
# reads, and the report becomes $out. Text only — no launcher is executed,
# because bwrap needs user namespaces the build sandbox does not grant.
#
# `expectRefusal` turns the check inside out for the negative controls: the
# derivation then succeeds only if the check exits 1 and prints a failure line
# (`FAIL <label>`) for that label.
{
  pkgs,
  family,
  name ? "check-${family.prefix}-forms",
  expectRefusal ? "",
}:
let
  inherit (pkgs) lib;
  inherit (family) prefix;
in
pkgs.runCommand name {
  nativeBuildInputs = [
    pkgs.bash
    pkgs.coreutils
    pkgs.gnugrep
    pkgs.gnused
  ];
  FORM_READ = "${family.read}/bin/${prefix}-read";
  FORM_WRITE = "${family.write}/bin/${prefix}-write";
  # The baseline has no form wrapper: it is the launcher itself.
  BASELINE = "${family.baseline}/bin/${prefix}-baseline";
  BWRAP = "${family.bwrap}/bin/bwrap";
  PREFIX = prefix;
  EXPOSURE = lib.concatStringsSep "\n" family.exposure;
  SECRET_ENV_NAMES = lib.concatStringsSep "\n" family.secretEnvNames;
  PROTECT = lib.concatStringsSep "\n" family.protect;
  NETWORK = if family.network then "1" else "0";
  EXPECT_REFUSAL = expectRefusal;
} ''
  status=0
  bash ${./check.sh} > report 2>&1 || status=$?
  # The check's own words reach the build log whatever the verdict, so a family
  # refused for a reason other than the label it was built to break is still
  # diagnosable from the log alone.
  cat report >&2

  if [ -z "$EXPECT_REFUSAL" ]; then
    if [ "$status" -ne 0 ]; then
      exit "$status"
    fi
  else
    if [ "$status" -ne 1 ]; then
      echo "the check did not refuse this family (exit $status)" >&2
      exit 1
    fi
    # A label counts only at the start of a failure line: the report quotes bind
    # paths a caller controls, so a label inside one is not a verdict.
    if ! awk -v want="FAIL $EXPECT_REFUSAL" 'index($0, want) == 1 { found = 1 } END { exit !found }' report; then
      echo "the check refused this family but printed no failure line 'FAIL $EXPECT_REFUSAL'" >&2
      exit 1
    fi
  fi
  cp report $out
''
