// Admission: everything that decides whether a call MAY run, in the order a
// caller is told about it — steps 1 to 8 of design sec-2, plus the ledger probe
// that is design sec-6's last gate.
//
// Nothing here spawns anything. The steps return `({ ok: true } & T) | Refused`
// (IMP-004), each in its own named function so the order is legible and no
// branch count hides the sequence, and every refusal is recorded in the ledger
// as it is decided — in one `recorded` boundary, not inside the steps. Two
// refusals are not recorded here because their own writers have already done it:
// steps 1-2's (`admitCall` records its refusals as it makes them) and the ledger
// probe's (the ledger is precisely what it could not write).
//
// The session lock, once taken in step 7, is held until the answer is decided:
// every refusal and every throw after that point releases it before returning.
import { realpathSync } from 'node:fs';
import { usable, type Locations } from '../config.ts';
import type { HelpSnapshot } from '../help/help.ts';
import { DEFAULT_BUDGET_BYTES } from '../reduce/reduce.ts';
import { checkChildView } from './childview.ts';
import { appendAttempt, attemptsPath, writeAttemptProbe, type CallId } from './evidence.ts';
import { chooseForm, lookupProjectForm, type SelectedForm } from './forms.ts';
import { admitCall, clampCeilings, formExtensions, selectSlot, transcriptBudget, writablePaths, type Admission, type Form, type FormSource, type Maxima, type Policy, type SlotSelection } from './policy.ts';
import { checkProfileExtensions, effectiveTools, resolveProfile, resolveRoot, type Filesystem, type RootResolution, type Profile, type Snapshot } from './profiles.ts';
import { acquireSession, type HostIdentity, type SessionAcquisition } from './session.ts';
import { CEILING_FIELDS, type AgentRequest } from './tools.ts';

/** What the server read once at start-up: the profiles, then the help. The
 *  first that does not load puts the server in the start-up-refused state. */
export type Startup = { ok: true; profiles: Snapshot; help: HelpSnapshot } | StartupFailure;

/** A start-up refusal: the path to fix and why, said in one line. */
export type StartupFailure = { ok: false; path: string; detail: string };

/** A call that passed every step, with the values the run consumes as they were
 *  decided: no step re-derives one later. */
export type Admitted = {
  request: AgentRequest;
  root: string;
  profile: Profile;
  form: Form;
  formSource: FormSource;
  ceilings: Maxima;
  tools: string[];
  session: SessionAcquisition & { ok: true };
  policyDigest: string;
  policyPath: string;
  runDir: string;
  transcriptBudget: number | undefined;
  callId: CallId;
};

/** A refusal: the token and the one line that says which value decided it. */
export type Refused = { ok: false; reason: string; detail: string };

/** A step's verdict (IMP-004): what it decided, or why it stopped. */
type Step<T> = ({ ok: true } & T) | Refused;

/** What admission needs that the server reads once: its start-up snapshot, its
 *  locations, its launch directory, the pid table and its own host identity. */
export type AdmissionContext = {
  startup: Startup & { ok: true };
  locations: Locations;
  launchDir: string;
  procDir: string;
  here: HostIdentity;
};

/** What the policy decided, before any session exists (steps 1-6 and `tools`). */
type Authorised = {
  policy: Policy;
  policyDigest: string;
  policyPath: string;
  runDir: string;
  sessionHome: string;
  root: string;
  profile: Profile;
  form: Form;
  formSource: FormSource;
  ceilings: Maxima;
  tools: string[];
};

/** The values a step reads; explicit, so readmit can hand over the admitted
 *  root, ceilings and tools rather than the raw request. `exact`: the root must
 *  still canonicalise to itself. `ceilings` is asked of the policy's
 *  maxima once they are read. */
type Asked = {
  profile: string;
  root: string | undefined;
  exact?: boolean;
  ceilings: (maxima: Maxima) => AgentRequest['ceilings'];
  tools: string[] | undefined;
};

/** Where a refusal is written: the run directory, the call and the policy it was
 *  decided under (design sec-6). */
type Ledger = { callId: CallId; runDir: string; policyDigest: string };

/** Steps 1-2's verdict once it has passed. */
type Granted = Extract<Admission, { ok: true }>;

/** The ledger a decision under one policy read is written to. */
const ledgerOf = (decidedUnder: { runDir: string; policyDigest: string }, callId: CallId): Ledger => ({
  callId,
  runDir: decidedUnder.runDir,
  policyDigest: decidedUnder.policyDigest,
});

/** Step 8 and the probe's verdict. Only the probe's refusal is unrecordable: it
 *  is the ledger itself that could not be written (design sec-6). */
type Launchable = { ok: true } | (Refused & { recordable: boolean });

/** The ledger's writer at the admission boundary: the refusal returned unchanged,
 *  recorded as it is decided. */
function recorded(ledger: Ledger, refused: Refused): Refused {
  appendAttempt(ledger.runDir, {
    callId: ledger.callId,
    reason: refused.reason,
    detail: refused.detail,
    policyDigest: ledger.policyDigest,
  });
  return refused;
}

/**
 * One call, from the policy to a session that may run: `authorise` (steps 1-6
 * and `tools`), step 7 (the session), then the last two decisions — step 8's
 * child view and the ledger probe. Every refusal says which value decided it and
 * is recorded where the decision was made.
 */
export function admit(
  request: AgentRequest,
  context: AdmissionContext,
  callId: CallId,
): Step<{ admitted: Admitted }> {
  const authorised = authorise(
    { profile: request.profile, root: request.cwd, ceilings: () => request.ceilings, tools: request.tools },
    context,
    callId,
  );
  if (!authorised.ok) {return authorised;}

  const ledger = ledgerOf(authorised, callId);
  const session = seat(request.session, authorised, context, callId);
  if (!session.ok) {return recorded(ledger, session);}

  // From here the session lock is held: every refusal and every throw gives it
  // back before answering, because nothing will run.
  let launchable: Launchable;
  try {
    launchable = checkLaunchable(authorised, session, context);
  } catch (error) {
    session.release();
    throw error;
  }
  if (!launchable.ok) {
    // Recorded before the lock is given back, so no other call can take the
    // session before this refusal is in the ledger.
    try {
      return recordedIfRecordable(ledger, launchable);
    } finally {
      session.release();
    }
  }

  return {
    ok: true,
    admitted: {
      request,
      ...decidedNow(authorised),
      tools: authorised.tools,
      session,
      runDir: authorised.runDir,
      // The call's own budget, clamped by the policy's maximum, so neither value
      // is ignored (EX-6).
      transcriptBudget: transcriptBudget(request.transcript_budget_bytes, authorised.policy.transcript_budget_bytes),
      callId,
    },
  };
}

/**
 * A queued run, at launch (design sec-4 "Re-admission at launch"): `authorise`
 * again over the admitted profile and root — which must still canonicalise to
 * itself — with each admitted ceiling narrowed to the current maximum, then
 * step 8 and the probe. The session is not re-acquired, and not released on a
 * refusal: the run has owned it since start, and the registry releases it when
 * the refusal settles the run. The run keeps its root, session, request, tools,
 * call id and run directory; what the policy decides is decided anew.
 */
export function readmit(admitted: Admitted, context: AdmissionContext): Step<{ admitted: Admitted }> {
  const authorised = authorise(
    {
      profile: admitted.request.profile,
      root: admitted.root,
      exact: true,
      ceilings: (maxima) => narrowed(admitted.ceilings, maxima),
      tools: admitted.tools,
    },
    context,
    admitted.callId,
  );
  if (!authorised.ok) {return authorised;}

  const launchable = checkLaunchable(authorised, admitted.session, context);
  if (!launchable.ok) {return recordedIfRecordable(ledgerOf(authorised, admitted.callId), launchable);}

  return {
    ok: true,
    admitted: {
      ...admitted,
      ...decidedNow(authorised),
      // An admitted budget left to the reducer's default is that default: a
      // maximum that appeared since may lower it, never raise it.
      transcriptBudget: transcriptBudget(admitted.transcriptBudget ?? DEFAULT_BUDGET_BYTES, authorised.policy.transcript_budget_bytes),
    },
  };
}

/** What the policy decided for a run, as `admit` and `readmit` both take it. */
const decidedNow = (authorised: Authorised): Pick<Admitted, 'root' | 'profile' | 'form' | 'formSource' | 'ceilings' | 'policyDigest' | 'policyPath'> => ({
  root: authorised.root,
  profile: authorised.profile,
  form: authorised.form,
  formSource: authorised.formSource,
  ceilings: authorised.ceilings,
  policyDigest: authorised.policyDigest,
  policyPath: authorised.policyPath,
});

/** Each unit ADMITTED holds, lowered to MAXIMA's where that is lower: never a
 *  refusal, only a narrowing. A unit it lacks stays absent, so `clampCeilings`
 *  gives it the current maximum. */
function narrowed(admitted: Maxima, maxima: Maxima): Maxima {
  const ceilings: Maxima = {};
  for (const unit of CEILING_FIELDS) {
    const limit = admitted[unit];
    const maximum = maxima[unit];
    if (limit !== undefined) {ceilings[unit] = maximum === undefined ? limit : Math.min(limit, maximum);}
  }
  return ceilings;
}

/** A step-8 or probe refusal, recorded unless it is the ledger that failed. */
function recordedIfRecordable(ledger: Ledger, launchable: Refused & { recordable: boolean }): Refused {
  const { recordable, ...refusal } = launchable;
  return recordable ? recorded(ledger, refusal) : refusal;
}

/**
 * Steps 1-6 and the `tools` narrowing: the policy (steps 1-2, which records its
 * own refusals), then the profile, the root, the capability and its form, the
 * ceilings and the narrowed tool set — first failure wins, each recorded here.
 */
function authorise(
  asked: Asked,
  context: AdmissionContext,
  callId: CallId,
): Step<Authorised> {
  const granted = admitCall(context.locations, callId);
  // Steps 1-2's refusal is `admitCall`'s to record: it decided, so it wrote.
  if (!granted.ok) {return { ok: false, reason: granted.reason, detail: granted.detail };}

  const decided = decide(asked, context, granted);
  return decided.ok ? decided : recorded(ledgerOf({ runDir: granted.runDir, policyDigest: granted.digest }, callId), decided);
}

/** Steps 3-6 and the `tools` narrowing, all against the one policy read. */
function decide(asked: Asked, context: AdmissionContext, granted: Granted): Step<Authorised> {
  // Step 3: the profile, from the start-up snapshot only, its capability pinned
  // by the policy's map.
  const profile = resolveProfile(context.startup.profiles, asked.profile, granted.policy.profiles);
  if (!profile.ok) {return profile;}

  // Step 4: the root, canonicalised and allowlisted by components.
  const root = rootOf(asked, context, granted.policy.roots);
  if (!root.ok) {return root;}

  // Step 5: the capability selects the machine slot, and the slot's declared
  // extensions must be able to deliver the profile's tools (EX-7). Both come
  // first, before the approvals store or the project's link is read, so a
  // malformed store never pre-empts today's `profile-invalid` (design sec-2).
  const slot = selectSlot(granted.policy, profile.profile.filesystem);
  if (!slot.ok) {return slot;}
  const extensions = checkProfileExtensions(profile.profile, formExtensions(slot.form));
  if (!extensions.ok) {return extensions;}

  const form = selectedForm(granted, profile.profile.filesystem, root, slot, context);
  if (!form.ok) {return form;}

  // Step 6: the ceilings, clamped downward.
  const ceilings = clampCeilings(asked.ceilings(granted.policy.maxima), granted.policy.maxima);
  if (!ceilings.ok) {return ceilings;}

  // The call's `tools` may only narrow the profile's snapshotted set; the whole
  // narrowed list is what the launch form will hand to `--tools` (PHASE-06).
  const tools = effectiveTools(profile.profile, asked.tools);
  if (!tools.ok) {return tools;}

  // The admitted values (`root.root`, `form.form`, `ceilings.ceilings`,
  // `tools.tools`) and the policy digest are what PHASE-06's spawn consumes.
  return {
    ok: true,
    policy: granted.policy,
    policyDigest: granted.digest,
    policyPath: granted.policyPath,
    runDir: granted.runDir,
    sessionHome: granted.sessionHome,
    root: root.root,
    profile: profile.profile,
    form: form.form,
    formSource: form.source,
    ceilings: ceilings.ceilings,
    tools: tools.tools,
  };
}

/** Step 4: the asked root, canonicalised and allowlisted. Asked to be exact, it
 *  must first still canonicalise to itself — one whose component is now a symlink
 *  is not the root that was admitted, wherever it now leads. */
function rootOf(asked: Asked, context: AdmissionContext, roots: readonly string[]): RootResolution {
  const moved = asked.exact === true && asked.root !== undefined ? movedRoot(asked.root) : null;
  return moved ?? resolveRoot(asked.root, context.launchDir, roots);
}

/** ROOT's refusal when it no longer canonicalises to itself; null when it does,
 *  or when it cannot be read at all, which `resolveRoot` then names. */
function movedRoot(root: string): Extract<RootResolution, { ok: false }> | null {
  let canonical: string;
  try {
    canonical = realpathSync(root);
  } catch {
    return null;
  }
  if (canonical === root) {return null;}
  return { ok: false, reason: 'root-missing', detail: `${root} now resolves to ${canonical}: the admitted root no longer exists as itself` };
}

/**
 * Step 5's second half: whether an approval governs this call is itself the
 * selection (DEC-008), so a store that cannot be read — or a location no store
 * can be read from — decides nothing and refuses. The lookup is the one
 * composition admission and `allow` share: store, governing approval, base, probe.
 */
function selectedForm(
  granted: Granted,
  capability: Filesystem,
  root: { root: string; rootsEntry: string },
  slot: SlotSelection,
  context: AdmissionContext,
): SelectedForm {
  const approvalsPath = context.locations.approvalsPath;
  if (!approvalsPath.ok) {
    return {
      ok: false,
      reason: 'form-unapproved',
      detail: `the approvals store location is unusable (${approvalsPath.detail}): no call can be shown to be approved, so nothing ran`,
    };
  }
  const lookup = lookupProjectForm({
    approvalsPath: approvalsPath.path,
    capability,
    root: root.root,
    rootsEntry: root.rootsEntry,
    writable: writablePaths(granted.policy, granted.sessionHome),
  });
  if (!lookup.ok) {return { ok: false, reason: 'form-unapproved', detail: `${lookup.detail}: nothing ran` };}
  return chooseForm(slot, lookup.governing, lookup.base, lookup.probe);
}

/**
 * Step 7: the session — grammar, ownership, and the (root, capability) binding
 * recorded in the same critical section as first use (design sec-2 step 7,
 * sec-6). Ownership is conferred by an O_EXCL create and survives until the
 * answer is decided, so it is released last.
 */
function seat(
  session: string | undefined,
  authorised: Authorised,
  context: AdmissionContext,
  callId: CallId,
): SessionAcquisition {
  return acquireSession({
    sessionHome: authorised.sessionHome,
    runDir: authorised.runDir,
    session,
    root: authorised.root,
    capability: authorised.profile.filesystem,
    callId,
    policyDigest: authorised.policyDigest,
    procDir: context.procDir,
    here: context.here,
  });
}

/** Step 8, then the ledger probe (design sec-2 step 8, sec-6): the last two
 *  decisions before the run, both taken while the session lock is held. */
function checkLaunchable(
  authorised: Authorised,
  session: SessionAcquisition & { ok: true },
  context: AdmissionContext,
): Launchable {
  // Step 8: the child view — the canonicalised union of {root, the active
  // session directory, the policy's exposure paths} — must not reach a protected
  // store more strongly than that store tolerates (design sec-2 step 8,
  // sec-3). The refusal names the overlapping member and the store and stops;
  // nothing is masked, and no run directory exists yet.
  const view = checkChildView({
    root: authorised.root,
    capability: authorised.profile.filesystem,
    sessionDir: session.sessionDir,
    exposure: authorised.policy.exposure,
    sessionHome: authorised.sessionHome,
    runDir: authorised.runDir,
    policyPath: authorised.policyPath,
    approvalsPath: usable(context.locations.approvalsPath),
    profileLayers: context.locations.profileLayers,
    helpLayers: context.locations.helpLayers,
  });
  if (!view.ok) {return { ...view, recordable: true };}

  // Design sec-6's failure policy: a server that cannot record a refusal must
  // not start a run it also could not abort-audit. Decided before the run
  // directory exists, so nothing has been allocated and nothing is spawned.
  if (!writeAttemptProbe(authorised.runDir)) {
    return {
      ok: false,
      reason: 'audit-unavailable',
      detail: `${attemptsPath(authorised.runDir)} cannot be appended to: the server does not launch a run it cannot record`,
      recordable: false,
    };
  }
  return { ok: true };
}
