// Validation step 8: child-view disjointness (design sec-2 step 8 and sec-3's
// "Child-view disjointness").
//
// The child view is the canonicalised union of {the root, the active session
// directory, the policy's `exposure` paths}. "No bind names the evidence" is
// not the property that matters — a root that *contains* the evidence directory
// exposes it just as surely, and DEC-095 lets an operator allowlist `$HOME` or
// `/`. So the property is disjointness over that union, checked before spawn: a
// member that is, contains, or lies inside a protected store more strongly than
// the store tolerates is refused `view-overlaps-protected`.
//
// Refusal, never a mask: this module names the overlapping member and the
// protected path and stops. It authors no confinement argument — jail policy is
// the flake's (SPEC-001 REQ-009) — and writes no file.
import { evidenceStores } from './evidence.ts';
import { canonicalPath, within } from './paths.ts';
import type { Filesystem } from './profiles.ts';

/** The one refusal token step 8 produces (design sec-2 step 8). */
export type ViewRefusal = 'view-overlaps-protected';

/** What a member of the child view is bound for, for the refusal's detail. */
export type MemberRole = 'root' | 'session-directory' | 'exposure';

/**
 * How strongly a member exposes what it covers, in this posture: the root is
 * writable for a `write` capability and read-only for a `read` one; every
 * `exposure` path and the active session directory are writable.
 */
export type Exposure = 'read-only' | 'read-write';

export type ChildViewMember = {
  role: MemberRole;
  /** Canonical, whether or not the path exists yet. */
  path: string;
  exposure: Exposure;
};

/** How much exposure a protected store tolerates (design sec-3's table). */
export type StoreTolerance = 'unreachable' | 'never-writable';

export type StoreKind = 'run-evidence' | 'attempts-ledger' | 'session-home' | 'policy-file' | 'profile-layer' | 'help-layer';

export type ProtectedStore = {
  kind: StoreKind;
  /** Canonical, whether or not the path exists yet. */
  path: string;
  tolerance: StoreTolerance;
  /**
   * A region inside the store a member may occupy. Only the session home has
   * one: the active session directory is the single session path the child is
   * meant to have (design sec-3).
   */
  except?: string;
};

/** What step 8 is decided from: the call's admitted values, plus the stores. */
export type ChildViewInput = {
  /** The call's canonical root (step 4). */
  root: string;
  capability: Filesystem;
  /** `<QUOTIENT_SESSION_HOME>/<session>` — the one directory a child is given. */
  sessionDir: string;
  /** The policy's `exposure`: writable host paths beyond the root and session. */
  exposure: readonly string[];
  sessionHome: string;
  /** `QUOTIENT_RUN_DIR`. */
  runDir: string;
  policyPath: string;
  /** The profile layers (`Locations.profileLayers`), whether or not they exist. */
  profileLayers: readonly string[];
  /** The help layers (`Locations.helpLayers`), whether or not they exist. */
  helpLayers: readonly string[];
};

export type ChildViewCheck = { ok: true } | { ok: false; reason: ViewRefusal; detail: string };

/** The child view's members, in the order the check reports them. */
export function childViewMembers(input: ChildViewInput): ChildViewMember[] {
  return [
    {
      role: 'root',
      path: canonicalPath(input.root),
      exposure: input.capability === 'write' ? 'read-write' : 'read-only',
    },
    { role: 'session-directory', path: canonicalPath(input.sessionDir), exposure: 'read-write' },
    ...input.exposure.map((path): ChildViewMember => ({
      role: 'exposure',
      path: canonicalPath(path),
      exposure: 'read-write',
    })),
  ];
}

/**
 * The protected stores (design sec-3's table), derived from the evidence
 * layout rather than from a list the caller assembles. Ordered widest-first, so a
 * member that covers a whole run's evidence directory is reported against that
 * directory rather than against the ledger inside it.
 */
export function protectedStores(input: ChildViewInput): ProtectedStore[] {
  const evidence = evidenceStores(input.runDir);
  return [
    { kind: 'run-evidence', path: canonicalPath(evidence.runDir), tolerance: 'unreachable' },
    { kind: 'attempts-ledger', path: canonicalPath(evidence.attempts), tolerance: 'unreachable' },
    {
      kind: 'session-home',
      path: canonicalPath(input.sessionHome),
      tolerance: 'unreachable',
      except: canonicalPath(input.sessionDir),
    },
    { kind: 'policy-file', path: canonicalPath(input.policyPath), tolerance: 'never-writable' },
    // The XDG layers are protected whether or not they exist: a write delegate
    // must not be able to create one and plant text for the next restart.
    ...layerStores('profile-layer', input.profileLayers),
    ...layerStores('help-layer', input.helpLayers),
  ];
}

const layerStores = (kind: StoreKind, layers: readonly string[]): ProtectedStore[] =>
  layers.map((layer) => ({ kind, path: canonicalPath(layer), tolerance: 'never-writable' }));

/**
 * Step 8. Members are checked in a stable order (the root first, then the
 * `exposure` paths in the policy's order) against the stores in theirs, so a policy with
 * two problems names the same one on every call (EX-6).
 */
export function checkChildView(input: ChildViewInput): ChildViewCheck {
  const stores = protectedStores(input);
  for (const member of childViewMembers(input)) {
    for (const store of stores) {
      const overlap = relationTo(member.path, store.path);
      if (overlap === null || isExempt(member, store)) {continue;}
      if (!refuses(member.exposure, store.tolerance)) {continue;}
      return {
        ok: false,
        reason: 'view-overlaps-protected',
        detail: overlapDetail(member, store, overlap),
      };
    }
  }
  return { ok: true };
}

/** The three ways a member can overlap a store (design sec-2 step 8). */
type Overlap = 'is' | 'contains' | 'inside';

function relationTo(member: string, store: string): Overlap | null {
  if (member === store) {return 'is';}
  if (within(member, store)) {return 'contains';}
  if (within(store, member)) {return 'inside';}
  return null;
}

/** The active session directory, and nothing else inside the home, is exempt. */
function isExempt(member: ChildViewMember, store: ProtectedStore): boolean {
  if (store.except === undefined) {return false;}
  if (!within(store.path, store.except)) {return false;}
  return within(store.except, member.path);
}

/**
 * Whether the store tolerates this overlap at this exposure. An unreachable
 * store tolerates none — read or write. A never-writable one tolerates reading
 * only: a writable member that is, contains or lies inside it can write it
 * (inside a layer directory, plant a document there).
 */
function refuses(exposure: Exposure, tolerance: StoreTolerance): boolean {
  return tolerance === 'unreachable' || exposure === 'read-write';
}

const ROLE_LABEL: Record<MemberRole, string> = {
  root: 'root',
  'session-directory': 'session directory',
  exposure: 'exposure path',
};

const STORE_LABEL: Record<StoreKind, string> = {
  'run-evidence': 'run evidence directory',
  'attempts-ledger': 'attempts ledger',
  'session-home': 'session home',
  'policy-file': 'policy file',
  'profile-layer': 'profile layer',
  'help-layer': 'help layer',
};

const OVERLAP_PHRASE: Record<Overlap, string> = {
  is: 'is',
  contains: 'contains',
  inside: 'lies inside',
};

const TOLERANCE_WHY: Record<StoreTolerance, string> = {
  unreachable: 'it must be unreachable from the child, read or write',
  'never-writable': 'it must never be writable by the child',
};

function overlapDetail(member: ChildViewMember, store: ProtectedStore, overlap: Overlap): string {
  return (
    `the ${member.exposure} ${ROLE_LABEL[member.role]} ${JSON.stringify(member.path)} ` +
    `${OVERLAP_PHRASE[overlap]} the protected ${STORE_LABEL[store.kind]} ${JSON.stringify(store.path)}; ` +
    TOLERANCE_WHY[store.tolerance]
  );
}
