// The project's form, judged and decided (design sec-2 "Step 5: selecting the
// form", "The selection module"): what is at `<base>/.quotient/forms/<capability>`,
// and what step 5 does with it once the approvals store is read.
//
// Three units, one job each. `probeProjectForm` judges the file — a real path, an
// executable regular file, outside every writable path, and its digest.
// `chooseForm` decides from the machine slot, the governing approval and the
// probe; it is pure, so every row of the design's table is a unit test.
// `lookupProjectForm` is the one composition of store read, governing approval,
// base and probe that admission and `quotient allow` share, so the two cannot
// disagree about what governs a root or what is at its link. The filesystem is
// touched in `probeProjectForm` and (through `readApprovals`) in
// `lookupProjectForm`; nothing here reads a policy or spawns anything.
//
// Imports point one way: this module imports `approvals.ts`, never the reverse.
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { governingApproval, readApprovals, type Approval } from './approvals.ts';
import { sha256Hex } from './evidence.ts';
import { absent, errorCode, within } from './paths.ts';
import { formExtensions, type Form, type FormSource, type SlotRefusal, type SlotSelection } from './policy.ts';
import type { Filesystem } from './profiles.ts';

/** Step 5's two project-form refusals (the result contract's Refusals table). */
export type ProjectFormRefusal = 'form-invalid' | 'form-unapproved';

/**
 * What is at `<base>/.quotient/forms/<capability>`, judged without the approvals
 * store: nothing there, something unusable (with the reason), or the real
 * executable and the digest of its bytes.
 */
export type ProjectForm =
  | { kind: 'absent' }
  | { kind: 'invalid'; link: string; detail: string }
  | { kind: 'usable'; link: string; path: string; sha256: string };

/** The form's one location, spelled once: `<base>/.quotient/forms/<capability>`.
 *  Exported for `approve.ts`, whose report and record name the same path. */
export const projectLink = (base: string, capability: Filesystem): string =>
  join(base, '.quotient', 'forms', capability);

/** The capability a project link names: its last component. */
const linkCapability = (link: string): string => basename(link);

type Fault = { ok: true } | { ok: false; detail: string };
type RealPath = { ok: true; path: string } | { ok: false; detail: string };
type Digest = { ok: true; sha256: string } | { ok: false; detail: string };

/** The real path LINK resolves to (usability rule 1: a dangling link is broken). */
function resolvedLink(link: string): RealPath {
  try {
    return { ok: true, path: realpathSync(link) };
  } catch (error) {
    return { ok: false, detail: `${link} does not resolve (${errorCode(error)})` };
  }
}

/** Whether LINK's target is a regular file its user can execute (rule 2). */
function executableFile(link: string, real: string): Fault {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(real);
  } catch (error) {
    return { ok: false, detail: `${link} resolves to ${real}, which could not be read (${errorCode(error)})` };
  }
  if (!stats.isFile()) {return { ok: false, detail: `${link} resolves to ${real}, which is not a regular file` };}
  try {
    accessSync(real, constants.X_OK);
  } catch (error) {
    return { ok: false, detail: `${link} resolves to ${real}, which is not executable by this user (${errorCode(error)})` };
  }
  return { ok: true };
}

/** The first writable path REAL lies inside, if any (rule 3: the swap race). */
const writableContaining = (real: string, writable: readonly string[]): string | undefined =>
  writable.find((path) => within(path, real));

/** The digest of the real file's bytes: identity's second half. */
function digestOf(link: string, real: string): Digest {
  try {
    return { ok: true, sha256: sha256Hex(readFileSync(real)) };
  } catch (error) {
    return { ok: false, detail: `${link} resolves to ${real}, which could not be read (${errorCode(error)})` };
  }
}

/** LINK, absent or judged. A failed `lstat` is absent only by the shared rule: a
 *  dangling link and an `ENOTDIR` are a broken layout, not an absent form. */
function located(link: string): ProjectForm | { kind: 'present' } {
  try {
    lstatSync(link);
    return { kind: 'present' };
  } catch (error) {
    if (absent(link, error)) {return { kind: 'absent' };}
    return { kind: 'invalid', link, detail: `${link} could not be read (${errorCode(error)})` };
  }
}

/**
 * Usability rules 1-3 for the capability's link at BASE: the real path must be a
 * regular executable file, and it must lie outside every writable path, so no
 * delegate admitted under this policy can rewrite it between hashing and exec.
 * Rule 4 (a confined machine slot) judges the slot, so it lives in `chooseForm`.
 */
export function probeProjectForm(
  base: string,
  capability: Filesystem,
  writable: readonly string[],
): ProjectForm {
  const link = projectLink(base, capability);
  const lookup = located(link);
  if (lookup.kind !== 'present') {return lookup;}

  const resolved = resolvedLink(link);
  if (!resolved.ok) {return { kind: 'invalid', link, detail: resolved.detail };}
  const { path: real } = resolved;

  const file = executableFile(link, real);
  if (!file.ok) {return { kind: 'invalid', link, detail: file.detail };}

  const writablePath = writableContaining(real, writable);
  if (writablePath !== undefined) {
    return { kind: 'invalid', link, detail: `${link} resolves to ${real}, inside the writable path ${writablePath}` };
  }

  const digest = digestOf(link, real);
  if (!digest.ok) {return { kind: 'invalid', link, detail: digest.detail };}

  return { kind: 'usable', link, path: real, sha256: digest.sha256 };
}

// ── The decision (EX-3) ───────────────────────────────────────────────────

/** Step 5's outcome: the form to run and where it came from, or the first refusal. */
export type SelectedForm =
  | { ok: true; form: Form; source: FormSource }
  | { ok: false; reason: SlotRefusal | ProjectFormRefusal; detail: string };

/** An identity as an operator reads it: the real path and the digest together. */
const identity = (path: string, sha256: string): string => `${path} (sha256 ${sha256})`;

/** The identity an approval records. */
const recorded = (approval: Approval): string => identity(approval.path, approval.sha256);

/** Whether an approval governs, and its identity when one does. Every refusal
 *  says which of the two it is: the operator's next command depends on it. */
const governs = (governing: Approval | undefined): string =>
  governing === undefined
    ? 'no approval governs this call'
    : `the approval for ${governing.root} records ${recorded(governing)}`;

/** A probe that found something at the link (the judged file, usable or not). */
type PresentForm = Exclude<ProjectForm, { kind: 'absent' }>;

/** The machine slot a project form can replace: a confined one, with an
 *  executable and extensions. Rule 4 refuses every other slot kind. */
type ConfinedForm = Extract<Form, { kind: 'confined' }>;

/** What the probe observed, for a refusal that decides against it. */
const observed = (probe: PresentForm): string =>
  probe.kind === 'usable' ? `${probe.link} resolves to ${identity(probe.path, probe.sha256)}` : probe.detail;

/** DEC-010's rule 4, in the operator's words: the refusal's tail. */
const UNCONFINED =
  'only a confined machine slot has an executable for a project form to replace; a project form is never unconfined';

/**
 * Rule 4: a project form substitutes only a confined slot's executable. A link or
 * an approval at an unconfined slot has nothing to substitute, so it refuses
 * rather than being ignored: a project can never express unconfined. Undefined
 * when there is neither, and the machine slot simply stands. BASE is where the
 * probe was taken, so the link named is one that was actually looked at.
 */
function unconfinedRefusal(base: string, governing: Approval | undefined, probe: ProjectForm): string | undefined {
  if (probe.kind !== 'absent') {return `${observed(probe)}; ${governs(governing)}; ${UNCONFINED}`;}
  if (governing === undefined) {return undefined;}
  return `${projectLink(base, governing.capability)} is absent; ${governs(governing)}; ${UNCONFINED}`;
}

/** A usable project form nobody recorded: the operator's first approval at BASE. */
const firstApproval = (base: string, probe: Extract<ProjectForm, { kind: 'usable' }>): SelectedForm => ({
  ok: false,
  reason: 'form-unapproved',
  detail: `${observed(probe)}, and no approval governs ${base}: approve it with "quotient allow ${base} ${linkCapability(probe.link)}=${probe.path}@${probe.sha256}"`,
});

/**
 * The governed rows of the design's table. The approval is the selection: the
 * call runs exactly the approved identity or refuses, and deleting the link is
 * not a way back to the machine slot — only `quotient revoke` is.
 */
function governed(machine: ConfinedForm, governing: Approval, base: string, probe: ProjectForm): SelectedForm {
  if (probe.kind === 'absent') {
    return {
      ok: false,
      reason: 'form-invalid',
      detail: `${projectLink(base, governing.capability)} is absent, and ${governs(governing)}: the approved form is missing; restore it, or run "quotient revoke ${governing.root}" to return these calls to the machine form`,
    };
  }
  if (probe.kind === 'invalid') {
    return { ok: false, reason: 'form-invalid', detail: `${probe.detail}; ${governs(governing)}` };
  }
  if (probe.path !== governing.path || probe.sha256 !== governing.sha256) {
    return {
      ok: false,
      reason: 'form-unapproved',
      detail: `${observed(probe)}, but ${governs(governing)}: the identity changed since it was approved, so nothing ran. If the change is the operator's, record it with "quotient allow ${governing.root} ${governing.capability}=${probe.path}@${probe.sha256}"`,
    };
  }
  // Reaching here the slot is confined (rule 4 refused above), so the project
  // form replaces its executable and inherits its extensions.
  return {
    ok: true,
    form: { kind: 'confined', path: probe.path, extensions: [...formExtensions(machine)] },
    source: { kind: 'project', root: governing.root, sha256: probe.sha256 },
  };
}

/**
 * Step 5's decision, pure: the machine slot, the governing approval and what was
 * found at BASE (`probeProjectForm` there) are read by the caller. First failure
 * wins, in the design's order — the slot, then rule 4, then the approval, then
 * the link at BASE.
 */
export function chooseForm(
  slot: SlotSelection,
  governing: Approval | undefined,
  base: string,
  probe: ProjectForm,
): SelectedForm {
  if (!slot.ok) {return slot;}
  const machine = slot.form;
  // Rule 4 fails closed before the approval is consulted, and an unconfined slot
  // with neither a link nor an approval simply stands; either way it is decided
  // here, so every row below holds a confined machine slot.
  if (machine.kind === 'unconfined') {
    const refusal = unconfinedRefusal(base, governing, probe);
    return refusal === undefined
      ? { ok: true, form: machine, source: { kind: 'policy' } }
      : { ok: false, reason: 'form-invalid', detail: refusal };
  }
  if (governing !== undefined) {return governed(machine, governing, base, probe);}
  if (probe.kind === 'absent') {return { ok: true, form: machine, source: { kind: 'policy' } };}
  if (probe.kind === 'invalid') {
    return { ok: false, reason: 'form-invalid', detail: `${probe.detail}; no approval governs ${base}` };
  }
  return firstApproval(base, probe);
}

// ── The lookup (EX-7) ─────────────────────────────────────────────────────

/**
 * What step 5 knows about a project form before deciding: which approval governs
 * the call, the base its link is at, and the probe there — or why the store
 * could not be read. A store that cannot be read decides nothing, so it refuses.
 */
export type ProjectFormLookup =
  | { ok: true; governing: Approval | undefined; base: string; probe: ProjectForm }
  | { ok: false; detail: string };

/**
 * The one composition admission and `quotient allow` share: read the store, take
 * the governing approval, pick the base, probe there. The base is the governing
 * approval's root when there is one — a delegate can retarget a symlinked `roots`
 * entry, so the roots entry alone could downgrade an approved call to the machine
 * default — and otherwise the roots entry, unless the caller names one (`allow`
 * observes the candidate at its own roots entry).
 */
export function lookupProjectForm(input: {
  approvalsPath: string;
  capability: Filesystem;
  root: string;
  rootsEntry: string;
  writable: readonly string[];
  base?: string;
}): ProjectFormLookup {
  const store = readApprovals(input.approvalsPath);
  if (!store.ok) {
    return { ok: false, detail: `the approvals store is unreadable or malformed: ${store.detail}` };
  }
  const governing = governingApproval(store.approvals, input.root, input.capability);
  const base = input.base ?? governing?.root ?? input.rootsEntry;
  return { ok: true, governing, base, probe: probeProjectForm(base, input.capability, input.writable) };
}
