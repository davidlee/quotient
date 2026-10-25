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

# The words the rules read, each as bash reads it: the session
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
# raw text with this one, since a word read by bash cannot tell a quoted
# expression from the single-quoted literal that spells the same characters.
state_line="[ -e \"$state_dir\" ] && quotient_mask+=(--tmpfs \"$state_dir\")"
# Every flag that puts something in the jail — every mount operation — so a
# caller's flag is read wherever it appears and a form that names one has taken
# a permission into its own hands. `--overlay` takes its write source, its work
# directory and its destination; the two single-mount variants take a
# destination alone. `--overlay-src` is no mount: it names a source, and the
# destination is the `--overlay` that uses it.
mount_ops=(
  --bind --ro-bind --bind-try --ro-bind-try --dev-bind --dev-bind-try
  --tmpfs --proc --dev --mqueue --dir --remount-ro
  --symlink --file --bind-data --ro-bind-data --bind-fd --ro-bind-fd
  --chmod --overlay --tmp-overlay --ro-overlay
)
# Every option bwrap takes operands for, with how many, so one scan reads every
# operand as an operand: a caller's word cannot pass for a flag, nor a flag's
# operands for options. A mount operation's last operand is its target.
# Checked against bwrap 0.12.0's `--help`, entry for entry: the options it lists
# with no operands need no entry, since `arity_of` answers 0 for anything here.
op_arity=(
  --bind:2 --ro-bind:2 --bind-try:2 --ro-bind-try:2 --dev-bind:2 --dev-bind-try:2
  --tmpfs:1 --proc:1 --dev:1 --mqueue:1 --dir:1 --remount-ro:1
  --symlink:2 --file:2 --bind-data:2 --ro-bind-data:2 --bind-fd:2 --ro-bind-fd:2
  --chmod:2 --overlay:3 --tmp-overlay:1 --ro-overlay:1 --overlay-src:1
  --hostname:1 --uid:1 --gid:1 --chdir:1 --setenv:2 --unsetenv:1 --args:1
  --userns:1 --userns2:1 --userns-block-fd:1 --pidns:1 --sync-fd:1 --block-fd:1
  --info-fd:1 --json-status-fd:1 --seccomp:1 --add-seccomp-fd:1 --lock-file:1
  --perms:1 --size:1 --exec-label:1 --file-label:1 --argv0:1
  --cap-add:1 --cap-drop:1
)

# The secret descriptor's open, as the command it must be: a line that merely
# mentions it opens nothing.
secret_open='^exec \{quotient_secret_fd\}<'

# The two shapes the builder emits for a mask append, each written once: (c)
# reads them to forbid every other append and (i) to parse the mask. The plain
# shape is the default state directory's alone; a protect path's append sits
# behind a directory test naming the same path, so an existing file fails the
# launch instead of becoming a mount. Both match the raw text, and each word
# they capture is a shell word, read by `one_word` as bash reads it.
mask_plain='^\[ -e (.+) \] && quotient_mask\+=\(--tmpfs (.+)\)$'
mask_guarded='^\[ -e (.+) \] && \{ \[ -d (.+) \] \|\| \{ printf '\''quotient: protect path %s is not a directory\\n'\'' (.+) >&2; exit 1; \}; quotient_mask\+=\(--tmpfs (.+)\); \}$'

# Reading a line as bash does. The characters that make a line more than words:
# `~`, then `$` and every character that can end a word or start an operator — a
# command boundary, a redirection, a subshell, a comment — or start an expansion
# bash makes at launch: a backtick, a glob, a brace. Each has an inert
# control byte of its own, at the same position (none of them \001, which bash
# keeps for itself), so bash parses the quoting of a line in which nothing can
# expand or run, and the bytes map back after: `"$quotient_root"` is the word
# `$quotient_root`, a symbol a rule can name. In the second parse each of the
# operators is two inert bytes around a space: quoted, the space is part of the
# word; unquoted, it ends one. So an unquoted `$` — an expansion bash would
# split into words at launch, an ANSI-C or a locale quote — is refused with the
# operators, as are an unquoted glob and brace, and an unquoted `~` is read as
# written. A backtick stands in the second parse as a quoted space then an
# unquoted one, so it ends a word unless single quotes hold it: inside double
# quotes it opens a command substitution, whose own quotes a parse with the
# backtick inert would read as closing the double quotes.
tilde='~'
operators='$;&|<>()#`*?[{'
inert=$'\002\003\004\005\006\007\016\017\020\023\024\025\026\027\030'
split_mark=$'\021 \022'
backtick_mark="\"$split_mark\"$split_mark"
# The parameter expansions a line may carry: a name, an array's every element, or
# a default that holds no quote, escape, substitution or nested brace — so a
# quote never stands inside one, where the first parse would misread it. The
# builder's own (`${quotient_mask[@]}`, `${LANG:-C.UTF-8}`, the state
# directory's) are all of these.
brace_body='^[A-Za-z_][A-Za-z0-9_]*(\[@\]|:-([^]['"'"'"\\`$(){}]|\$[A-Za-z_][A-Za-z0-9_]*)*)?$'

# Normalisation, for the builder's own line shapes only (the form's guards, the
# root's assignment, the mask declaration, the secret descriptor's open): quotes
# of either kind stripped, every run of whitespace reduced to one separator,
# store hashes folded so a nixpkgs or jail.nix bump is not drift. The bwrap line
# and the mask lines' words are read by bash instead, above.
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

# A launcher's text as the line-shape rules read it: normalised once, then reduced
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

# That line, written to the file $2.
extract_line() { awk "$bwrap_shape { print; exit }" "$1" >"$2"; }

# The words bash reads from the line $1, one per line. Status 1, with the reason
# on stdout, when bash would read the line as more than plain words: an operator
# or an expansion outside quotes, a backtick outside single quotes, a command
# substitution, an arithmetic or unreadable parameter expansion, an escaped `$`
# or backtick, an ANSI-C or locale quote, a control byte, or quoting that does
# not close. A line it reads otherwise than its words say is refused, never read
# the way a rule would like.
shell_words() { # line
  local line=$1 one split i c specials=$tilde$operators words count rest body
  # Inside double quotes `\$` is a `$` and `\`` a backtick, which the inert
  # byte standing for either would not be. A `$(` or a `$[` opens a context
  # whose quotes the parse below cannot follow; the builder writes neither, and
  # no `$` stands in a caller's single-quoted text.
  case $line in
    *'\`'*) echo 'an escaped backtick'; return 1 ;;
    *'\$'*) echo 'an escaped $'; return 1 ;;
    *'$('* | *'$['*) echo 'a command substitution or an arithmetic expansion'; return 1 ;;
  esac
  rest=$line
  while [[ $rest == *'${'* ]]; do
    rest=${rest#*'${'}
    body=${rest%%\}*}
    if [ "$body" = "$rest" ] || ! [[ $body =~ $brace_body ]]; then
      echo "a parameter expansion other than a name or a plain default: \${$body"
      return 1
    fi
  done
  if [ "$(printf '%s' "$line" | LC_ALL=C tr -d '\001-\010\013-\037')" != "$line" ]; then
    echo 'a control byte'
    return 1
  fi
  one=$line split=${line//'`'/"$backtick_mark"}
  for ((i = 0; i < ${#specials}; i++)); do
    c=${specials:i:1}
    one=${one//"$c"/"${inert:i:1}"}
    if ((i < ${#tilde})); then
      split=${split//"$c"/"${inert:i:1}"}
    else
      split=${split//"$c"/"$split_mark"}
    fi
  done
  # The trailing `.` keeps a last empty word, which command substitution would
  # otherwise strip with its newline.
  if ! words=$( (set -f && set +B && eval "set -- $one" && printf '%s\n' "$@" && printf .) 2>/dev/null); then
    echo 'quoting that does not close'
    return 1
  fi
  words=${words%.}
  count=$( (set -f && set +B && eval "set -- $split" && printf '%s\n' "$#") 2>/dev/null) || count=-1
  if [ "$count" != "$(printf '%s' "$words" | grep -c '')" ]; then
    echo 'a shell operator or an expansion outside quotes, or a backtick outside single quotes'
    return 1
  fi
  printf '%s' "$words" | LC_ALL=C tr "$inert" "$specials"
}

# The one word bash reads from $1, or status 1.
one_word() {
  local words
  words=$(shell_words "$1") || return 1
  [ "$(printf '%s\n' "$words" | grep -c '')" -eq 1 ] || return 1
  printf '%s\n' "$words"
}

# The bwrap line's arguments, one per line, into the file $2: its words after
# `exec <bwrap>`. Status 1, with the reason on stdout, when the line is not
# plain words.
bwrap_args() { # raw-line-file out-file
  if ! shell_words "$(<"$1")" >"$2.words"; then
    cat "$2.words"
    : >"$2"
    return 1
  fi
  sed '1,2d' "$2.words" >"$2"
}

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

# A bwrap line's option stream: one record per word up to the `--` that precedes
# the program, `opt <word>` for a word in an option position and
# `operand <word>` for a word an option takes, by the arity table above. One
# scan feeds every rule about flags, operands and the tail's order, so neither a
# value nor an application argument that spells a flag is read as that flag, and
# what pi receives after the `--` is no word here at all.
argv_scan() { # argument-file
  local -a words=()
  mapfile -t words <"$1"
  local i=0 j n
  while [ "$i" -lt "${#words[@]}" ] && [ "${words[i]}" != -- ]; do
    printf 'opt %s\n' "${words[i]}"
    n=$(arity_of "${words[i]}")
    j=1
    while [ "$j" -le "$n" ] && [ "$((i + j))" -lt "${#words[@]}" ]; do
      printf 'operand %s\n' "${words[i + j]}"
      j=$((j + 1))
    done
    i=$((i + 1 + n))
  done
}

# How many operands bwrap's option $1 takes: none when it takes none.
arity_of() {
  local entry
  for entry in "${op_arity[@]}"; do
    if [ "${entry%:*}" = "$1" ]; then
      printf '%s\n' "${entry##*:}"
      return 0
    fi
  done
  printf '0\n'
}

# That stream, into the array the caller names $2: mapfile takes a name, so the
# name needs no nameref of its own.
argv_stream() { mapfile -t "$2" < <(argv_scan "$1"); }

# That stream's words, options and operands alike.
argv_words() { argv_scan "$1" | cut -d' ' -f2-; }

# Only its words in an option position: what bwrap is asked to do, never a value
# it is given.
option_words() { argv_scan "$1" | awk '$1 == "opt" { sub(/^opt /, ""); print }'; }

# The complete name operand of every --setenv bwrap reads, one per line: a name
# that merely begins with a secret's name is another name.
setenv_names() {
  argv_scan "$1" | awk '$1 == "opt" && $2 == "--setenv" { if (getline > 0) { sub(/^operand /, ""); print } }'
}

# That the line carries $2 as an option bwrap reads. The tokens are read into a
# variable first: a `grep -q` on a pipe ends the reader early, and pipefail would
# then read the writer's SIGPIPE as "no such option".
has_option() {
  local opts
  opts=$(option_words "$1")
  grep -qxF -- "$2" <<<"$opts"
}

# How many times the line carries $2 as an option bwrap reads.
option_count() { option_words "$1" | grep -cxF -- "$2" || true; }

# A required option, there or not there, read the same way: as an option bwrap
# reads, rather than as the value of a --setenv that happens to spell it.
must_option() { if ! has_option "$2" "$3"; then fail "$1" "missing option '$3'"; fi; }
must_not_option() { if has_option "$2" "$3"; then fail "$1" "unexpected option '$3'"; fi; }

# How many times the option $2 takes the complete operand $3, read from the
# stream: a descriptor whose name merely begins with it is another descriptor.
option_operand_count() { # line option operand
  local -a stream=()
  argv_stream "$1" stream
  local i n=0
  for i in "${!stream[@]}"; do
    if [ "${stream[i]}" = "opt $2" ] && [ "${stream[i + 1]-}" = "operand $3" ]; then
      n=$((n + 1))
    fi
  done
  printf '%s\n' "$n"
}

# A path as the kernel resolves it, lexically: repeated slashes, `.` segments
# and a trailing slash name nothing, and `..` climbs one segment, so `//tmp`,
# `/./tmp/`, `/tmp/.` and `/x/../tmp` are all `/tmp`. A path that does not open
# with `/` is anchored at its first segment (`~`, `$quotient_root`), and a `..`
# that would climb above that anchor is kept, after it: `~/../x` names a
# directory no text resolves, which `climbs` tells apart.
canonical_target() {
  local path=$1 anchor part
  local -a parts=() kept=()
  case $path in
    /*) anchor=/ ;;
    *)
      anchor=${path%%/*}
      path=${path#"$anchor"}
      ;;
  esac
  IFS=/ read -ra parts <<<"$path"
  for part in "${parts[@]}"; do
    case $part in
      '' | .) ;;
      ..)
        if [ "${#kept[@]}" -gt 0 ] && [ "${kept[-1]}" != .. ]; then
          unset 'kept[-1]'
        elif [ "$anchor" != / ]; then
          kept+=(..)
        fi
        ;;
      *) kept+=("$part") ;;
    esac
  done
  if [ "$anchor" = / ]; then
    (IFS=/ && printf '/%s\n' "${kept[*]}")
  elif [ "${#kept[@]}" -eq 0 ]; then
    printf '%s\n' "$anchor"
  else
    (IFS=/ && printf '%s/%s\n' "$anchor" "${kept[*]}")
  fi
}

# Whether a canonical path climbs above its anchor, into a directory no text
# names.
climbs() { [[ /$1/ == */../* ]]; }

# Whether $1 is one of bwrap's mount operations.
is_mount_op() {
  local op
  for op in "${mount_ops[@]}"; do
    if [ "$op" = "$1" ]; then return 0; fi
  done
  return 1
}

# The field separator of the records below: a byte no word can hold, since
# shell_words refuses a line that carries one.
sep=$'\037'

# Every mount on a bwrap line, one record per line, its fields as written and
# each ended by $sep: the flag, its target — its last operand, which the stream
# carries at the flag's arity — and the host sources it reads, which are a
# bind's source, an overlay's upper and work directories, and an
# `--overlay-src`, which names no target of its own (an empty field). A
# descriptor bind's source is the descriptor. The other mounts' first operands
# (a symlink's text, a data descriptor, a mode) name no host path.
mount_records() { # line-file
  local -a stream=() fields=() sources=()
  argv_stream "$1" stream
  local i n op flag word
  for i in "${!stream[@]}"; do
    if [ "${stream[i]%% *}" != opt ]; then continue; fi
    flag=${stream[i]#opt }
    case $flag in
      --bind | --ro-bind | --bind-try | --ro-bind-try | --dev-bind | --dev-bind-try | \
        --bind-fd | --ro-bind-fd | --overlay-src) sources=(1) ;;
      --overlay) sources=(1 2) ;;
      *) sources=() ;;
    esac
    n=$(arity_of "$flag")
    if [ "$flag" = --overlay-src ]; then
      fields=("$flag" '')
    elif is_mount_op "$flag"; then
      word=${stream[i + n]-}
      fields=("$flag" "${word#operand }")
    else
      continue
    fi
    for op in "${sources[@]}"; do
      word=${stream[i + op]-}
      fields+=("${word#operand }")
    done
    printf "%s$sep" "${fields[@]}"
    printf '\n'
  done
}

# Every mount on a bwrap line, one per line as `flag target`, the target read
# as the kernel resolves it.
mounts() { # line-file
  local -a record
  while IFS=$sep read -ra record; do
    if [ "${record[0]}" != --overlay-src ]; then
      printf '%s%s%s\n' "${record[0]}" "$sep" "$(canonical_target "${record[1]}")"
    fi
  done < <(mount_records "$1")
}

# The mounts on a bwrap line whose target is $2.
mounts_to() { mounts "$1" | awk -F "$sep" -v target="$2" '$2 == target { print $1 " " $2 }'; }

# Every bind on a bwrap line, sorted and unique (lifted from satan), one per
# line with its fields separated by $sep, since a word may hold a space or a
# tab: the form's set minus the baseline's is the residue (f) reads. Read from the option
# stream, so a word after the `--` that spells a bind names no mount. A device
# bind is a read-write bind, so it is in the set: (f) and (g) are about the
# permissions a caller ends up with, and the flag's name is no part of that. An
# overlay is in it too, with its upper and work directories, which it writes on
# the host, and so is a descriptor bind, whose source is the descriptor.
bind_words() { # argument-file
  local -a stream=()
  argv_stream "$1" stream
  local i n op word
  local -a fields
  for i in "${!stream[@]}"; do
    case ${stream[i]} in
      'opt --bind' | 'opt --ro-bind' | 'opt --bind-try' | 'opt --ro-bind-try' | \
        'opt --dev-bind' | 'opt --dev-bind-try' | 'opt --bind-fd' | 'opt --ro-bind-fd' | \
        'opt --overlay') ;;
      *) continue ;;
    esac
    fields=("${stream[i]#opt }")
    n=$(arity_of "${fields[0]}")
    for ((op = 1; op <= n; op++)); do
      word=${stream[i + op]-}
      fields+=("${word#operand }")
    done
    (IFS=$sep && printf '%s\n' "${fields[*]}")
  done |
    sed -E "$fold_store" |
    sort -u
}

# The host paths a bind set writes, one per line: the source of every
# read-write bind, and an overlay's upper and work directories. A read-write
# descriptor bind writes whatever the descriptor opens, which the text cannot
# name: it is written as the descriptor, which no exposure path is.
rw_sources() { # bind-set-file
  awk -F "$sep" '
    $1 ~ /^--(dev-)?bind(-try)?$/ { print $2 }
    $1 == "--bind-fd" { print "descriptor " $2 }
    $1 == "--overlay" { print $2; print $3 }
  ' "$1"
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

# The mask token opens the tail; after it come the builder's piFiles binds — a
# read-only bind of a store path under ~/.pi/agent, none or more — then this
# capability's root bind and the session bind, in that order, then --chdir
# $quotient_root. Nothing may follow the session bind but the finaliser, so a
# caller's bind cannot slip behind it, nor between the mask and the root.
check_tail() { # label root line-file
  local label=$1 root=$2
  local -a stream=()
  argv_stream "$3" stream
  local -a expected=(
    "opt $root" 'operand $quotient_root' 'operand $quotient_root'
    'opt --bind' "operand $session_var" "operand $session_var"
    'opt --chdir' 'operand $quotient_root'
  )
  local mask start i flag
  if ! mask=$(index_of stream "opt $mask_token"); then
    fail "$label" "the tail does not open with $mask_token"
    return
  fi
  start=$((mask + 1))
  while [ "${stream[start]-}" = 'opt --ro-bind' ] &&
    pifiles_bind "${stream[start + 1]#operand }" "${stream[start + 2]#operand }"; do
    start=$((start + 3))
  done
  for i in "${!expected[@]}"; do
    if [ "${stream[start + i]-}" != "${expected[i]}" ]; then
      fail "$label" "tail word $((start + 1 + i)) is '${stream[start + i]-}', expected '${expected[i]}'"
    fi
  done
  for i in "${!stream[@]}"; do
    # The positions compared above are the tail's own, root and session bind
    # included; a mount flag from there on is a caller's, and whatever it mounts
    # it does so behind the session bind.
    if [ "$i" -lt "$((start + ${#expected[@]}))" ] || [ "${stream[i]%% *}" != opt ]; then
      continue
    fi
    flag=${stream[i]#opt }
    if is_mount_op "$flag"; then
      fail "$label" "'$flag' at tail position $((i - mask)) is not the root or the session bind"
    fi
  done
}

# Whether a read-only bind is one of the builder's piFiles binds: a store path
# at a path under ~/.pi/agent, each as the kernel resolves it.
pifiles_bind() { # source target
  [[ $(canonical_target "$1") == /nix/store/?* && $(canonical_target "$2") == \~/.pi/agent/?* ]]
}

## Protected state bound again elsewhere (j)

# A path as (j) compares it: the home's spellings (`$HOME`, `${HOME}`) read as
# `~`, the state home's (`$XDG_STATE_HOME`, `${XDG_STATE_HOME}`, the builder's
# defaulting expression) as its default `~/.local/state`, then slashes as the
# kernel reads them. The real home is unknown here, so a literal path into it
# compares as itself: a residue.
spelled_path() {
  local path=$1 spelling home
  for spelling in \
    '${XDG_STATE_HOME:-$HOME/.local/state}=~/.local/state' \
    '${XDG_STATE_HOME}=~/.local/state' '$XDG_STATE_HOME=~/.local/state' \
    '${HOME}=~' '$HOME=~'; do
    home=${spelling%%=*}
    case $path in
      "$home" | "$home"/*)
        path=${spelling#*=}${path#"$home"}
        break
        ;;
    esac
  done
  canonical_target "$path"
}

# Whether two compared paths overlap: one is the other or lies inside it, and
# `/` holds everything, as does a path that climbs above its anchor, which
# could be anywhere.
overlaps() {
  [ "$1" = "$2" ] || [ "$1" = / ] || [ "$2" = / ] || climbs "$1" || climbs "$2" ||
    [[ $2 == "$1"/* ]] || [[ $1 == "$2"/* ]]
}

# Every mount on the line whose source overlaps protected state — the default
# state directory or a protect path — at a target other than its own path, one
# per line: the mask covers the path it masks and no other, so such a mount
# shows the state wherever it lands. An `--overlay-src` names no target of its
# own and so never mounts at its own path, and a descriptor bind's source is
# whatever the descriptor opens, which may be protected state wherever it lands.
# A climbing path is never its own target: two of them may be any two paths.
protected_aliases() { # argument-file
  local -a protected=() record=()
  local protect source target compared path
  protected=("$(spelled_path "$state_dir")")
  while IFS= read -r protect; do
    if [ -n "$protect" ]; then protected+=("$(spelled_path "$protect")"); fi
  done <<<"$PROTECT"
  while IFS=$sep read -ra record; do
    case ${record[0]} in
      --bind-fd | --ro-bind-fd)
        printf '%s %s\n' "${record[0]}" "${record[2]}"
        continue
        ;;
    esac
    target=
    if [ "${record[0]}" != --overlay-src ]; then target=$(spelled_path "${record[1]}"); fi
    for source in "${record[@]:2}"; do
      compared=$(spelled_path "$source")
      if [ "$compared" = "$target" ] && ! climbs "$compared"; then continue; fi
      for path in "${protected[@]}"; do
        if overlaps "$compared" "$path"; then
          printf '%s %s\n' "${record[0]}" "$source"
          break
        fi
      done
    done
  done < <(mount_records "$1")
}

# Every mount path on the line that climbs above its anchor, one per line as
# `flag path`: such a mount lands in, or reads, a directory no text names.
climbing_mounts() { # argument-file
  local -a record=()
  local path
  while IFS=$sep read -ra record; do
    for path in "${record[@]:1}"; do
      if [ -n "$path" ] && climbs "$(spelled_path "$path")"; then
        printf '%s %s\n' "${record[0]}" "$path"
      fi
    done
  done < <(mount_records "$1")
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
  for flag in "${mount_ops[@]}"; do
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
  for flag in "${mount_ops[@]}"; do
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

  # The launcher's normalised text, which the builder's own line shapes are read
  # from; its raw executable text; the bwrap line, raw; and that line's
  # arguments as bash reads them, which every bwrap-line rule reads. The line's
  # number is the one (h)'s open and (i)'s append order are read against.
  local text=$work/$cap-launcher line=$work/$cap-line bwrap_at raw=$work/$cap-raw
  local raw_line=$work/$cap-raw-line unread
  launcher_text "$launcher" >"$text"
  bwrap_at=$(bwrap_line_no "$text")
  code "$launcher" >"$raw"
  extract_line "$raw" "$raw_line"
  refuse_continuation "$c" "$raw_line"

  # (b) The launcher execs the family's empty-environment bwrap. The target is
  # compared unfolded: folding would read any `bwrap` in the store — a caller's
  # wrapper — as the family's.
  local target
  target=$(exec_target "$launcher")
  if [ "$target" != "$BWRAP" ]; then
    fail "$b" "the launcher execs '${target:-nothing}', not $BWRAP"
  fi

  # A bwrap line bash would read as more than its words says nothing the rules
  # could rely on: refuse it, and read no rule over it.
  if ! unread=$(bwrap_args "$raw_line" "$line"); then
    fail "$c" "the bwrap line is not plain words: $unread"
    return
  fi

  # (c) This capability's root flag, and only it; one assignment to the root and
  # one mask declaration, so no caller runtime code can reassign either.
  if [ "$(option_operand_count "$line" "$root" '$quotient_root')" -eq 0 ]; then
    fail "$c" "missing '$root \$quotient_root \$quotient_root'"
  fi
  for flag in "${other_flags[@]}"; do
    if [ "$(option_operand_count "$line" "$flag" '$quotient_root')" -ne 0 ]; then
      fail "$c" "unexpected '$flag \$quotient_root'"
    fi
  done
  local roots masks append
  roots=$(grep -F -- 'quotient_root=' "$text" || true)
  if [ "$roots" != "quotient_root=\$(pwd -P)" ]; then
    fail "$c" "quotient_root must be assigned once, as \$(pwd -P); found: $(single_line "$roots")"
  fi
  # The builder's own operands are shell words it expands: the root bind's two,
  # the session bind's two and the chdir's one. Single-quoted, one of them is
  # the literal that spells it and the mount it asks for is a path of the jail's
  # making, so they are read as the builder writes them, from the raw line: the
  # words bash reads have already lost the quotes. Only these operands are read
  # this way — a caller's env value or protect path may spell the same
  # characters, and the builder escapes them as the literals they are — and the
  # state line's own text is (i)'s.
  must "$c" "$raw_line" "$root \"\$quotient_root\" \"\$quotient_root\""
  must "$c" "$raw_line" "--bind \"$session_var\" \"$session_var\""
  must "$c" "$raw_line" "--chdir \"\$quotient_root\""
  masks=$(grep -cxF -- 'quotient_mask=()' "$text" || true)
  if [ "$masks" -ne 1 ]; then
    fail "$c" "quotient_mask=() is declared $masks times, want exactly once"
  fi
  while IFS= read -r append; do
    fail "$c" "a quotient_mask append is not in one of the builder's mask shapes: $append"
  done < <(grep -F -- 'quotient_mask+=' "$raw" | grep -vE -- "$mask_plain|$mask_guarded")
  check_tail "$c" "$root" "$line"
  local climbing
  while IFS= read -r climbing; do
    fail "$c" "'$climbing' climbs above the path it is anchored at, into a directory no text names"
  done < <(climbing_mounts "$line")

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
  # variable among the names bwrap's argv sets, and no session home, run
  # directory or policy path among its words. Both read the option stream, so
  # neither is pi's own argument after the `--`.
  local set_name argv=$work/$cap-argv
  argv_words "$line" >"$argv"
  while IFS= read -r set_name; do
    case $set_name in
      QUOTIENT_*) fail "$e" "bwrap's argv sets the QUOTIENT_ variable '$set_name'" ;;
    esac
  done < <(setenv_names "$line")
  for guard in QUOTIENT_SESSION_HOME QUOTIENT_RUN_DIR QUOTIENT_POLICY; do
    must_not "$e" "$argv" "$guard"
  done
  # The secret descriptor sets the names the family declares, out of bwrap's
  # sight: a QUOTIENT_ name among them reaches pi all the same.
  while IFS= read -r set_name; do
    case $set_name in
      QUOTIENT_*) fail "$e" "the secret descriptor sets the QUOTIENT_ variable '$set_name'" ;;
    esac
  done <<<"$SECRET_ENV_NAMES"

  # (f) The bind set is the baseline's plus exactly this capability's root bind
  # and the session bind: nothing dropped, nothing else added, so no caller
  # permission has moved between the form and its baseline.
  bind_words "$line" >"$work/$cap-binds"
  # The expected set is written here, not read from a launcher: it needs no scan.
  printf "%s$sep%s$sep%s\\n" "$root" '$quotient_root' '$quotient_root' --bind "$session_var" "$session_var" |
    sed -E "$fold_store" | sort -u >"$work/$cap-expected-set"
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
  local appends parsed=0 state=0 guarded=0 raw_word word unreadable
  local kind test_word mount_word dir_word printf_word declared first_append last_append
  : >"$work/protect-masked"
  appends=$(grep -cF -- 'quotient_mask+=' "$raw" || true)
  while IFS=$sep read -r kind test_word mount_word dir_word printf_word; do
    parsed=$((parsed + 1))
    # Each captured word as bash reads it, so a protect path compares exactly
    # as the policy names it, an apostrophe or a space included.
    unreadable=
    for raw_word in test_word mount_word dir_word printf_word; do
      if [ -z "${!raw_word}" ]; then continue; fi
      if word=$(one_word "${!raw_word}"); then
        printf -v "$raw_word" '%s' "$word"
      else
        unreadable=1
      fi
    done
    if [ -n "$unreadable" ]; then
      fail "$i" "a mask line's word is not one plain shell word"
      continue
    fi
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
  done < <(sed -nE -e "s@$mask_plain@plain$sep\\1$sep\\2@p" \
    -e "s@$mask_guarded@guarded$sep\\1$sep\\4$sep\\2$sep\\3@p" "$raw")
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
  # single-quoted expression is the same word to bash, and only the raw
  # line tells the expression from the path that spells it.
  local state_raw
  state_raw=$(grep -F -- 'quotient_mask+=' "$raw" | grep -F -- "$state_dir" || true)
  if [ "$state_raw" != "$state_line" ]; then
    fail "$i" "the default state directory's mask line is not the builder's: $(single_line "$state_raw")"
  fi
  # The policy's protect paths, as the policy names them, against the
  # guarded lines this launcher carries.
  printf '%s\n' "$PROTECT" | sed -e '/^$/d' >"$work/protect-policy"
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

  # (j) No mount shows protected state at a path of its own: the mask
  # covers the default state directory and each protect path where they are,
  # so a caller's bind of one, of a directory holding one, or of `/`, at any
  # other target shows every session and the run evidence there.
  local alias
  while IFS= read -r alias; do
    fail "(j) $cap" "'$alias' mounts protected state at a path the mask does not cover"
  done < <(protected_aliases "$line")
}

## The baseline

# The baseline is a launcher, not a form: it must contribute none of the form's
# own tail, no bind of the root the tail computes, and no rw bind the policy
# does not call exposed. Its bind set is read once, before the forms.
check_baseline() {
  local raw=$work/baseline-raw raw_line=$work/baseline-raw-line line=$work/baseline-line unread
  if [ ! -f "$BASELINE" ]; then
    fail "(e) baseline" "no baseline at $BASELINE"
    printf '' >"$work/baseline-binds"
    return
  fi
  code "$BASELINE" >"$raw"
  extract_line "$raw" "$raw_line"
  refuse_continuation "(e) baseline" "$raw_line"
  if ! unread=$(bwrap_args "$raw_line" "$line"); then
    fail "(e) baseline" "the bwrap line is not plain words: $unread"
  fi
  bind_words "$line" >"$work/baseline-binds"

  local root_binds
  root_binds=$(mounts_to "$line" "\$quotient_root")
  if [ -n "$root_binds" ]; then
    fail "(e) baseline" "the baseline binds \$quotient_root: $(single_line "$root_binds")"
  fi

  # (g) Every host path the baseline writes is one the policy calls exposed: a
  # read-write bind's source, the device flags among them, and an overlay's
  # upper and work directories. Both sides as written, store hashes
  # folded alike.
  local source
  printf '%s\n' "$EXPOSURE" | sed -E "$fold_store" >"$work/exposure"
  while IFS= read -r source; do
    if ! grep -qxF -- "$source" "$work/exposure"; then
      fail "(g) baseline" "the baseline writes '$source' on the host, which EXPOSURE does not list"
    fi
  done < <(rw_sources "$work/baseline-binds")
}

## The report

# One bind residue, in both directions, so a reviewer sees what (f) compared.
residue_binds() { # heading file
  printf 'residue: %s\n' "$1"
  if [ -s "$2" ]; then
    tr "$sep" ' ' <"$2" | sed 's/^/residue:   /'
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
residue:   mounts whose source or target is a variable expanded at launch, which the text names but does not resolve
residue:   protected state bound again through a literal path into the real home, which (j) cannot tell from any other path
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
