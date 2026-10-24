// The two operator verbs over the approvals store (design sec-3, contract
// `docs/contract/quotient-approvals-1.md`): `quotient allow` reports what a
// project's form links are and, given the identities it printed, records them;
// `quotient revoke` addresses a *stored* root and removes what was recorded.
//
// One composition, shared with admission: `allow` observes through
// `lookupProjectForm` and nothing else, so the report and step 5 cannot disagree
// about what governs a root or what is at its link. The report is rendered by a
// pure function of those observations and the machine slot; `revoke` reads
// neither the policy nor the filesystem, only the store, because an approval
// keeps governing after its root leaves `roots` or its directory is gone.
//
// No side effects at import: `src/cli.ts` dispatches here with its own sinks.
import { normalize, resolve } from 'node:path';
import { resolveLocations, type Env, type Resolved } from './config.ts';
import { governingApproval, isDigest, readApprovals, updateApprovals, type Approval } from './server/approvals.ts';
import {
  chooseForm,
  lookupProjectForm,
  probeProjectForm,
  projectLink,
  type ProjectForm,
  type ProjectFormLookup,
} from './server/forms.ts';
import { within } from './server/paths.ts';
import { readPolicy, selectSlot, writablePaths, type Policy, type SlotSelection } from './server/policy.ts';
import { isFilesystem, resolveRoot, type Filesystem } from './server/profiles.ts';

/** Where a verb writes: `src/cli.ts` passes its stdout and stderr. */
export type Write = (text: string) => void;

/** Each verb's usage: a malformed `revoke` never reads like a malformed `allow`. */
const USAGE = {
  allow: `usage: quotient allow [<path>]   report what the project's form links resolve to
       quotient allow <path> <capability>=<realpath>@<sha256>...   record those identities

<path> defaults to the current directory and must be inside an allowlisted root.
<capability> is read or write. Approving is the operator's act: the digest is the
confirmation, and nothing prompts.`,
  revoke: `usage: quotient revoke <approval-root> [<capability>...]   remove recorded approvals

<approval-root> is a recorded root, made absolute and normalised lexically, never
resolved. <capability> is read or write; with none named, every capability recorded
for that root is removed.`,
};

// ── The report (EX-2), a pure render ──────────────────────────────────────

/** What admission would see for one capability: an observation of it. */
type Observation = Extract<ProjectFormLookup, { ok: true }>;

/**
 * One capability as the report shows it: the machine slot, the observation that
 * admission would make (which names the governing approval and its own link),
 * and — when a record would key a different root — the link at the roots entry.
 */
export type CapabilityView = {
  capability: Filesystem;
  slot: SlotSelection;
  observed: Observation;
  candidate?: ProjectForm;
};

/** The report's two fixed facts: the root the operator asked about (admission
 *  decides for calls there) and the roots entry a record would key. */
export type ReportTarget = { root: string; rootsEntry: string };

const COLUMN = 10;

/** A labelled line: LABEL in its column, then TEXT. */
const row = (label: string, text: string): string => `${label.padEnd(COLUMN)}${text}`;

/** A block's continuation line: the label in the second column. */
const cont = (label: string, text: string): string => `${' '.repeat(COLUMN)}${row(label, text)}`;

/** A line that belongs to the line above it, with no label of its own. */
const note = (text: string): string => `${' '.repeat(2 * COLUMN)}${text}`;

/** An identity as the commands spell it: the real path and the digest together. */
const asArg = (path: string, sha256: string): string => `${path}@${sha256}`;

/** The machine form, as the line for an absent link names it. */
function machineForm(slot: SlotSelection): string {
  if (!slot.ok) {return `no machine form for this capability (${slot.detail})`;}
  return slot.form.kind === 'confined'
    ? `machine form ${slot.form.path}`
    : `machine form unconfined (${slot.form.pi})`;
}

/** What is at the link a record would key: an identity, or why there is none. */
function linkLine(candidate: ProjectForm, slot: SlotSelection): string {
  if (candidate.kind === 'usable') {return `link      ${candidate.link}`;}
  if (candidate.kind === 'absent') {return `link      absent; ${machineForm(slot)}`;}
  return `link      unusable: ${candidate.detail}`;
}

/** The candidate's identity lines, empty when there is no identity to show. */
function identityLines(candidate: ProjectForm): string[] {
  return candidate.kind === 'usable'
    ? [cont('resolves', candidate.path), cont('sha256', candidate.sha256)]
    : [];
}

/** What a governing approval's own link says, when it no longer matches it. */
function governingMismatch(probe: ProjectForm, governing: Approval, link: string): string | undefined {
  if (probe.kind === 'absent') {return `its link ${link} is missing`;}
  if (probe.kind === 'invalid') {return `its link is unusable: ${probe.detail}`;}
  if (probe.path !== governing.path || probe.sha256 !== governing.sha256) {
    return `but ${link} now resolves to ${asArg(probe.path, probe.sha256)}`;
  }
  return undefined;
}

/**
 * Which approval governs calls there now — which may sit at a shallower root than
 * the roots entry — and, when that approval's own link is missing or changed,
 * what is wrong and the `quotient revoke` that would return the calls to the
 * machine form.
 */
function governingLines(view: CapabilityView): string[] {
  const { governing, base, probe } = view.observed;
  if (governing === undefined) {return [cont('governed', 'no approval')];}
  const head = cont('governed', `the approval for ${governing.root} records ${asArg(governing.path, governing.sha256)}`);
  const mismatch = governingMismatch(probe, governing, projectLink(base, governing.capability));
  if (mismatch === undefined) {return [head];}
  return [head, note(mismatch), cont('advice', `quotient revoke ${governing.root} returns these calls to the machine form`)];
}

/**
 * The approval that would keep governing after a record at ROOTSENTRY: admission
 * takes the deepest approval root (sec-2), so one recorded above a deeper
 * approval changes nothing and the report must not suggest it.
 */
function deeperApproval(rootsEntry: string, governing: Approval | undefined): Approval | undefined {
  if (governing === undefined || governing.root === rootsEntry) {return undefined;}
  return within(rootsEntry, governing.root) ? governing : undefined;
}

/** What to do about a deeper approval: revoke it, then record at the roots entry. */
function deeperAdvice(target: ReportTarget, view: CapabilityView): string[] {
  const deeper = deeperApproval(target.rootsEntry, view.observed.governing);
  if (deeper === undefined) {return [];}
  return [
    cont(
      'advice',
      `the approval for ${deeper.root} governs calls at ${target.root}; recording at ${target.rootsEntry} would not change them — run "quotient revoke ${deeper.root}" first`,
    ),
  ];
}

/**
 * What admission would do with this capability, through the same decision
 * (`chooseForm`), shown only when it refuses: the report must not look settled
 * while calls at ROOT are refused (EX-2).
 */
function admissionLine(target: ReportTarget, view: CapabilityView): string[] {
  const verdict = chooseForm(view.slot, view.observed.governing, view.observed.base, view.observed.probe);
  return verdict.ok ? [] : [cont('admission', `calls at ${target.root} are refused: ${verdict.reason}`)];
}

/** The machine slot as the report shows it: what a project form may replace. */
function slotLine(slot: SlotSelection): string {
  if (!slot.ok) {return cont('slot', `none (${slot.detail})`);}
  return slot.form.kind === 'confined'
    ? cont('slot', `confined, extensions [${slot.form.extensions.join(', ')}]`)
    : cont('slot', `unconfined (${slot.form.pi})`);
}

/** One capability's block: its link, identity, approval state and slot. */
function block(target: ReportTarget, view: CapabilityView): string[] {
  const candidate = view.candidate ?? view.observed.probe;
  return [
    row(view.capability, linkLine(candidate, view.slot)),
    ...identityLines(candidate),
    ...governingLines(view),
    ...deeperAdvice(target, view),
    slotLine(view.slot),
    ...admissionLine(target, view),
  ];
}

/** The report's tail: the exact commands that would record what is shown. An
 *  unusable link, a slot with no executable to replace, or a deeper approval that
 *  would keep governing contributes nothing. */
function commandLines(target: ReportTarget, views: readonly CapabilityView[]): string {
  const commands = views.flatMap((view) => {
    const candidate = view.candidate ?? view.observed.probe;
    if (candidate.kind !== 'usable') {return [];}
    if (!view.slot.ok || view.slot.form.kind !== 'confined') {return [];}
    if (deeperApproval(target.rootsEntry, view.observed.governing) !== undefined) {return [];}
    return [`  quotient allow ${target.rootsEntry} ${view.capability}=${asArg(candidate.path, candidate.sha256)}`];
  });
  if (commands.length > 0) {return `to approve what is shown:\n${commands.join('\n')}\n`;}
  return `nothing to approve: ${nothingToApprove(target, views)}\n`;
}

/** Why no command is printed, in the operator's next-command terms. */
function nothingToApprove(target: ReportTarget, views: readonly CapabilityView[]): string {
  const deeper = views.flatMap((view) => {
    const approval = deeperApproval(target.rootsEntry, view.observed.governing);
    return approval === undefined ? [] : [approval];
  });
  if (deeper.length > 0) {
    return `the approval for ${deeper[0].root} governs calls at ${target.root}; run "quotient revoke ${deeper[0].root}" to record at ${target.rootsEntry}`;
  }
  const refused = views.flatMap((view) => {
    const verdict = chooseForm(view.slot, view.observed.governing, view.observed.base, view.observed.probe);
    return verdict.ok ? [] : [verdict.reason];
  });
  if (refused.length > 0) {return `admission refuses these calls (${[...new Set(refused)].join(', ')})`;}
  return `no capability has a usable form at ${target.rootsEntry}`;
}

/**
 * The report, rendered from observations alone (EX-2): no filesystem, no argv.
 * One block per capability, then the commands that would record them.
 */
export function renderReport(target: ReportTarget, views: readonly CapabilityView[]): string {
  const blocks = views.map((view) => block(target, view).join('\n'));
  const head = row('root', `${target.rootsEntry}   (roots entry)`);
  return `${[head, ...blocks].join('\n\n')}\n\n${commandLines(target, views)}`;
}

// ── What both verbs resolve ────────────────────────────────────────────────

/** The capabilities the machine forms declare, in the order the report shows them. */
const CAPABILITIES: readonly Filesystem[] = ['read', 'write'];

/** What `allow` resolves once: the policy, the call's root decision, the writable
 *  set a project form must lie outside, and the store. */
type Context = {
  policy: Policy;
  root: string;
  rootsEntry: string;
  writable: string[];
  approvalsPath: string;
};

type Resolution = { ok: true; context: Context } | { ok: false; detail: string };

/** The policy at LOCATED, or why there is none to read. */
function readablePolicy(located: Resolved): { ok: true; policy: Policy } | { ok: false; detail: string } {
  if (!located.ok) {return { ok: false, detail: `the policy location is unusable (${located.detail})` };}
  const read = readPolicy(located.path);
  return read.ok ? { ok: true, policy: read.policy } : { ok: false, detail: `${read.reason}: ${read.detail}` };
}

/** PATH resolved the way admission resolves a call's `cwd` (EX-1): the policy's
 *  roots decide, and the roots entry is the base `allow` records against. */
function context(path: string, env: Env, cwd: string): Resolution {
  const locations = resolveLocations(env);
  const read = readablePolicy(locations.policyPath);
  if (!read.ok) {return read;}
  const sessionHome = locations.sessionHome;
  if (!sessionHome.ok) {return { ok: false, detail: `the session home is unusable (${sessionHome.detail})` };}
  const root = resolveRoot(path, cwd, read.policy.roots);
  if (!root.ok) {return { ok: false, detail: root.detail };}
  const store = locations.approvalsPath;
  if (!store.ok) {return { ok: false, detail: `the approvals store location is unusable (${store.detail})` };}
  return {
    ok: true,
    context: {
      policy: read.policy,
      root: root.root,
      rootsEntry: root.rootsEntry,
      writable: writablePaths(read.policy, sessionHome.path),
      approvalsPath: store.path,
    },
  };
}

const look = (context: Context, capability: Filesystem, base?: string): ProjectFormLookup =>
  lookupProjectForm({
    approvalsPath: context.approvalsPath,
    capability,
    root: context.root,
    rootsEntry: context.rootsEntry,
    writable: context.writable,
    ...(base === undefined ? {} : { base }),
  });

/** The link a record would key, when it is not the one admission inspects. */
function candidate(
  context: Context,
  capability: Filesystem,
  observed: Observation,
): { ok: true; probe?: ProjectForm } | { ok: false; detail: string } {
  if (observed.base === context.rootsEntry) {return { ok: true };}
  const atRootsEntry = look(context, capability, context.rootsEntry);
  return atRootsEntry.ok ? { ok: true, probe: atRootsEntry.probe } : atRootsEntry;
}

type Views = { ok: true; views: CapabilityView[] } | { ok: false; detail: string };

/** Every declared capability, observed through the one composition. */
function views(context: Context): Views {
  const collected: CapabilityView[] = [];
  for (const capability of CAPABILITIES) {
    if (context.policy.forms[capability] === undefined) {continue;}
    const observed = look(context, capability);
    if (!observed.ok) {return observed;}
    const atRootsEntry = candidate(context, capability, observed);
    if (!atRootsEntry.ok) {return atRootsEntry;}
    collected.push({
      capability,
      slot: selectSlot(context.policy, capability),
      observed,
      ...(atRootsEntry.probe === undefined ? {} : { candidate: atRootsEntry.probe }),
    });
  }
  return { ok: true, views: collected };
}

// ── `quotient allow` ───────────────────────────────────────────────────────

/** The argv of `allow`: the path it applies to, and the identities to record. */
function ask(argv: string[], cwd: string): { ok: true; path: string; pairs: string[] } | { ok: false; detail: string } {
  const [first = '.', ...pairs] = argv;
  if (first.trim() === '') {return { ok: false, detail: '<path> must not be empty' };}
  if (pairs.length === 0 && first.includes('=')) {
    return { ok: false, detail: 'the record form also needs the path it applies to: quotient allow <path> <capability>=<realpath>@<sha256>' };
  }
  return { ok: true, path: resolve(cwd, first), pairs };
}

/** Report, or record what the operator reviewed (EX-1, EX-3). */
export function allow(argv: string[], env: Env, cwd: string, out: Write, err: Write): number {
  const asked = ask(argv, cwd);
  if (!asked.ok) {return usage('allow', err, asked.detail);}
  const resolved = context(asked.path, env, cwd);
  if (!resolved.ok) {return failure('allow', err, resolved.detail);}
  return asked.pairs.length === 0 ? report(resolved.context, out, err) : record(resolved.context, asked.pairs, out, err);
}

/** The report: what is at the root's links now, and the command that would record it. */
function report(context: Context, out: Write, err: Write): number {
  const seen = views(context);
  if (!seen.ok) {return failure('allow', err, seen.detail);}
  out(renderReport({ root: context.root, rootsEntry: context.rootsEntry }, seen.views));
  return 0;
}

/** The record's unit: the capability and the identity the operator reviewed. */
type Identity = { capability: Filesystem; path: string; sha256: string };

/** `<capability>=<realpath>@<sha256>`, split at the last `@` (a digest has none). */
function identity(text: string): Identity | string {
  const at = text.lastIndexOf('@');
  if (at < 0) {return `${text} is not <capability>=<realpath>@<sha256>`;}
  const pair = text.slice(0, at);
  const equals = pair.indexOf('=');
  if (equals < 0) {return `${text} is not <capability>=<realpath>@<sha256>`;}
  const capability = pair.slice(0, equals);
  if (!isFilesystem(capability)) {return `${capability} is not a capability this build serves: read or write`;}
  const sha256 = text.slice(at + 1);
  if (!isDigest(sha256)) {return `${text} is not <capability>=<realpath>@<sha256>: the digest is not 64 lowercase hex characters`;}
  return { capability, path: pair.slice(equals + 1), sha256 };
}

function identities(argv: string[]): { ok: true; identities: Identity[] } | { ok: false; detail: string } {
  const parsed: Identity[] = [];
  for (const text of argv) {
    const one = identity(text);
    if (typeof one === 'string') {return { ok: false, detail: one };}
    if (parsed.some((mine) => mine.capability === one.capability)) {
      return { ok: false, detail: `${one.capability} is given twice: one identity per capability` };
    }
    parsed.push(one);
  }
  return { ok: true, identities: parsed };
}

/**
 * IDENTITY checked once more, under the store's lock and against what is on disk
 * now: the machine slot must be confined, the link must be usable, and the real
 * path **and** digest must both be the ones reviewed (RV-006 F-3 — the same bytes
 * at another path is a different form).
 */
function verify(context: Context, identity: Identity): Approval | string {
  const slot = selectSlot(context.policy, identity.capability);
  if (!slot.ok) {return `${identity.capability}: ${slot.detail}`;}
  if (slot.form.kind !== 'confined') {
    return `${identity.capability}: the machine form is unconfined, so there is no executable for a project form to replace`;
  }
  const probe = probeProjectForm(context.rootsEntry, identity.capability, context.writable);
  if (probe.kind === 'absent') {
    return `${identity.capability}: there is no form at ${projectLink(context.rootsEntry, identity.capability)}`;
  }
  if (probe.kind === 'invalid') {return `${identity.capability}: ${probe.detail}`;}
  if (probe.path !== identity.path || probe.sha256 !== identity.sha256) {
    return `${identity.capability}: you reviewed ${asArg(identity.path, identity.sha256)}, but ${probe.link} now resolves to ${asArg(probe.path, probe.sha256)}; nothing was recorded — review it again`;
  }
  return {
    root: context.rootsEntry,
    capability: identity.capability,
    path: probe.path,
    sha256: probe.sha256,
    approved_at: new Date().toISOString(),
  };
}

/** The change `updateApprovals` applies: check every identity, then record all of
 *  them or none — one failing pair writes nothing. */
function recording(context: Context, identities: readonly Identity[]): (current: Approval[]) => Approval[] | string {
  return (current) => {
    const recordable: Approval[] = [];
    for (const identity of identities) {
      const deeper = deeperApproval(context.rootsEntry, governingApproval(current, context.root, identity.capability));
      if (deeper !== undefined) {
        return `${identity.capability}: the approval for ${deeper.root} governs calls at ${context.root}, so recording at ${context.rootsEntry} would change nothing; run "quotient revoke ${deeper.root}" first`;
      }
      const checked = verify(context, identity);
      if (typeof checked === 'string') {return checked;}
      recordable.push(checked);
    }
    const replaced = (entry: Approval): boolean =>
      entry.root === context.rootsEntry && recordable.some((mine) => mine.capability === entry.capability);
    return [...current.filter((entry) => !replaced(entry)), ...recordable];
  };
}

/** Record the given identities, replacing any entry for the same root and capability. */
function record(context: Context, argv: string[], out: Write, err: Write): number {
  const asked = identities(argv);
  if (!asked.ok) {return usage('allow', err, asked.detail);}
  const update = updateApprovals(context.approvalsPath, recording(context, asked.identities));
  if (!update.ok) {return failure('allow', err, update.detail);}
  for (const identity of asked.identities) {
    out(`recorded ${identity.capability}=${asArg(identity.path, identity.sha256)} for ${context.rootsEntry}\n`);
  }
  return 0;
}

// ── `quotient revoke` ──────────────────────────────────────────────────────

/** What `revoke` addresses: a stored root, and the capabilities to remove. */
type Revocation = { root: string; capabilities: Filesystem[] };

/** The argv of `revoke`: the stored root, made absolute and normalised lexically —
 *  never resolved, because a resolution would reach a different key (EX-5). */
function askRevocation(argv: string[], cwd: string): { ok: true; revocation: Revocation } | { ok: false; detail: string } {
  const [root, ...rest] = argv;
  if (argv.length === 0) {
    return { ok: false, detail: 'revoke needs the recorded approval root: quotient revoke <approval-root> [<capability>...]' };
  }
  const capabilities: Filesystem[] = [];
  for (const capability of rest) {
    if (!isFilesystem(capability)) {return { ok: false, detail: `${capability} is not a capability this build serves: read or write` };}
    if (capabilities.includes(capability)) {
      return { ok: false, detail: `${capability} is given twice: one capability per argument` };
    }
    capabilities.push(capability);
  }
  return { ok: true, revocation: { root: normalize(resolve(cwd, root)), capabilities } };
}

/** The stored roots, for a refusal that must not be a silent success. */
const storedRoots = (current: readonly Approval[]): string =>
  current.length === 0 ? 'none' : [...new Set(current.map((entry) => entry.root))].join(', ');

/** One revoke against the stored entries: the survivors, and what it removed. */
function revokeFrom(
  current: readonly Approval[],
  asked: Revocation,
): { approvals: Approval[]; revoked: Filesystem[] } | string {
  const stored = current.filter((entry) => entry.root === asked.root);
  if (stored.length === 0) {return `no approval is recorded for ${asked.root}; stored roots: ${storedRoots(current)}`;}
  const unknown = asked.capabilities.find((capability) => !stored.some((entry) => entry.capability === capability));
  if (unknown !== undefined) {
    return `no approval is recorded for ${unknown} at ${asked.root}; stored roots: ${storedRoots(current)}`;
  }
  const revoked = asked.capabilities.length === 0 ? stored.map((entry) => entry.capability) : [...asked.capabilities];
  return {
    approvals: current.filter((entry) => entry.root !== asked.root || !revoked.includes(entry.capability)),
    revoked,
  };
}

/** Remove recorded approvals for a stored root, named capabilities or all of them. */
export function revoke(argv: string[], env: Env, cwd: string, out: Write, err: Write): number {
  const asked = askRevocation(argv, cwd);
  if (!asked.ok) {return usage('revoke', err, asked.detail);}
  const store = resolveLocations(env).approvalsPath;
  if (!store.ok) {return failure('revoke', err, `the approvals store location is unusable (${store.detail})`);}
  // Refuse before the lock: a root with nothing recorded is not a reason to
  // create a store, so a mistyped root never leaves an empty approvals.json.
  const current = readApprovals(store.path);
  if (!current.ok) {return failure('revoke', err, current.detail);}
  const refusal = revokeFrom(current.approvals, asked.revocation);
  if (typeof refusal === 'string') {return failure('revoke', err, refusal);}
  const revoked: Filesystem[] = [];
  const update = updateApprovals(store.path, (now) => {
    const outcome = revokeFrom(now, asked.revocation);
    if (typeof outcome === 'string') {return outcome;}
    revoked.push(...outcome.revoked);
    return outcome.approvals;
  });
  if (!update.ok) {return failure('revoke', err, update.detail);}
  out(`revoked ${revoked.join(', ')} for ${asked.revocation.root}\n`);
  return 0;
}

// ── The verbs' two exits ───────────────────────────────────────────────────

/** The verb failed for a reason the operator can act on (exit 1). */
function failure(verb: string, err: Write, detail: string): number {
  err(`quotient ${verb}: ${detail}\n`);
  return 1;
}

/** The invocation was malformed: the message and the usage (exit 2). */
function usage(verb: 'allow' | 'revoke', err: Write, detail: string): number {
  err(`quotient ${verb}: ${detail}\n${USAGE[verb]}\n`);
  return 2;
}
