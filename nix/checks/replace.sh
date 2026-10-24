# shellcheck shell=bash  # a helper: sourced by the doctor and the fixture runner
# The one literal-substitution helper: the test flake's controls and the fixture
# corpus both edit built text with it. Every occurrence of $2 in file $1 becomes
# $3, as a quoted bash pattern, so brackets, braces, parentheses and `$` are the
# text's own characters rather than a pattern. In a replacement `&` means the
# match, so it is escaped first. An edit whose text is absent fails the run: a
# stale edit is a broken fixture, never a silent pass.
replace() { # file from to
  local text to
  text=$(cat "$1")
  to=${3//&/\\&}
  case $text in
    *"$2"*) printf '%s\n' "${text//"$2"/$to}" >"$1" ;;
    *)
      printf 'the doctored text "%s" is not in %s\n' "$2" "$1" >&2
      exit 1
      ;;
  esac
}
