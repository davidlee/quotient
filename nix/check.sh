#!/usr/bin/env bash
# shellcheck disable=SC2016  # the quoted patterns are literal launcher text: no `$` in them expands
# The form-family check (design sec-3). It reads a built family's text — a form
# wrapper, the launcher that form's exec line names, and the baseline launcher —
# and asserts it against the contract. It launches nothing, because bwrap needs
# user namespaces the build sandbox does not grant, and it knows no Nix: the
# wrapper hands it the paths and policy in the environment below.
#
#   FORM_READ, FORM_WRITE       the two form wrappers
#   BASELINE                    the baseline launcher (no form wrapper)
#   PREFIX, BWRAP               the family's prefix and empty-environment bwrap
#   EXPOSURE, SECRET_ENV_NAMES  newline-separated lists, possibly empty
#   PROTECT                     newline-separated protect paths, possibly empty
#   NETWORK                     `1` when the jail shares the host's network
#
# Success writes the report and the residues to stdout, which the wrapper takes
# as $out. Failure prints every failed assertion with its rule label, the
# residues and a summary line, then exits 1.
set -euo pipefail

# The wrapper's inputs. An empty EXPOSURE, SECRET_ENV_NAMES or PROTECT is a
# policy, not an omission, so those three are defaulted; a path that is not there
# is a broken wrapper, refused below with the rest, labelled, so a caller reads a
# report and not a tool's first error.
: "${PREFIX:?}" "${NETWORK:?}"
FORM_READ=${FORM_READ-}
FORM_WRITE=${FORM_WRITE-}
BASELINE=${BASELINE-}
BWRAP=${BWRAP-}
EXPOSURE=${EXPOSURE-}
SECRET_ENV_NAMES=${SECRET_ENV_NAMES-}
PROTECT=${PROTECT-}

# The words the rules read, in the normalised (quote-stripped) form: the session
# variable the form exports, the mask token that opens the builder's tail, the
# secret descriptor, the builder's default state directory, and bwrap's mount
# operations — every flag that puts something in the jail, with the operands it
# takes (its last one being the target), so a caller's flag is read wherever it
# appears and a form that names one has taken a permission into its own hands.
session_var="\$QUOTIENT_ACTIVE_SESSION_DIR"
mask_token="\${quotient_mask[@]}"
secret_fd="\$quotient_secret_fd"
state_dir='${XDG_STATE_HOME:-$HOME/.local/state}/quotient'
# That directory's mask line as the builder writes it: (i) compares the line's
# raw text with this one, since the normalised read cannot tell a quoted
# expression from the literal path that spells the same characters.
state_line="[ -e \"$state_dir\" ] && quotient_mask+=(--tmpfs \"$state_dir\")"
# Every flag that puts something in the jail, with the operands it takes (its
# last one being the target), so a caller's flag is read wherever it appears and
# a form that names one has taken a permission into its own hands. `--overlay`
# takes its write source, its work directory and its destination; the two
# single-mount variants take a destination alone. `--overlay-src` is no mount:
# it names a source, and the destination is the `--overlay` that uses it.
mount_ops=(
  --bind:2 --ro-bind:2 --bind-try:2 --ro-bind-try:2 --dev-bind:2 --dev-bind-try:2
  --tmpfs:1 --proc:1 --dev:1 --mqueue:1 --dir:1 --remount-ro:1
  --symlink:2 --file:2 --bind-data:2 --ro-bind-data:2 --bind-fd:2 --ro-bind-fd:2
  --chmod:2 --overlay:3 --tmp-overlay:1 --ro-overlay:1
)
mount_flags=("${mount_ops[@]%%:*}")

# The secret descriptor's open, as the command it must be: a line that merely
# mentions it opens nothing.
secret_open='^exec \{quotient_secret_fd\}<'

# The two shapes the builder emits for a mask append, each written once: (c)
# reads them to forbid every other append and (i) to parse the mask. The plain
# shape is the default state directory's alone; a protect path's append sits
# behind a directory test naming the same path, so an existing file fails the
# launch instead of becoming a mount. Both are written against the normalised
# text, so the printf format's own quotes are not in the line they match.
mask_plain='^\[ -e (.+) \] && quotient_mask\+=\(--tmpfs (.+)\)$'
mask_guarded='^\[ -e (.+) \] && \{ \[ -d (.+) \] \|\| \{ printf quotient: protect path %s is not a directory\\n (.+) >&2; exit 1; \}; quotient_mask\+=\(--tmpfs (.+)\); \}$'

# Normalisation, once per launcher (sec-3): quotes of either kind stripped, so a
# caller's raw argument and a jail.nix-rendered one read alike; every run of
# whitespace — a tab among them — reduced to one separator, which is how bwrap
# reads its arguments; store hashes folded, so a nixpkgs or jail.nix bump is not
# drift. A value the wrapper names is read by the same steps, so a protect path
# and the mask line that mounts it are compared normalised alike.
strip_quotes='s/["'\'']//g'
squeeze='s/[[:space:]]+/ /g'
fold_store='s|/nix/store/[a-z0-9]{32}-|/nix/store/*-|g'
normalise_expr=(-e "$strip_quotes" -e "$squeeze" -e "$fold_store")

fails=()
work=

## Assertions, accumulated

# Remember a failed assertion with its rule label, so every failure is printed
# at the end rather than only the first. A failure line begins `FAIL <label>`,
# and a reader looks for a label there and nowhere else: the residues quote bind
# paths, which a caller controls, and nothing quoted there is a verdict.
fail() { fails+=("FAIL $1: $2"); }

# A literal present in / absent from a file.
must() { if ! grep -Fq -- "$3" "$2"; then fail "$1" "missing '$3'"; fi; }
must_not() { if grep -Fq -- "$3" "$2"; then fail "$1" "unexpected '$3'"; fi; }

# A literal absent as a whole word, so `--dev` does not match inside `--dev-bind`
# where the flag's own name is meant.
must_not_word() {
  if grep -qE -- "(^|[[:space:]\"'])$3([[:space:]\"']|$)" "$2"; then
    fail "$1" "unexpected '$3'"
  fi
}

# A file's executable text: its comment lines dropped, so a required statement is
# matched where the shell would run it, not where a caller commented it out.
code() { grep -vE -- '^[[:space:]]*#' "$1" || true; }

# How many times a literal occurs, 0 included.
count() { grep -oF -- "$2" "$1" | grep -c . || true; }

# The complete name operand of every --setenv on a line, one per line: a name
# that merely begins with a secret's name is another name.
setenv_names() { { grep -oE -- '--setenv [^ ]+' "$1" || true; } | awk '{ print $2 }'; }

# A diagnostic on one line; an empty value reads as nothing.
single_line() { printf '%s' "${1:-nothing}" | tr '\n' ';'; }

## Reading a launcher (sec-3)

# A launcher's text, normalised once.
normalise() { sed -E "${normalise_expr[@]}" "$1"; }

# The shape of a launcher's bwrap line — and of a form's exec line, which is the
# same shape: the `exec` whose first word is a command. A redirection is not a
# command, so jail.nix's descriptor execs (`exec {fd}<`, `exec 3</dev/null`) and
# a caller's combined-output redirect (`exec &>/dev/null`) are no line here. It
# is found by that shape and never by its target, so a launcher exec'ing a bare
# `bubblewrap` still yields a line, which is what (b) has to refuse (a check that
# only found `$BWRAP` lines could never fail (b)).
bwrap_shape='/^exec / && $2 !~ /^([0-9]+|\{[^}]*\})?(<|>|&>)/'

# A launcher's text as every rule reads it: normalised once (sec-3), then reduced
# to its executable lines.
launcher_text() { normalise "$1" | code /dev/stdin; }

# The command an exec line names: for a form, the launcher it execs, one level,
# because a family is a form wrapper around a jail.nix launcher (satan's check
# descends two).
exec_target() { awk "$bwrap_shape { print \$2; exit }" "$1" | tr -d '"'; }

# A bwrap line ending in a backslash continues on the next physical line, where
# no rule reads: refuse it rather than read half a command.
refuse_continuation() { # label line-file
  if grep -qE -- '\\$' "$2"; then
    fail "$1" "the bwrap line ends in a backslash, so its arguments continue unread"
  fi
}

# That line, written to the file $2; its tokens are read as an ordered array, so
# the order rules can read positions in it.
extract_line() { awk "$bwrap_shape { print; exit }" "$1" >"$2"; }

# Its line number in the launcher, for (h)'s opening-before-bwrap read.
bwrap_line_no() { awk "$bwrap_shape { print NR; exit }" "$1"; }

# The first, or the last (`last`), of the lines on stdin. Read with sed rather
# than head and tail, which stop early and would leave pipefail reading the
# writer's SIGPIPE as a failure.
pick_line() { if [ "${1-}" = last ]; then sed -n '$p'; else sed -n '1p'; fi; }

# The line number of the first line of $1 matching $2 — the last when $4 is
# `last` — with $3 the grep mode, `F` a literal (the default) or `E` a pattern;
# empty when nothing matches. A no-match here must not end the run: the report is
# worth more than any one assertion.
line_no_of() { # file pattern [F|E] [last]
  { grep -n"${3:-F}" -- "$2" "$1" || true; } | cut -d: -f1 | pick_line "${4-}"
}

# A bwrap line's own tokens: its words up to the `--` that precedes the program,
# less the two operands of each --setenv, which are an environment name and
# value, not options. Every rule about flags and about the tail's order reads
# these, so neither a value nor an application argument that spells a flag is
# read as that flag.
argv_tokens() { # line
  local -a words=()
  read -ra words <<<"$(<"$1")"
  local i=0
  while [ "$i" -lt "${#words[@]}" ]; do
    case ${words[i]} in
      --) break ;;
      --setenv) i=$((i + 3)) ;;
      *)
        printf '%s\n' "${words[i]}"
        i=$((i + 1))
        ;;
    esac
  done
}

# That the line carries $2 as an option bwrap reads. The tokens are read into a
# variable first: a `grep -q` on a pipe ends the reader early, and pipefail would
# then read the writer's SIGPIPE as "no such option".
has_option() {
  local opts
  opts=$(argv_tokens "$1")
  grep -qxF -- "$2" <<<"$opts"
}

# How many times the line carries $2 as an option bwrap reads.
option_count() { argv_tokens "$1" | grep -cxF -- "$2" || true; }

# A required option, there or not there, read the same way: as an option bwrap
# reads, rather than as the value of a --setenv that happens to spell it.
must_option() { if ! has_option "$2" "$3"; then fail "$1" "missing option '$3'"; fi; }
must_not_option() { if has_option "$2" "$3"; then fail "$1" "unexpected option '$3'"; fi; }

# How many times the option $2 takes the complete operand $3, read as option
# tokens: a descriptor whose name merely begins with it is another descriptor.
option_operand_count() { # line option operand
  local -a words=()
  mapfile -t words < <(argv_tokens "$1")
  local i n=0
  for i in "${!words[@]}"; do
    if [ "${words[i]}" = "$2" ] && [ "${words[i + 1]-}" = "$3" ]; then
      n=$((n + 1))
    fi
  done
  printf '%s\n' "$n"
}

# A mount target as the kernel resolves it: repeated slashes and `/./` collapse,
# and a trailing `/.` or slash names the same directory, so `//tmp`, `/tmp/`,
# `/./tmp` and `/tmp/.` are all `/tmp`. The steps run to a fixed point, because
# one pass over `/././tmp/./` leaves a `/./` behind.
canonical_target() {
  local path=$1 before=
  while [ "$path" != "$before" ]; do
    before=$path
    path=$(printf '%s\n' "$path" |
      sed -E -e 's|//+|/|g' -e 's|/\./|/|g' -e 's|/\.$|/|' -e 's|(.)/+$|\1|')
  done
  printf '%s\n' "$path"
}

# Every mount on a bwrap line, one per line as `flag target`: the target of a
# bwrap mount operation is its last operand, which every mount flag takes.
mounts() {
  local -a words=()
  mapfile -t words < <(argv_tokens "$1")
  local i j op
  for i in "${!words[@]}"; do
    for op in "${mount_ops[@]}"; do
      if [ "${words[i]}" = "${op%:*}" ]; then
        j=$((i + ${op##*:}))
        printf '%s %s\n' "${words[i]}" "$(canonical_target "${words[j]-}")"
      fi
    done
  done
}

# The mounts on a bwrap line whose target is $2.
mounts_to() { mounts "$1" | awk -v target="$2" '$NF == target'; }

# Every bind triple in a launcher, sorted and unique (lifted from satan): the
# form's set minus the baseline's is the residue (f) reads. A device bind is a
# read-write bind, so it is in the set: (f) and (g) are about the permissions a
# caller ends up with, and the flag's name is no part of that.
bind_words() {
  {
    grep -oE -- '--(ro-|dev-)?bind(-try)? [^ ]+ [^ ]+' "$1" || true
  } |
    sed -E "$fold_store" |
    sort -u
}

# The index of the first token of the array named $1 that equals $2.
index_of() {
  local -n haystack=$1
  local needle=$2 i
  for i in "${!haystack[@]}"; do
    if [ "${haystack[i]}" = "$needle" ]; then
      printf '%s\n' "$i"
      return 0
    fi
  done
  return 1
}

## The tail's order (the order half of (c), shared with (i))

# The mask token opens the tail; after it the only mounts are this capability's
# root bind and the session bind, in that order, then --chdir $quotient_root.
# Nothing may follow the session bind but the finaliser, so a caller's bind
# cannot slip behind it.
check_tail() { # label root line-file
  local label=$1 root=$2
  local -a tail_tokens=()
  mapfile -t tail_tokens < <(argv_tokens "$3")
  local -a expected=(
    "$root" "\$quotient_root" "\$quotient_root"
    --bind "$session_var" "$session_var"
    --chdir "\$quotient_root"
  )
  local mask i flag
  if ! mask=$(index_of tail_tokens "$mask_token"); then
    fail "$label" "the tail does not open with $mask_token"
    return
  fi
  for i in "${!expected[@]}"; do
    if [ "${tail_tokens[mask + 1 + i]:-}" != "${expected[i]}" ]; then
      fail "$label" "tail token $((mask + 2 + i)) is '${tail_tokens[mask + 1 + i]:-}', expected '${expected[i]}'"
    fi
  done
  for i in "${!tail_tokens[@]}"; do
    # The positions compared above are the tail's own, root and session bind
    # included; a mount flag from there on is a caller's, and whatever it mounts
    # it does so behind the session bind.
    if [ "$i" -le "$((mask + ${#expected[@]}))" ]; then
      continue
    fi
    for flag in "${mount_flags[@]}"; do
      if [ "${tail_tokens[i]}" = "$flag" ]; then
        fail "$label" "'$flag' at tail position $((i - mask)) is not the root or the session bind"
      fi
    done
  done
}

## One capability: the form, then the launcher it execs

check_capability() {
  local cap=$1 form=$2
  local a="(a) $cap" b="(b) $cap" c="(c) $cap" d="(d) $cap" e="(e) $cap"
  local f="(f) $cap" h="(h) $cap" i="(i) $cap"
  # This capability's root flag; every other mount flag on the root is another
  # capability's mount, or a caller's.
  local root flag
  local -a other_flags=()
  case $cap in
    read) root=--ro-bind ;;
    write) root=--bind ;;
  esac
  for flag in "${mount_flags[@]}"; do
    if [ "$flag" != "$root" ]; then other_flags+=("$flag"); fi
  done

  # (a) The form is sec-2's anatomy: three guards on the active session
  # directory, each predicate on the line carrying its own exit 64, then a
  # direct exec that names no jail flag of its own. A form that is not there is a
  # broken wrapper: say so under this label and read everything else.
  if [ ! -f "$form" ]; then
    fail "$a" "no form at '${form:-nothing}'"
    return
  fi
  local form_code=$work/$cap-form guard exits exit_lines
  code "$form" >"$form_code"
  exit_lines=$(grep -F -- 'exit 64' "$form_code" || true)
  for guard in '[ "$#" -ge 1 ]' 'case "$session_dir" in /*)' '[ -d "$session_dir" ]'; do
    if ! grep -Fq -- "$guard" <<<"$exit_lines"; then
      fail "$a" "no line carries both '$guard' and its exit 64"
    fi
  done
  exits=$(count "$form_code" 'exit 64')
  if [ "$exits" -ne 3 ]; then
    fail "$a" "the form carries $exits 'exit 64' guards, want exactly three"
  fi
  must "$a" "$form_code" 'session_dir=$1'
  must "$a" "$form_code" 'shift'
  must "$a" "$form_code" 'export QUOTIENT_ACTIVE_SESSION_DIR="$session_dir"'
  must_not "$a" "$form_code" ' -- '
  must_not "$a" "$form_code" '$2'
  for flag in "${mount_flags[@]}"; do
    must_not_word "$a" "$form_code" "$flag"
  done

  local launcher
  launcher=$(exec_target "$form")
  if [ -z "$launcher" ] || [ ! -f "$launcher" ]; then
    fail "$a" "the form execs no launcher (found '${launcher:-nothing}')"
    return
  fi
  local exec_line
  exec_line=$(awk '/^exec \//{ print; exit }' "$form")
  if [ "$exec_line" != "exec $launcher \"\$@\"" ]; then
    fail "$a" "the form's exec line is '$exec_line', want 'exec <launcher> \"\$@\"'"
  fi

  # The launcher's text as every rule reads it, the bwrap line, and that line's
  # number, which (h)'s open and (i)'s append order are read against.
  local text=$work/$cap-launcher line=$work/$cap-line bwrap_at raw=$work/$cap-raw
  launcher_text "$launcher" >"$text"
  extract_line "$text" "$line"
  bwrap_at=$(bwrap_line_no "$text")
  code "$launcher" >"$raw"
  refuse_continuation "$c" "$line"

  # (b) The launcher execs the family's empty-environment bwrap. The target is
  # compared unfolded: folding would read any `bwrap` in the store — a caller's
  # wrapper — as the family's.
  local target
  target=$(exec_target "$launcher")
  if [ "$target" != "$BWRAP" ]; then
    fail "$b" "the launcher execs '${target:-nothing}', not $BWRAP"
  fi

  # (c) This capability's root flag, and only it; one assignment to the root and
  # one mask declaration, so no caller runtime code can reassign either.
  must "$c" "$line" "$root \$quotient_root \$quotient_root"
  for flag in "${other_flags[@]}"; do
    must_not "$c" "$line" "$flag \$quotient_root"
  done
  local roots masks append expr
  roots=$(grep -F -- 'quotient_root=' "$text" || true)
  if [ "$roots" != "quotient_root=\$(pwd -P)" ]; then
    fail "$c" "quotient_root must be assigned once, as \$(pwd -P); found: $(single_line "$roots")"
  fi
  # A single-quoted occurrence of one of the builder's own expressions is the
  # literal that spells it, not the value it names: nothing expands, so the
  # mount it asks for is a path of the jail's making. (c) reads the raw text for
  # this, because the normalised read has already dropped the quotes.
  for expr in "\$quotient_root" "$session_var" "$state_dir"; do
    if grep -qF -e "'$expr" -e "$expr'" "$raw"; then
      fail "$c" "'$expr' is single-quoted, so it names a literal and not the value the builder passes"
    fi
  done
  masks=$(grep -cxF -- 'quotient_mask=()' "$text" || true)
  if [ "$masks" -ne 1 ]; then
    fail "$c" "quotient_mask=() is declared $masks times, want exactly once"
  fi
  while IFS= read -r append; do
    fail "$c" "a quotient_mask append is not in one of the builder's mask shapes: $append"
  done < <(grep -F -- 'quotient_mask+=' "$text" | grep -vE -- "$mask_plain|$mask_guarded")
  check_tail "$c" "$root" "$line"

  # (d) The jail's own isolation: it dies with its parent, has no environment of
  # the server's, and mounts nothing of the host's /tmp — a mount's target read
  # as the kernel resolves it, so `//tmp` is /tmp. The isolation flags are read
  # as options, so an environment value that spells one is no comfort.
  for guard in --die-with-parent --clearenv --unshare-user --unshare-ipc \
    --unshare-pid --unshare-uts --unshare-cgroup; do
    must_option "$d" "$line" "$guard"
  done
  if [ "$NETWORK" = 0 ]; then
    must_option "$d" "$line" --unshare-net
    must_not_option "$d" "$line" --share-net
  else
    must_not_option "$d" "$line" --unshare-net
  fi
  local tmp_mounts
  tmp_mounts=$(mounts_to "$line" /tmp)
  if [ "$tmp_mounts" != '--tmpfs /tmp' ]; then
    fail "$d" "the jail must mount /tmp exactly once, as --tmpfs /tmp; found: $(single_line "$tmp_mounts")"
  fi
  local chdirs
  chdirs=$(option_count "$line" --chdir)
  if [ "$chdirs" -ne 1 ]; then
    fail "$d" "the bwrap line carries $chdirs --chdir flags, want exactly one"
  fi

  # (e) Nothing of the server's own namespace reaches the jail: no QUOTIENT_
  # variable on bwrap's argv, and no session home, run directory or policy path.
  if grep -qE -- '--setenv QUOTIENT_' "$line"; then
    fail "$e" "bwrap's argv sets a QUOTIENT_ variable"
  fi
  for guard in QUOTIENT_SESSION_HOME QUOTIENT_RUN_DIR QUOTIENT_POLICY; do
    must_not "$e" "$line" "$guard"
  done

  # (f) The bind set is the baseline's plus exactly this capability's root bind
  # and the session bind: nothing dropped, nothing else added, so no caller
  # permission has moved between the form and its baseline.
  bind_words "$text" >"$work/$cap-binds"
  printf '%s\n' "$root \$quotient_root \$quotient_root" "--bind $session_var $session_var" >"$work/$cap-expected"
  bind_words "$work/$cap-expected" >"$work/$cap-expected-set"
  comm -13 "$work/baseline-binds" "$work/$cap-binds" >"$work/$cap-added"
  comm -23 "$work/baseline-binds" "$work/$cap-binds" >"$work/$cap-dropped"
  if ! cmp -s "$work/$cap-expected-set" "$work/$cap-added" || [ -s "$work/$cap-dropped" ]; then
    fail "$f" "the launcher's bind set is not the baseline plus the root bind and the session bind"
  fi

  # (h) A secret reaches the jail only through its descriptor: no name from
  # SECRET_ENV_NAMES among the names bwrap's argv sets, the descriptor opened and
  # passed at most once — exactly once when the family has secrets — and the open
  # on a line that runs, before the bwrap line.
  local names opens args opened_at bad_h=0 name
  names=$(setenv_names "$line")
  while IFS= read -r name; do
    if [ -n "$name" ] && grep -qxF -- "$name" <<<"$names"; then
      fail "$h" "bwrap's argv sets the secret name '$name'"
    fi
  done <<<"$SECRET_ENV_NAMES"
  opens=$(grep -cE -- "$secret_open" "$text" || true)
  args=$(option_operand_count "$line" --args "$secret_fd")
  if [ "$opens" -gt 1 ] || [ "$args" -gt 1 ] || [ "$opens" -ne "$args" ]; then
    bad_h=1
  fi
  if [ -n "$SECRET_ENV_NAMES" ] && [ "$opens" -ne 1 ]; then
    bad_h=1
  fi
  if [ "$bad_h" -ne 0 ]; then
    fail "$h" "the secret descriptor is opened $opens times and passed $args times: want at most once each, the same, and once when the family has secrets"
  fi
  if [ "$opens" -gt 0 ]; then
    opened_at=$(line_no_of "$text" "$secret_open" E)
    if [ -n "$bwrap_at" ] && [ "$opened_at" -ge "$bwrap_at" ]; then
      fail "$h" "the secret descriptor is opened after the bwrap line"
    fi
  fi

  # (i) The mask is built from the default state directory and the protect
  # paths, each append behind its own existence test, in the order that builds
  # it — declared, filled, then expanded — and it opens the tail. The state
  # directory's line is the plain shape; every other append is a protect path's
  # and carries the directory test naming the path it tests and mounts. The
  # policy names the protect paths, and each of them has exactly one such line:
  # a path without its line is left unmasked, and a line the policy does not
  # name is a mask the builder never writes.
  local appends parsed=0 state=0 guarded=0
  local kind test_word mount_word dir_word printf_word declared first_append last_append
  : >"$work/protect-masked"
  appends=$(grep -cF -- 'quotient_mask+=' "$text" || true)
  while IFS=$'\t' read -r kind test_word mount_word dir_word printf_word; do
    parsed=$((parsed + 1))
    if [ "$test_word" != "$mount_word" ]; then
      fail "$i" "the mask tests '$test_word' but mounts '$mount_word'"
    fi
    if [ "$kind" = plain ]; then
      if [ "$test_word" = "$state_dir" ]; then
        state=$((state + 1))
      else
        fail "$i" "a protect path's mask line lacks its directory test: $test_word"
      fi
    else
      if [ "$dir_word" != "$test_word" ] || [ "$printf_word" != "$test_word" ]; then
        fail "$i" "the directory test of '$test_word' names '$dir_word' and '$printf_word'"
      fi
      if [ "$test_word" = "$state_dir" ]; then
        fail "$i" "the default state directory's mask line must keep the plain shape"
      fi
      printf '%s\n' "$test_word" >>"$work/protect-masked"
      guarded=$((guarded + 1))
    fi
  done < <(sed -nE -e "s@$mask_plain@plain\t\1\t\2@p" \
    -e "s@$mask_guarded@guarded\t\1\t\4\t\2\t\3@p" "$text")
  if [ "$appends" -eq 0 ]; then
    fail "$i" "the launcher masks nothing"
  fi
  if [ "$parsed" -ne "$appends" ]; then
    fail "$i" "a mask append is neither the state line's plain shape nor a protect path's guarded shape"
  fi
  if [ "$state" -ne 1 ]; then
    fail "$i" "the mask names the default state directory $state times, want once"
  fi
  # The state directory's line is the builder's own text, compared as written: a
  # quoted-to-a-literal expression reads the same normalised, and only the raw
  # line tells the expression from the path that spells it.
  local state_raw
  state_raw=$(grep -F -- 'quotient_mask+=' "$raw" | grep -F -- "$state_dir" || true)
  if [ "$state_raw" != "$state_line" ]; then
    fail "$i" "the default state directory's mask line is not the builder's: $(single_line "$state_raw")"
  fi
  # The policy's protect paths, normalised as the launcher text is, against the
  # guarded lines this launcher carries.
  printf '%s\n' "$PROTECT" | sed -E "${normalise_expr[@]}" -e '/^$/d' >"$work/protect-policy"
  local path masked protect_paths
  while IFS= read -r path; do
    masked=$(grep -cxF -- "$path" "$work/protect-masked" || true)
    if [ "$masked" -ne 1 ]; then
      fail "$i" "the protect path '$path' has $masked guarded mask lines, want exactly one"
    fi
  done <"$work/protect-policy"
  protect_paths=$(wc -l <"$work/protect-policy")
  if [ "$guarded" -gt "$protect_paths" ]; then
    fail "$i" "the launcher masks $guarded protect paths but the policy names $protect_paths: a masked path is not one the policy protects"
  fi
  declared=$(line_no_of "$text" 'quotient_mask=()')
  first_append=$(line_no_of "$text" 'quotient_mask+=')
  last_append=$(line_no_of "$text" 'quotient_mask+=' F last)
  if [ -n "$declared" ] && [ -n "$first_append" ] && [ "$declared" -ge "$first_append" ]; then
    fail "$i" "the mask is declared on line $declared, after an append on line $first_append"
  fi
  if [ -n "$last_append" ] && [ -n "$bwrap_at" ] && [ "$last_append" -ge "$bwrap_at" ]; then
    fail "$i" "a mask append on line $last_append does not precede the bwrap line on $bwrap_at"
  fi
  local mask_expansions
  mask_expansions=$(option_count "$line" "$mask_token")
  if [ "$mask_expansions" -ne 1 ]; then
    fail "$i" "the bwrap line expands the mask $mask_expansions times, want once"
  fi
}

## The baseline

# The baseline is a launcher, not a form: it must contribute none of the form's
# own tail, no bind of the root the tail computes, and no rw bind the policy
# does not call exposed. Its bind set is read once, before the forms.
check_baseline() {
  local text=$work/baseline-launcher line=$work/baseline-line
  if [ ! -f "$BASELINE" ]; then
    fail "(e) baseline" "no baseline at $BASELINE"
    printf '' >"$work/baseline-binds"
    return
  fi
  launcher_text "$BASELINE" >"$text"
  extract_line "$text" "$line"
  refuse_continuation "(e) baseline" "$line"
  bind_words "$text" >"$work/baseline-binds"

  local root_binds
  root_binds=$(mounts_to "$line" "\$quotient_root")
  if [ -n "$root_binds" ]; then
    fail "(e) baseline" "the baseline binds \$quotient_root: $(single_line "$root_binds")"
  fi

  local spec source
  printf '%s\n' "$EXPOSURE" | sed -E "$fold_store" >"$work/exposure"
  # Every rw bind, the device flags among them: `bind_words` keeps both kinds,
  # since a device bind is a read-write mount too.
  while IFS= read -r spec; do
    source=$(printf '%s\n' "$spec" | awk '{ print $2 }')
    if ! grep -qxF -- "$source" "$work/exposure"; then
      fail "(g) baseline" "the baseline binds '$source' read-write, which EXPOSURE does not list"
    fi
  done < <(grep -E -- '^--(dev-)?bind(-try)? ' "$work/baseline-binds" || true)
}

## The report

# One bind residue, in both directions, so a reviewer sees what (f) compared.
residue_binds() { # heading file
  printf 'residue: %s\n' "$1"
  if [ -s "$2" ]; then
    sed 's/^/residue:   /' "$2"
  else
    printf 'residue:   (none)\n'
  fi
}

# What the check cannot see (sec-3), printed on success too so a reviewer reads
# it beside the verdict.
residues() {
  local cap
  for cap in read write; do
    if [ -f "$work/$cap-added" ]; then
      residue_binds "$cap: binds the form has over the baseline" "$work/$cap-added"
      residue_binds "$cap: binds the baseline has and the form lacks" "$work/$cap-dropped"
    fi
  done
  cat <<'EOF'
residue: this text check cannot see
residue:   binds delivered at runtime, through a caller's --args descriptor or a caller appended to RUNTIME_ARGS
residue:   mounts whose source or target holds a space or a command substitution, which no token rule catches
residue:   an environment value that spans several words, which the normalised read splits into arguments either side of it
residue:   whether the mounts behave as the text says — the runtime probe's subject
EOF
}

finish() {
  if [ "${#fails[@]}" -eq 0 ]; then
    printf '%s: the read and write forms pass\n' "$PREFIX"
    if [ "$NETWORK" = 1 ]; then
      printf '  network: shared\n'
    else
      printf '  network: isolated\n'
    fi
    residues
    return 0
  fi
  local failure
  for failure in "${fails[@]}"; do
    printf '%s\n' "$failure" >&2
  done
  residues >&2
  printf '%s: %d assertion(s) failed\n' "$PREFIX" "${#fails[@]}" >&2
  return 1
}

main() {
  work=$(mktemp -d "${TMPDIR:-/tmp}/quotient-forms.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  # The baseline's bind set first: both forms are compared against it.
  check_baseline
  check_capability read "$FORM_READ"
  check_capability write "$FORM_WRITE"
  finish
}

main "$@"
