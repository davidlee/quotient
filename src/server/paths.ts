// One canonicalisation and one containment predicate, shared by the two checks
// over DEC-095's invariant: the child view's disjointness (design sec-2 step 8,
// `childview.ts`) and the call's root allowlist (step 4, `profiles.ts`). Both ask
// the same question — is this path inside that one — so both ask it here, of one
// implementation, rather than each spelling the comparison a second time.
//
// String prefixes are not containment and a lexical comparison is not
// canonicalisation: `/work/oneevil` shares the text `/work/one` and names nothing
// inside it, and a path through a symlinked ancestor names its target. The two
// functions below are the whole of that reasoning.
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * A path's canonical form: `realpath` of its longest existing ancestor, with the
 * remaining components appended. The run dir, the session home and a policy file
 * named in a policy's `exposure` may not exist at check time, and a lexical
 * comparison would let a symlinked ancestor through.
 *
 * A path with no existing ancestor keeps its resolved lexical form; it names
 * nothing on disk, so it matches nothing that does.
 */
export function canonicalPath(path: string): string {
  const target = resolve(path);
  let head = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return target;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * Whether `inner` is `outer` itself or a descendant of it, by path COMPONENTS
 * (DEC-095): `/work/one` does not contain `/work/one-2`, however much of it the
 * string shares.
 */
export function within(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** A filesystem error's code (`ENOENT`, `EACCES` …), for a refusal's detail. */
export const errorCode = (error: unknown): string =>
  error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'unknown error';

/**
 * Whether a failed read of PATH means PATH is absent. Only an absent entry is:
 * a symlink that does not resolve also reads ENOENT, and it is a broken
 * deployment, not an absent one. The profile and help layers share the rule.
 */
export function absent(path: string, error: unknown): boolean {
  if (errorCode(error) !== 'ENOENT') return false;
  try {
    lstatSync(path);
    return false;
  } catch {
    return true;
  }
}
