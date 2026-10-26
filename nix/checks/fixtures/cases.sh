# shellcheck shell=bash  # a case table: sourced by the runner, never executed
# shellcheck disable=SC2016  # the quoted patterns are launcher text: no `$` in them expands
# The fixture corpus: one case per verdict nix/check.sh must reach over a family.
# The families, their paths and their policy come from the wrapper, so a case
# names a family (default, full) and never a store path — `@BWRAP` in an edit is
# that family's own bwrap.
#
#   fixture <name> <family> <outcome> [names= | expose= | protect= | absent=]
#   edit <layer> <from> <to>     a literal substitution, in table order
#   edit_launchers <from> <to>   the same edit to launcher-read, launcher-write
#                                and baseline
#   drop <layer>                 the file is not there at all
#
# A layer is one file of the case's copy of the family: form-read, form-write,
# launcher-read, launcher-write, baseline. The base text is the family the
# builder emitted, so a changed launcher or mask shape meets its fixture here
# rather than in a stale recording, and an edit whose text is absent fails the
# run. The outcome is one thing: `pass`, or `refuse:<label>` — the check's
# verdict with a failure line starting that label.

# The mask text the builder emits, phrased once here so a case edits a shape
# rather than restating one. The state directory's line is plain: it is the
# builder's own default, not a caller's path. A protect path's line also refuses
# an existing path that is not a directory, naming it.
state_expr='${XDG_STATE_HOME:-$HOME/.local/state}/quotient'
state_quoted="\"$state_expr\""
state_single="'$state_expr'"
protect_quoted=/tmp/quotient-checks/protect
not_a_directory="printf 'quotient: protect path %s is not a directory\n'"
state_test="[ -e $state_quoted ]"
state_line="$state_test && quotient_mask+=(--tmpfs $state_quoted)"
protect_line="[ -e $protect_quoted ] && { [ -d $protect_quoted ] || { $not_a_directory $protect_quoted >&2; exit 1; }; quotient_mask+=(--tmpfs $protect_quoted); }"

## The families the check must pass

# One with only the required arguments (the shared network, the no-secret path),
# one with every argument (the isolated network, a secret, a persisted home).
fixture default-family default pass
fixture full-family full pass

# A family that spends its one secret descriptor without declaring the name is
# within (h)'s "at most once", so the check accepts it.
fixture unlisted-secret full pass names=

## (a) the form wrapper

# A guard that no longer tests anything.
fixture guard-predicate default 'refuse:(a)'
edit form-read '[ "$#" -ge 1 ]' true

# A guard that is merely present, in a comment.
fixture commented-guards default 'refuse:(a)'
edit form-read '[ "$#" -ge 1 ]' '# [ "$#" -ge 1 ]'
edit form-read 'case "$session_dir" in /*)' '# case "$session_dir" in /*)'
edit form-read '[ -d "$session_dir" ]' '# [ -d "$session_dir" ]'

fixture commented-advance default 'refuse:(a)'
edit form-read 'shift' '# shift'

# A form that takes a mount flag into its own hands, the device binds included.
fixture form-dev-bind default 'refuse:(a)'
edit form-read 'shift' 'shift --dev-bind /etc /etc'

# The count is of occurrences, not of lines.
fixture exit64-twice default 'refuse:(a)'
edit form-read 'exit 64 ;;' 'exit 64; exit 64 ;;'

# A form that is not there: a labelled refusal, not the first tool error's exit 2.
fixture missing-form default 'refuse:(a)'
drop form-read

## (b) the launcher's bwrap

# A bare `bubblewrap` instead of the family's empty-environment one.
fixture bare-bubblewrap full 'refuse:(b)'
edit launcher-read 'exec @BWRAP ' 'exec bubblewrap '

# Another bwrap in the store — a caller's wrapper — is not the family's.
fixture other-bwrap default 'refuse:(b)'
edit launcher-read 'exec @BWRAP ' 'exec /nix/store/00000000000000000000000000000000-bwrap/bin/bwrap '

# A launcher with no bwrap line at all still reports, rather than ending the run.
fixture no-bwrap-line full 'refuse:(b)'
edit launcher-read 'exec @BWRAP' ''

## (c) the root, the mask token and the tail's order

# A bwrap line continued with a backslash: what follows is a second physical
# line, where no rule reads, so half a command is never read as the whole tail.
continuation_line='  --setenv QUOTIENT_RUN_DIR /evil -- /nix/store/x-pi/bin/pi "$@"'
continued_tail=$'"$@" \\\n'"$continuation_line"
fixture continuation default 'refuse:(c)'
edit launcher-read '"$@"' "$continued_tail"

# The bwrap line is read as bash reads it, and a line bash would read as more
# than plain words is refused rather than read: an operator outside quotes, a
# command substitution, a comment, a backtick, an ANSI-C quote.
fixture line-semicolon default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv ; true'

fixture line-and default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv && true'

fixture line-pipe default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv | true'

fixture line-comment default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv # --unshare-pid'

fixture line-command-substitution default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv $(true)'

fixture line-backtick default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv `true`'

# An expansion outside double quotes is split into words at launch, which the
# text cannot know; inside them, `\$` is a `$`. Both are refused.
fixture line-unquoted-expansion default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv --setenv NOTE $HOME'

fixture line-escaped-dollar default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv --setenv NOTE "a\$b"'

fixture line-ansi-quote default 'refuse:(c)'
edit launcher-read '--clearenv' "--clearenv --setenv NOTE \$'x'"

# An unquoted glob or brace is expanded at launch against a filesystem the text
# cannot see, and inside double quotes `\`` is a backtick, which the inert byte
# standing for it would not be: each is refused.
fixture line-unquoted-glob-question default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv --setenv NOTE quotien?'

fixture line-unquoted-glob-star default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv --setenv NOTE quotien*'

fixture line-unquoted-glob-bracket default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv --setenv NOTE quotien[t]'

fixture line-unquoted-brace default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv --setenv NOTE {a,b}'

fixture line-escaped-backtick default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv --setenv NOTE "a\`b"'

# Inside double quotes a command substitution, an arithmetic expansion or a
# parameter expansion's default opens a quoting context of its own, which a
# parse with every `$` and backtick inert cannot follow: a quote within one ends
# the double quotes to that parse alone, and the bind after it would be a word
# no rule reads. Each is refused, and so is every `$(` and `$[`.
fixture line-quoted-backtick-nested default 'refuse:(c)'
edit launcher-read '--clearenv' "--clearenv --setenv NOTE \"a\`echo '\"'\`\" --bind /etc /visible \"\`echo '\"'\`b\""

fixture line-quoted-substitution-nested default 'refuse:(c)'
edit launcher-read '--clearenv' "--clearenv --setenv NOTE \"a\$(echo '\"')\" --bind /etc /visible \"\$(echo '\"')b\""

fixture line-quoted-default-nested default 'refuse:(c)'
edit launcher-read '--clearenv' "--clearenv --setenv NOTE \"\${X:-'\"'}\" --bind /etc /visible \"\${X:-'\"'}\""

fixture line-quoted-arithmetic default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv --setenv NOTE "$[1]"'

# Quoted, the same characters are a word's text, and an empty argument is an
# argument: each is read as the one word it is.
fixture line-quoted-operator default pass
edit launcher-read '--clearenv' "--clearenv --setenv NOTE ';' --setenv NOTE2 '&&'"

fixture line-empty-argument default pass
edit launcher-read '--clearenv' "--clearenv --setenv NOTE ''"

# A descriptor-only exec before the bwrap line is not the bwrap line.
fixture fd-exec default pass
edit launcher-read 'exec @BWRAP ' $'exec 3</dev/null\nexec @BWRAP '

# Nor is a caller's combined-output redirect: bash reads it as a redirection and
# nothing else, so the bwrap command after it is the one to inspect.
fixture amp-redirect-exec default pass
edit launcher-read 'exec @BWRAP ' $'exec &>/dev/null\nexec @BWRAP '

fixture read-root-bind default 'refuse:(c)'
edit launcher-read '--ro-bind "$quotient_root"' '--bind "$quotient_root"'

# The forbidden root flag covers its -try variant, and every other mount flag.
# The required root bind keeps its flag and its place, and a second flag mounts
# the root beside it, so the forbidden option is the only fault.
fixture root-try-bind default 'refuse:(c)'
edit launcher-read '--clearenv' '--clearenv --bind-try "$quotient_root" "$quotient_root"'

fixture root-reassigned default 'refuse:(c)'
edit launcher-read 'quotient_mask=()' $'export quotient_root=/\nquotient_mask=()'

# The bind set is unchanged, so only the order can catch a caller bind that
# slipped behind the session bind.
fixture caller-bind-late full 'refuse:(c)'
edit launcher-read ' --ro-bind /tmp/quotient-checks/world /tmp/quotient-checks/world' ''
edit launcher-read '--chdir "$quotient_root"' '--chdir "$quotient_root" --ro-bind /tmp/quotient-checks/world /tmp/quotient-checks/world'

# A --setenv value is an environment name and a value, never a token of the
# tail's order: a caller's value cannot stand in for the root bind, the session
# bind or the chdir behind them.
tail_setenv="--setenv CHECK_TAIL '--tmpfs /tmp'"
fixture tail-setenv-value full pass
edit launcher-read '--chdir "$quotient_root"' '--chdir "$quotient_root" '"$tail_setenv"

## (d) the jail's own isolation

fixture die-with-parent default 'refuse:(d)'
edit launcher-read ' --die-with-parent' ''

# A second mount on /tmp, whatever the flag, would show the host's.
fixture tmpfs-tmp default 'refuse:(d)'
edit launcher-read '--tmpfs ~' '--tmpfs ~ --tmpfs /tmp'

fixture proc-tmp default 'refuse:(d)'
edit launcher-read '--tmpfs ~' '--tmpfs ~ --proc /tmp'

# A mount target is the directory the kernel resolves: //tmp, /tmp/ and /./tmp
# are the host's /tmp too.
fixture canonical-tmp default 'refuse:(d)'
edit launcher-read '--tmpfs ~' '--tmpfs ~ --ro-bind /tmp //tmp'

fixture canonical-tmp-slash default 'refuse:(d)'
edit launcher-read '--tmpfs ~' '--tmpfs ~ --ro-bind /tmp /./tmp/'

# Quoting changes no argument's value: a single-quoted target is the same /tmp.
# The bind is the baseline's too, so the second /tmp mount is the only fault.
fixture quoted-tmp-target full 'refuse:(d)'
edit_launchers '--tmpfs ~' "--tmpfs ~ --bind /tmp/quotient-checks/exposure '/tmp'"

# A trailing `/.` names the directory before it, and a run of dot components
# collapses to nothing: both are the host's /tmp again.
fixture canonical-tmp-dot default 'refuse:(d)'
edit launcher-read '--tmpfs ~' '--tmpfs ~ --ro-bind /tmp /tmp/.'

fixture canonical-tmp-dot-run default 'refuse:(d)'
edit launcher-read '--tmpfs ~' '--tmpfs ~ --ro-bind /tmp /././tmp/./'

# An overlay mount is read with the operands bwrap gives it: the two single-mount
# variants take a destination alone, and `--overlay-src` names a source, not a
# mount at all.
fixture tmp-overlay-tmp default 'refuse:(d)'
edit launcher-read '--tmpfs ~' '--tmpfs ~ --tmp-overlay /tmp'

fixture overlay-src-ro-overlay-tmp default 'refuse:(d)'
edit launcher-read '--tmpfs ~' '--tmpfs ~ --overlay-src /tmp --ro-overlay /tmp'

# A source is one word: the word after `--overlay-src` is that source, even when
# it spells an isolation flag the jail requires.
fixture overlay-src-operand default 'refuse:(d)'
edit launcher-read ' --unshare-pid' ''
edit launcher-read '--tmpfs ~' '--tmpfs ~ --overlay-src --unshare-pid'

# An option is a token bwrap reads as an option, not a word inside a --setenv
# value: a caller's environment value cannot stand in for the flag it spells.
fixture env-flag default 'refuse:(d)'
edit launcher-read ' --die-with-parent' ''
edit launcher-read '--setenv PATH' '--setenv CHECK_LITERAL --die-with-parent --setenv PATH'

# And the other direction: a value that spells a flag the family does not set is
# not that flag, so it must not be refused.
fixture env-value-flag full pass
edit launcher-read '--setenv PATH' '--setenv CHECK_LITERAL --share-net --setenv PATH'

# An option is one bwrap reads before the `--` that ends its arguments: what pi
# receives after it is the program's own argument, not a jail flag.
fixture argv-flag-after-separator default 'refuse:(d)'
edit launcher-read ' --unshare-pid' ''
edit launcher-read '"$@"' '"$@" --unshare-pid'

fixture share-net-raw full 'refuse:(d)'
edit launcher-read '--unshare-net' '--share-net --unshare-net'

# An operand is not an option: the word after `--hostname` is a hostname, even
# when it spells the isolation flag the jail requires.
fixture hostname-flag-operand default 'refuse:(d)'
edit launcher-read ' --unshare-pid' ''
edit launcher-read '--clearenv' '--clearenv --hostname --unshare-pid'

# And a mount's operands are read the same way: a bind whose source is named
# `--unshare-pid` is that source in all three launchers, so the bind sets still
# agree and the missing option is the only fault.
fixture bind-source-flag-operand full 'refuse:(d)'
edit launcher-read ' --unshare-pid' ''
edit_launchers '--ro-bind /tmp/quotient-checks/world /tmp/quotient-checks/world' '--ro-bind --unshare-pid /tmp/quotient-checks/world'

# Nor is an application argument one bwrap reads: pi's own `--setenv` is after
# the `--`, so neither (e)'s namespace scan nor (h)'s name scan is its business.
fixture argv-setenv-quotient default pass
edit launcher-read '"$@"' '"$@" --setenv QUOTIENT_DEBUG 1'

fixture argv-setenv-secret full pass
edit launcher-read '"$@"' '"$@" --setenv CHECK_SECRET literal'

# And neither is a bind: pi's own argument after the `--` that spells one adds
# nothing to the set (f) compares.
fixture argv-bind default pass
edit launcher-read '"$@"' '"$@" --ro-bind /etc /etc'

## (e) the server's own namespace

fixture quotient-env default 'refuse:(e)'
edit launcher-read '--setenv PATH' '--setenv QUOTIENT_DEBUG 1 --setenv PATH'

# A single-quoted variable name is the same name to bwrap.
fixture quoted-quotient-env default 'refuse:(e)'
edit launcher-read '--setenv PATH' "--setenv 'QUOTIENT_DEBUG' 1 --setenv PATH"

## (f) the bind set against the baseline

# A form drops a bind its baseline makes.
fixture baseline-bind-dropped full 'refuse:(f)'
edit launcher-read ' --bind /tmp/quotient-checks/exposure /tmp/quotient-checks/exposure' ''

# A device bind is a read-write bind: one the form makes and its baseline does
# not is a permission the form took into its own hands.
fixture dev-bind-form-only full 'refuse:(f)'
edit launcher-read '--tmpfs ~' '--tmpfs ~ --dev-bind /private /private'

## (g) the policy's exposure

# The baseline binds a path the policy does not call exposed.
fixture unexposed-bind full 'refuse:(g)'
edit baseline '--tmpfs ~' '--tmpfs ~ --bind /tmp/quotient-checks/extra /tmp/quotient-checks/extra'

# A device bind is a read-write bind the policy must list as exposed, in the
# baseline as much as in a form.
fixture dev-bind-unexposed full 'refuse:(g)'
edit_launchers '--tmpfs ~' '--tmpfs ~ --dev-bind /private /private'

# Whitespace separates bwrap's arguments however it is written: a tab, or a run
# of spaces, is no part of a path and does not hide the bind it separates.
fixture tab-bind-unexposed default 'refuse:(g)'
edit_launchers '--tmpfs ~' $'--tmpfs ~ --bind\t/private\t/private'

fixture space-run-bind-unexposed default 'refuse:(g)'
edit_launchers '--tmpfs ~' '--tmpfs ~ --bind   /private   /private'

# An exposed store path is compared folded, like the bind it is compared to.
exposed_store=/nix/store/11111111111111111111111111111111-my-data
exposed_mount="--tmpfs ~ --bind $exposed_store /tmp/quotient-checks/data"
fixture store-exposure full pass "expose=$exposed_store"
edit_launchers '--tmpfs ~' "$exposed_mount"

# A report quotes bind paths the caller controls, so a path spelling a label must
# not read as a refusal by it: this binds `(i)` and is refused by (g) alone. The
# path is quoted, as a caller's would have to be: unquoted, `(` is bash syntax.
fixture label-quoted full 'refuse:(g)' 'absent=(i)'
edit baseline '--tmpfs ~' "--tmpfs ~ --bind '/tmp/quotient-checks/(i)' '/tmp/quotient-checks/(i)'"

## (h) the secret descriptor

# A secret name that also reaches bwrap's argv from the caller's environment.
fixture secret-in-env full 'refuse:(h)'
edit launcher-read '--setenv PATH' '--setenv CHECK_SECRET literal --setenv PATH'

# A single-quoted name is the same name to bwrap, and the same secret.
fixture quoted-secret-name full 'refuse:(h)'
edit launcher-read '--setenv PATH' "--setenv 'CHECK_SECRET' literal --setenv PATH"

# A name the secret's name is a prefix of is another name: it may pass.
fixture secret-prefix full pass
edit launcher-read '--setenv PATH' '--setenv CHECK_SECRET_OTHER literal --setenv PATH'

# The passed operand is the whole descriptor name.
fixture secret-fd-other full 'refuse:(h)'
edit launcher-read '--args "$quotient_secret_fd"' '--args "$quotient_secret_fd_other"'

# An option named inside an environment value is not an option bwrap reads. The
# expansion is quoted, as any on the line must be.
fixture secret-in-env-value full 'refuse:(h)'
edit launcher-read ' --args "$quotient_secret_fd"' ''
edit launcher-read '--setenv PATH' '--setenv CHECK_LITERAL --args "$quotient_secret_fd" --setenv PATH'

# The open is a command: a quoted mention of it opens nothing.
fixture secret-open-inert full 'refuse:(h)'
edit launcher-read 'exec {quotient_secret_fd}<' '# exec {quotient_secret_fd}<'
edit launcher-read 'exec @BWRAP ' $'CHECK_LITERAL=\'exec {quotient_secret_fd}<\'\nexec @BWRAP '

# The open must run, not merely appear in the launcher.
fixture commented-secret-open full 'refuse:(h)'
edit launcher-read 'exec {quotient_secret_fd}<' '# exec {quotient_secret_fd}<'

## (i) the mask

# A mask append that lost its existence test.
fixture mask-test-removed full 'refuse:(i)'
edit launcher-read "$state_test && " ''

# The default state directory is the builder's complete expression, not any path
# whose text mentions it.
fixture state-mask default 'refuse:(i)'
edit launcher-read '${XDG_STATE_HOME:-$HOME/.local/state}' '/tmp/XDG_STATE_HOME'

# The expression the launcher expands is the builder's own, quoted its own way: a
# single-quoted one is a literal pathname, and mounts nothing.
fixture state-expr-quoted default 'refuse:(i)'
edit launcher-read "$state_quoted" "$state_single"

# And so is each builder variable the tail names: single-quoted, it is the
# literal `$quotient_root` and not the root the launcher computed.
fixture root-var-quoted default 'refuse:(c)'
edit launcher-read '--ro-bind "$quotient_root"' "--ro-bind '\$quotient_root'"

# The guard is about the builder's own operands, not about the characters
# anywhere in the file: a caller's env value may spell `$quotient_root`, and the
# builder escapes it as the literal it is. The text is doctored rather than
# built: writeShellApplication's shellcheck refuses to emit a launcher whose
# single quotes hold a `$` (SC2016), so no sample family carries the text.
caller_literal="--setenv CHECK_LITERAL_ROOT '\$quotient_root'"
fixture caller-literal default pass
edit launcher-read '--setenv HOME "$HOME"' "--setenv HOME \"\$HOME\" $caller_literal"

# The mask is declared, then filled, then expanded: a declaration after the
# appends clears what they built.
fixture mask-order default 'refuse:(i)'
edit launcher-read 'quotient_mask=()' ''
edit launcher-read 'exec @BWRAP ' $'quotient_mask=()\nexec @BWRAP '

# An append after the bwrap line never reaches the jail at all: the state line
# is moved there, so the mask is declared and filled but expanded too late.
fixture mask-append-after default 'refuse:(i)'
edit launcher-read "$state_line" ''
edit launcher-read '"$@"' '"$@"'$'\n'"$state_line"

# A mask line a caller commented out mounts nothing: for the state directory
# that leaves the mask unbuilt, and for a protect path it leaves the path
# unmasked, which the policy names and (i) refuses.
fixture mask-append-commented full 'refuse:(i)'
edit launcher-read '[ -e /tmp/quotient-checks/protect ]' '# [ -e /tmp/quotient-checks/protect ]'

# A protect path's line without its directory test is the fault the guard exists
# for: the plain shape is the state line's alone.
plain_protect="[ -e $protect_quoted ] && quotient_mask+=(--tmpfs $protect_quoted)"
fixture mask-plain-protect full 'refuse:(i)'
edit launcher-read "$protect_line" "$plain_protect"

# Every protect path the policy names must be masked, so a line missing is the
# fault (i) exists for: the case declares the path its family's policy carries.
fixture protect-mask-missing full 'refuse:(i)' "protect=$protect_quoted"
edit launcher-read "$protect_line" ''

fixture mask-dir-check-removed full 'refuse:(i)'
edit launcher-read "$protect_line" "[ -e $protect_quoted ] && { quotient_mask+=(--tmpfs $protect_quoted); }"

# The directory test names the path the line tests and mounts, not another.
fixture mask-dir-check-other full 'refuse:(i)'
edit launcher-read "$protect_line" "[ -e $protect_quoted ] && { [ -d /tmp/quotient-checks/extra ] || { $not_a_directory $protect_quoted >&2; exit 1; }; quotient_mask+=(--tmpfs $protect_quoted); }"

# And the one plain line is the state default: guarded there is drift too.
fixture mask-state-dir-check full 'refuse:(i)'
edit launcher-read "$state_line" "$state_test && { [ -d $state_quoted ] || { $not_a_directory $state_quoted >&2; exit 1; }; quotient_mask+=(--tmpfs $state_quoted); }"

# The policy names the protect paths, and a list is a set: a path named twice
# is one mask line, so the family the builder emits is one the check passes.
fixture duplicate-protect duplicate pass

# The runner's completion marker: a table that returns or fails early never
# reaches it, and the runner refuses a corpus that did not set it.
## Argument boundaries: the bwrap line read as bash reads it

# An empty env value is an argument of its own: read away, the scan takes the
# next `--setenv` as its value and never sees the QUOTIENT_ name after it.
fixture empty-env-quotient emptyenv 'refuse:(e)'
edit launcher-read '--setenv T_AFTER 1' '--setenv QUOTIENT_DEBUG 1'

# The same erasure in a caller's raw arguments hides a bind from (g).
fixture raw-empty-bind rawempty 'refuse:(g)'

# A value that spells a flag is a value, and an apostrophe is part of a path.
fixture multiword-env-value multiword pass

# A single-quoted backtick, glob or brace is text: the builder quotes such a
# value, and it is the one word it spells.
fixture quoted-specials quotedspecials pass
fixture apostrophe-exposure apostrophe pass

# A word opening with `~` is the home only where bash expands it: unquoted, and
# followed by `/` or the word's end. Otherwise that `~` is a literal — quoted,
# the target here is a relative path bwrap mounts under `/~`, not the masked
# state directory it spells — so a line holding one is refused rather than read.
fixture tilde-quoted-target default 'refuse:(c)'
edit_launchers '--clearenv' "--clearenv --ro-bind ~/.local/state/quotient '~/.local/state/quotient'"

fixture tilde-escaped default 'refuse:(c)'
edit_launchers '--clearenv' '--clearenv --ro-bind /etc/hostname \~/hostname'

# Unquoted, `~name` is another user's home, which the text cannot know.
fixture tilde-user default 'refuse:(c)'
edit_launchers '--clearenv' '--clearenv --ro-bind /etc/hostname ~root/hostname'

# An unquoted `~` opening a path is the home bash expands, read as written; a
# `~` later in a word is text, which the builder quotes, as in this exposure path.
fixture tilde-unquoted default pass
edit_launchers '--clearenv' '--clearenv --ro-bind /etc/hostname ~/hostname'
fixture tilde-in-exposure tildeexposure pass

## (g) overlays

# An overlay's upper and work directories are written on the host.
fixture overlay-unexposed overlay 'refuse:(g)'

## (j) protected state bound again elsewhere

fixture alias-state-dir aliasstate 'refuse:(j)'
fixture alias-protect aliasprotect 'refuse:(j)'
fixture alias-host-root aliasroot 'refuse:(j)'

# A `..` segment names the directory it climbs to, as the kernel reads it.
fixture alias-dotdot aliasdotdot 'refuse:(j)'

# A `..` that climbs above the path's anchor lands in a directory no text names:
# (c) refuses the mount, and (j) reads it as overlapping everything, so two such
# paths are never one path at its own target.
fixture mount-climb aliasclimb 'refuse:(c)'
fixture alias-climb aliasclimb 'refuse:(j)'

# A mount path is absolute or opens with a symbol the check names: the home's
# `~` or a variable. bwrap resolves any other relative path against a directory
# the text does not name — `tmp` is the jail's /tmp — so it is refused.
fixture mount-relative-target default 'refuse:(c)'
edit_launchers '--clearenv' '--clearenv --ro-bind /etc tmp'

fixture mount-dot-relative-target default 'refuse:(c)'
edit_launchers '--clearenv' '--clearenv --ro-bind /etc ./tmp'

fixture mount-relative-source default 'refuse:(c)'
edit_launchers '--clearenv' '--clearenv --ro-bind etc /visible'

# A path at or under an earlier `--symlink`'s destination goes where the link
# points, which the text does not follow: through `alias/.` this bind lands on
# /tmp itself. A path that merely begins with the same characters is another.
fixture mount-through-symlink default 'refuse:(c)'
edit_launchers '--clearenv' '--clearenv --dir /tmp/work --symlink /tmp /tmp/work/alias --ro-bind /etc /tmp/work/alias/.'

fixture mount-beside-symlink default pass
edit_launchers '--clearenv' '--clearenv --symlink /etc /tmp/link --ro-bind /etc /tmp/linked'

# A descriptor bind's source is whatever the descriptor opens, which the text
# cannot name: written, it is no exposure path, and read, it may be protected
# state.
fixture fd-bind-unexposed fdbind 'refuse:(g)'
fixture alias-fd-bind rofdbind 'refuse:(j)' 'absent=(c)'

## (g) a source holding a tab

# A tab inside a quoted path is part of the path: the source compared is the
# whole of it, not the declared path it begins with.
fixture tab-in-source tabsource 'refuse:(g)'

## piFiles in the tail

# The builder's piFiles binds follow every caller option, a deferred one
# included, so a caller's bind over ~/.pi/agent covers none of them.
fixture pifiles-defer deferpi pass

# Between the mask and the root bind only the builder's piFiles binds may stand:
# a store path, read-only, under ~/.pi/agent.
fixture tail-other-mount default 'refuse:(c)'
edit launcher-read '"${quotient_mask[@]}"' '"${quotient_mask[@]}" --ro-bind /etc /etc'

fixture tail-pifiles-host-source default 'refuse:(c)'
edit launcher-read '"${quotient_mask[@]}"' '"${quotient_mask[@]}" --ro-bind /etc/hostname ~/.pi/agent/settings.json'

# Each is read as the kernel resolves it: a source that climbs out of the store
# is a host path, and a target that climbs out of ~/.pi/agent is not under it.
fixture tail-pifiles-source-climb default 'refuse:(c)'
edit launcher-read '"${quotient_mask[@]}"' '"${quotient_mask[@]}" --ro-bind /nix/store/../etc ~/.pi/agent/settings.json'

fixture tail-pifiles-target-climb default 'refuse:(c)'
edit launcher-read '"${quotient_mask[@]}"' '"${quotient_mask[@]}" --ro-bind /nix/store/00000000000000000000000000000000-x ~/.pi/agent/../visible'

## (e) a QUOTIENT_ name on the secret descriptor

fixture secret-name-quotient full 'refuse:(e)' names=QUOTIENT_DEBUG

table_complete
