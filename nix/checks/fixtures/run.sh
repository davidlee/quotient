#!/usr/bin/env bash
# shellcheck disable=SC2016  # the quoted patterns are launcher text and awk programs: no `$` in them expands
# shellcheck disable=SC1090,SC1091  # the helper and the case table are store paths at build time
# The fixture corpus for nix/check.sh: one case per expected verdict, run over a
# real built family. A case names the family it starts from, the files it edits
# and the literal edits, and the verdict the check must reach — a pass, or a
# refusal whose failure line starts with the case's rule label. The base text is
# the family the builder emitted, never a recording, so a fixture cannot go stale
# against the builder; an edit whose text is absent fails the run, because a
# fixture that edits nothing proves nothing.
#
#   CHECK    the check script; its inputs come from the case's family
#   REPLACE  the literal-substitution helper
#   bash run.sh <case-table>
#
# The wrapper hands each family's inputs in one block, and `fam <family> <FIELD>`
# reads one, so a case table names a family and never a path.
set -uo pipefail
: "${CHECK:?}" "${REPLACE:?}"
table=${1:?the case table}
. "$REPLACE"

## The case table's vocabulary

case_name=() case_family=() case_outcome=() case_names=() case_expose=() case_protect=() case_absent=()
edit_case=() edit_op=() edit_layer=() edit_from=() edit_to=()

# @default is the family's own policy: a case overrides it only by naming one.
fixture() { # name family outcome [names= | expose= | protect= | absent=]
  local name=$1 i opt
  if [ "$#" -lt 3 ]; then
    echo "fixture $name: needs a family and an outcome" >&2
    exit 1
  fi
  case_name+=("$1") case_family+=("$2") case_outcome+=("$3")
  case_names+=("@default") case_expose+=("@default") case_protect+=("@default") case_absent+=("")
  i=$((${#case_name[@]} - 1))
  shift 3
  for opt in "$@"; do
    case ${opt%%=*} in
      names) case_names[i]=${opt#names=} ;;
      expose) case_expose[i]=${opt#expose=} ;;
      protect) case_protect[i]=${opt#protect=} ;;
      absent) case_absent[i]=${opt#absent=} ;;
      *) echo "fixture $name: unknown option '$opt'" >&2; exit 1 ;;
    esac
  done
}

push_edit() { # op layer from to — onto the case last declared
  local i
  if [ "${#case_name[@]}" -eq 0 ]; then
    echo "a fixture edit precedes every fixture" >&2
    exit 1
  fi
  i=$((${#case_name[@]} - 1))
  edit_case+=("$i") edit_op+=("$1") edit_layer+=("$2") edit_from+=("$3") edit_to+=("$4")
}

edit() { push_edit replace "$1" "$2" "$3"; }

# The same edit to both launchers and the baseline, so the bind sets still agree
# and only the rule the case is about can fire.
edit_launchers() { # from to
  local layer
  for layer in launcher-read launcher-write baseline; do edit "$layer" "$1" "$2"; done
}
drop() { push_edit drop "$1" "" ""; }

# The table's own last statement: an executed marker, not a comment. Sourcing a
# table stops where the load fails, and a table that returns early stops there
# too — either way a comment stays behind whether it was reached or not, so the
# flag this call sets is what tells a complete corpus from a cut-short one.
case_table_end=0
table_complete() { case_table_end=1; }

if ! . "$table"; then
  echo "the case table '$table' did not load" >&2
  exit 1
fi
if [ "$case_table_end" -ne 1 ]; then
  echo "the case table '$table' did not reach its end" >&2
  exit 1
fi
if [ "${#case_name[@]}" -eq 0 ]; then
  echo "the case table declares no case" >&2
  exit 1
fi

## The families

# One family's input, by name: the wrapper exports each field under the family's
# name, so `fam full BWRAP` is FULL_BWRAP.
fam() { # family field
  local name=${1^^}_$2
  printf '%s' "${!name}"
}

# The command a form's exec line names: a form wraps one launcher, and the
# launcher is what a case edits.
exec_line_target() { awk '/^exec /{ print $2; exit }' "$1" | tr -d '"'; }

# A family's copy, each form repointed at its copied launcher: a case edits what
# the check reads, and the family it started from is untouched.
copy_family() { # family dir
  local family=$1 dir=$2 cap form launcher
  mkdir -p "$dir"
  for cap in read write; do
    form=$(fam "$family" "FORM_${cap^^}")
    install -m 755 "$form" "$dir/form-$cap"
    launcher=$(exec_line_target "$form")
    if [ -z "$launcher" ] || [ ! -f "$launcher" ]; then
      echo "the $cap form execs no launcher (found '${launcher:-nothing}')" >&2
      exit 1
    fi
    install -m 755 "$launcher" "$dir/launcher-$cap"
    replace "$dir/form-$cap" "$launcher" "$dir/launcher-$cap"
  done
  install -m 755 "$(fam "$family" BASELINE)" "$dir/baseline"
}

## One case

family_bwrap=

# A family's own bwrap, so no case names a store path.
expand() { printf '%s' "${1//@BWRAP/$family_bwrap}"; }

apply_edits() { # dir index — the case's edits, in the order the table gives them
  local dir=$1 i=$2 j layer
  for j in "${!edit_case[@]}"; do
    if [ "${edit_case[j]}" != "$i" ]; then continue; fi
    layer=$dir/${edit_layer[j]}
    case ${edit_op[j]} in
      replace) replace "$layer" "$(expand "${edit_from[j]}")" "$(expand "${edit_to[j]}")" ;;
      drop) rm -f "$layer" ;;
    esac
  done
}

# A label counts only at the start of a failure line: the report quotes bind paths
# a caller controls, so a path spelling a label is not a verdict.
label_at() { awk -v want="FAIL $1" 'index($0, want) == 1 { found = 1 } END { exit !found }' "$2"; }

judge() { # index report status — why not, when the verdict is not the case's
  local i=$1 report=$2 status=$3
  local want=${case_outcome[i]} label reason
  local -a reasons=()
  case $want in
    pass)
      if [ "$status" -ne 0 ]; then
        reasons+=("the check refused it (exit $status)")
      fi
      if ! grep -q '^residue:' "$report"; then
        reasons+=("the report carries no residue")
      fi
      ;;
    refuse:*)
      label=${want#refuse:}
      if [ "$status" -ne 1 ]; then
        reasons+=("the check exited $status, want 1")
      elif ! label_at "$label" "$report"; then
        reasons+=("no failure line starts 'FAIL $label'")
      fi
      ;;
    *)
      echo "case ${case_name[i]}: unknown outcome '$want'" >&2
      exit 1
      ;;
  esac
  if [ -n "${case_absent[i]}" ] && label_at "${case_absent[i]}" "$report"; then
    reasons+=("a failure line starts 'FAIL ${case_absent[i]}'")
  fi
  for reason in "${reasons[@]}"; do
    printf '  %s\n' "$reason" >&2
  done
  [ "${#reasons[@]}" -eq 0 ]
}

work=$(mktemp -d "${TMPDIR:-/tmp}/quotient-fixtures.XXXXXX")
trap 'rm -rf "$work"' EXIT
passed=0
failed=0

for i in "${!case_name[@]}"; do
  name=${case_name[i]} family=${case_family[i]} dir=$work/$name report=$work/$name.report
  family_bwrap=$(fam "$family" BWRAP)
  exposure=$(fam "$family" EXPOSURE)
  secret_names=$(fam "$family" SECRET_ENV_NAMES)
  protect=$(fam "$family" PROTECT)
  if [ "${case_names[i]}" != @default ]; then
    secret_names=${case_names[i]}
  fi
  if [ "${case_expose[i]}" != @default ]; then
    exposure+=${exposure:+$'\n'}${case_expose[i]}
  fi
  if [ "${case_protect[i]}" != @default ]; then
    protect+=${protect:+$'\n'}${case_protect[i]}
  fi
  copy_family "$family" "$dir"
  apply_edits "$dir" "$i"
  status=0
  FORM_READ=$dir/form-read FORM_WRITE=$dir/form-write BASELINE=$dir/baseline \
    PREFIX=$(fam "$family" PREFIX) BWRAP=$family_bwrap NETWORK=$(fam "$family" NETWORK) \
    EXPOSURE=$exposure SECRET_ENV_NAMES=$secret_names PROTECT=$protect \
    bash "$CHECK" >"$report" 2>&1 || status=$?
  if judge "$i" "$report" "$status"; then
    printf 'PASS  %-26s %s\n' "$name" "${case_outcome[i]}"
    passed=$((passed + 1))
  else
    printf 'FAIL  %-26s want %s\n' "$name" "${case_outcome[i]}" >&2
    sed 's/^/    /' "$report" >&2
    failed=$((failed + 1))
  fi
done

printf '%d cases: %d passed, %d failed\n' "${#case_name[@]}" "$passed" "$failed"
[ "$failed" -eq 0 ]
