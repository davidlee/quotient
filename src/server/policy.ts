// The operator artefact and the first two validation steps (design sec-1,
// sec-2 steps 1-2, sec-6).
//
// One read-only file, read once per call, so a change applies to the next call.
// This build serves one posture: `per-call`. A policy asking for `static`, or
// carrying a field that only static mode declares, is refused rather than
// downgraded — there is no branch here that reaches an unwrapped agent on the
// host (RV-046 F-1).
//
// The launch environment is part of the contract, not something inferred: the
// policy path, the run dir and the session home are absolute or the call is
// refused. Nothing is defaulted from the caller's working directory.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { usable } from '../config.ts';
import type { Locations } from '../config.ts';
import { appendAttempt, sha256Hex } from './evidence.ts';
import type { CallId } from './evidence.ts';
import { MCP_EXTENSION, PROFILE_NAME, isFilesystem } from './profiles.ts';
import type { Filesystem } from './profiles.ts';


/** The only posture this build serves (design sec-1). */
export type PolicyMode = 'per-call';

export type Maxima = {
  requests?: number;
  tokens?: number;
  cost_usd?: number;
  wall_clock_s?: number;
};

/**
 * How a capability's child runs. Confined: a flake-provided launcher that owns
 * the confinement, plus the extension paths it passes (`extensions` is empty
 * for the plain string form; it is what a profile's `mcp__*` tools are compared
 * against). Unconfined: pi itself, named by absolute path — write only, and
 * never a PATH lookup.
 */
export type Form =
  | { kind: 'confined'; path: string; extensions: string[] }
  | { kind: 'unconfined'; pi: string };

/** The per-call wrapper forms, one per filesystem capability. The server names
 *  no jail flag; it selects a form and the form owns its confinement. */
export type Forms = { read?: Form; write?: Form };

/** The schema tag this build reads. */
export const POLICY_SCHEMA = 'quotient-policy/1';

export type Policy = {
  schema: typeof POLICY_SCHEMA;
  mode: PolicyMode;
  /** Canonicalisable roots a call may name (consumed by PHASE-03). */
  roots: string[];
  maxima: Maxima;
  /** The profiles the policy allows, each pinned to a filesystem capability. */
  profiles: Record<string, Filesystem>;
  forms: Forms;
  /** The writable host paths a form shares with the child beyond the root, the
   *  session directory and its private temp: an input to step 8. */
  exposure: string[];
  enabled: boolean;
  /** Transcript byte ceiling (wired by PHASE-08). */
  transcript_budget_bytes?: number;
};

/** The refusal tokens steps 1-2 can produce. Later phases add their own. */
export type RefusalReason =
  | 'policy-unavailable'
  | 'policy-invalid'
  | 'posture-unsupported'
  | 'disabled';

export type Admission =
  | {
      ok: true;
      policy: Policy;
      /** sha256 of the policy bytes as read. */
      digest: string;
      policyPath: string;
      runDir: string;
      sessionHome: string;
    }
  | { ok: false; reason: RefusalReason; detail: string; digest: string | null };

export const REQUIRED_FIELDS: readonly string[] = ['schema', 'mode', 'roots', 'maxima', 'profiles', 'forms', 'exposure', 'enabled'];
export const OPTIONAL_FIELDS: readonly string[] = ['transcript_budget_bytes'];
/**
 * Fields only the static posture declares. Their presence is a posture refusal,
 * not a schema one: this build must not drop them and pretend the policy asked
 * for what it serves (design sec-1, EX-4).
 */
export const STATIC_ONLY_FIELDS: readonly string[] = ['agent', 'root', 'filesystem', 'session_home', 'run_dir', 'evidence_dir'];
export const MAXIMA_FIELDS: readonly string[] = ['requests', 'tokens', 'cost_usd', 'wall_clock_s'];
const FORM_KEYS: readonly string[] = ['path', 'extensions', 'unconfined'];

type PolicyCheck = { ok: true; policy: Policy } | { ok: false; reason: RefusalReason; detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAbsolutePath = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value);

const invalid = (detail: string): PolicyCheck => ({ ok: false, reason: 'policy-invalid', detail });

/**
 * Read, parse and validate the artefact. The digest is present whenever the
 * bytes were readable — an unparsable file still has an identity worth recording
 * (EX-3).
 *
 * One parse path, and it is the only one: the gate's switch re-reads the file
 * through this function, so a policy the server would refuse at admission is the
 * same policy its tick refuses mid-run.
 */
export function readPolicy(policyPath: string): { ok: true; policy: Policy; digest: string } | { ok: false; reason: RefusalReason; detail: string; digest: string | null } {
  let raw: Buffer;
  try {
    raw = readFileSync(policyPath);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'unknown error';
    return { ok: false, reason: 'policy-unavailable', detail: `${policyPath} could not be read (${code})`, digest: null };
  }
  const digest = sha256Hex(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, reason: 'policy-invalid', detail: `${policyPath} is not valid JSON`, digest };
  }
  const check = validatePolicy(parsed);
  if (!check.ok) return { ok: false, reason: check.reason, detail: check.detail, digest };
  return { ok: true, policy: check.policy, digest };
}

/**
 * One form value: an absolute path string (which declares no extension), an
 * object naming the path and the `-e` paths the form passes, or
 * `{ unconfined: <absolute pi path> }` for a write form. Nothing else is
 * accepted inside the object: an operator who mistypes `extensions` must not
 * get a form that silently passes none.
 *
 * The extension list is not free-form: the launch forms pass no `-e` other than
 * `builtin:mcp` (design sec-3), so an entry naming anything else is a policy that
 * describes a launcher this build does not have, and is refused rather than
 * carried as a claim the spawn never acts on.
 */
function readForm(field: string, value: unknown): { ok: true; form: Form } | { ok: false; detail: string } {
  if (isAbsolutePath(value)) return { ok: true, form: { kind: 'confined', path: value, extensions: [] } };
  if (!isRecord(value)) {
    return { ok: false, detail: `forms.${field} must be an absolute path string or an object carrying one` };
  }
  for (const key of Object.keys(value)) {
    if (!FORM_KEYS.includes(key)) return { ok: false, detail: `unknown policy field: forms.${field}.${key}` };
  }
  if (Object.hasOwn(value, 'unconfined')) {
    if (Object.hasOwn(value, 'path')) return { ok: false, detail: `forms.${field}: path and unconfined are exclusive` };
    if (Object.hasOwn(value, 'extensions')) return { ok: false, detail: `unknown policy field: forms.${field}.extensions` };
    if (field === 'read') return { ok: false, detail: `forms.${field}: a read form cannot be unconfined` };
    if (!isAbsolutePath(value.unconfined)) {
      return { ok: false, detail: `forms.${field}.unconfined must be an absolute path to pi (there is no PATH lookup)` };
    }
    return { ok: true, form: { kind: 'unconfined', pi: value.unconfined } };
  }
  const path = value.path;
  if (!isAbsolutePath(path)) return { ok: false, detail: `forms.${field}.path must be an absolute path string` };
  const extensions = value.extensions;
  if (extensions === undefined) return { ok: true, form: { kind: 'confined', path, extensions: [] } };
  if (!Array.isArray(extensions) || !extensions.every((extension) => typeof extension === 'string' && extension.length > 0)) {
    return { ok: false, detail: `forms.${field}.extensions must be an array of extension path strings` };
  }
  for (const [index, extension] of extensions.entries()) {
    if (extension !== MCP_EXTENSION) {
      return {
        ok: false,
        detail: `forms.${field}.extensions[${index}] "${String(extension)}" is not an extension this build passes: the launch forms pass no "-e" other than "${MCP_EXTENSION}"`,
      };
    }
  }
  return { ok: true, form: { kind: 'confined', path, extensions: [...extensions] } };
}

/**
 * Validate the artefact's shape. Every declared field is type-checked and every
 * unknown key refuses (EX-6): an operator who mistypes a field must not get a
 * policy that silently loses the constraint they meant to declare.
 */
function validatePolicy(value: unknown): PolicyCheck {
  if (!isRecord(value)) return invalid('the policy is not a JSON object');

  // The tag first: a document that does not say it is this schema is not read
  // against it, so no later check reports on a shape it was never written for.
  if (!Object.hasOwn(value, 'schema')) return invalid('missing policy field: schema');
  if (value.schema !== POLICY_SCHEMA) {
    return invalid(`schema ${JSON.stringify(value.schema)} is not one this build reads: expected "${POLICY_SCHEMA}"`);
  }

  for (const field of STATIC_ONLY_FIELDS) {
    if (Object.hasOwn(value, field)) {
      return {
        ok: false,
        reason: 'posture-unsupported',
        detail: `the policy declares the static-only field "${field}"; this build serves the per-call posture only, and a static field is refused rather than dropped`,
      };
    }
  }

  const allowed = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) return invalid(`unknown policy field: ${field}`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(value, field)) return invalid(`missing policy field: ${field}`);
  }

  const mode = value.mode;
  if (typeof mode !== 'string') return invalid('mode must be a string');
  if (mode !== 'per-call') {
    return {
      ok: false,
      reason: 'posture-unsupported',
      detail: `mode "${mode}" is not served by this build: only the per-call posture is built, and a policy is never downgraded to another posture`,
    };
  }

  const roots = value.roots;
  if (!Array.isArray(roots) || !roots.every(isAbsolutePath)) {
    return invalid('roots must be an array of absolute path strings');
  }

  const maxima = value.maxima;
  if (!isRecord(maxima)) return invalid('maxima must be an object');
  for (const field of Object.keys(maxima)) {
    if (!MAXIMA_FIELDS.includes(field)) return invalid(`unknown policy field: maxima.${field}`);
    const limit = maxima[field];
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
      return invalid(`maxima.${field} must be a positive finite number`);
    }
  }
  // A delegate with no ceiling is unbounded spend: every unit is bounded, and the
  // wall clock is the one that holds when the stream reports no usage (design sec-1).
  for (const field of MAXIMA_FIELDS) {
    if (!Object.hasOwn(maxima, field)) return invalid(`missing policy field: maxima.${field}`);
  }

  const profiles = value.profiles;
  if (!isRecord(profiles)) return invalid('profiles must be an object mapping a profile name to "read" or "write"');
  for (const [name, capability] of Object.entries(profiles)) {
    if (!PROFILE_NAME.test(name)) return invalid(`profiles.${name}: "${name}" is not a profile name (${PROFILE_NAME.source})`);
    if (!isFilesystem(capability)) {
      return invalid(`profiles.${name} must be "read" or "write"`);
    }
  }

  const forms = value.forms;
  if (!isRecord(forms)) return invalid('forms must be an object');
  const parsedForms: Forms = {};
  for (const field of Object.keys(forms)) {
    if (!isFilesystem(field)) return invalid(`unknown policy field: forms.${field}`);
    const parsed = readForm(field, forms[field]);
    if (!parsed.ok) return invalid(parsed.detail);
    parsedForms[field] = parsed.form;
  }

  const exposure = value.exposure;
  if (!Array.isArray(exposure) || !exposure.every(isAbsolutePath)) {
    return invalid('exposure must be an array of absolute path strings');
  }

  const enabled = value.enabled;
  if (typeof enabled !== 'boolean') return invalid('enabled must be a boolean');

  const budget = value.transcript_budget_bytes;
  if (budget !== undefined && (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 0)) {
    return invalid('transcript_budget_bytes must be a non-negative integer (0 sets no ceiling)');
  }

  const policy: Policy = {
    schema: POLICY_SCHEMA,
    mode: 'per-call',
    roots: roots as string[],
    maxima: maxima as Maxima,
    profiles: profiles as Record<string, Filesystem>,
    forms: parsedForms,
    exposure: exposure as string[],
    enabled,
  };
  if (budget !== undefined) policy.transcript_budget_bytes = budget as number;
  return { ok: true, policy };
}

/** Step 5's refusal: the capability's wrapper form is not declared. */
export type FormRefusal = 'wrapper-unavailable';

export type FormSelection = { ok: true; form: Form } | { ok: false; reason: FormRefusal; detail: string };

/**
 * Step 5: the profile's filesystem capability selects its wrapper form. In the
 * per-call posture that form is the confinement, so a capability with no form
 * has no way to run and refuses `wrapper-unavailable`.
 *
 * Static mode's `capability-mismatch` is not reachable here and has no branch:
 * step 1 refuses that posture, so this build never has a launch-time capability
 * for a per-call one to disagree with (design sec-2 steps 1, 5).
 */
export function selectForm(policy: Policy, filesystem: Filesystem): FormSelection {
  const form = policy.forms[filesystem];
  if (form === undefined) {
    return {
      ok: false,
      reason: 'wrapper-unavailable',
      detail: `the policy declares no "${filesystem}" wrapper form, and a ${filesystem}-capability profile has no other way to run`,
    };
  }
  return { ok: true, form };
}

/** Step 6's refusal: a ceiling the policy does not permit. */
export type CeilingRefusal = 'ceiling-above-maximum';

export type CeilingResolution =
  | { ok: true; ceilings: Maxima }
  | { ok: false; reason: CeilingRefusal; detail: string };

/**
 * Step 6: clamp the call's ceilings to the policy maxima, downward.
 *
 * A request above a maximum is refused rather than silently clamped: the caller
 * asked for a bound the operator did not grant, and lowering it without saying
 * so would answer a different question than the one asked. At or below the
 * maximum the request stands; an absent request takes the maximum, so a call can
 * never be unbounded while the policy declares a bound. No maximum and no
 * request leaves the unit absent. Enforcement is the gate's (PHASE-07), not
 * this function's.
 */
export function clampCeilings(requested: Maxima | undefined, maxima: Maxima): CeilingResolution {
  const ceilings: Maxima = {};
  for (const unit of MAXIMA_FIELDS as (keyof Maxima)[]) {
    const limit = requested?.[unit];
    const maximum = maxima[unit];
    if (limit === undefined) {
      if (maximum !== undefined) ceilings[unit] = maximum;
      continue;
    }
    if (maximum !== undefined && limit > maximum) {
      return {
        ok: false,
        reason: 'ceiling-above-maximum',
        detail: `${unit}: the requested ceiling ${limit} is above the policy maximum ${maximum}`,
      };
    }
    ceilings[unit] = limit;
  }
  return { ok: true, ceilings };
}

/**
 * The byte budget that reaches the reducer (EX-6). The policy's maximum is
 * authoritative: a call asking for less is clamped down to it, and a call asking
 * for everything (`0`, the reducer's own word for the full transcript) gets the
 * maximum rather than unbounded access past an operator's ceiling. An absent
 * policy maximum leaves the call's value alone, and an absent call value leaves the
 * reducer's own default (returns `undefined`, which `reduce` reads as 8192).
 *
 * This maximum clamps silently where `clampCeilings` refuses an above-maximum
 * request: a transcript budget is a report bound, not a spend bound, so nothing is
 * refused over it.
 */
export function transcriptBudget(requested?: number, policyMax?: number): number | undefined {
  const ceiling = policyMax !== undefined && policyMax > 0 ? policyMax : undefined;
  if (ceiling === undefined) return requested;
  if (requested === undefined) return ceiling;
  if (requested <= 0) return ceiling;
  return Math.min(requested, ceiling);
}

/**
 * Steps 1-2 for one call, in order, first failure wins:
 *
 *   1. the resolved locations (unusable -> `policy-unavailable`) and the
 *      artefact (unreadable -> `policy-unavailable`, unparsable or schema-invalid
 *      -> `policy-invalid`, a mode or static-only field this build does not serve
 *      -> `posture-unsupported`);
 *   2. `enabled` (`disabled`).
 *
 * A refusal is recorded as it is decided: nothing spawned, so `attempts.jsonl`
 * is its sink (design sec-6). The caller's verdict is returned unchanged even
 * when the ledger cannot be written.
 */
export function admitCall(locations: Locations, callId: CallId): Admission {
  const { policyPath, runDir, sessionHome } = locations;
  const refuse = (reason: RefusalReason, detail: string, digest: string | null = null): Admission => {
    appendAttempt(usable(runDir), { callId, reason, detail, policyDigest: digest });
    return { ok: false, reason, detail, digest };
  };

  if (!policyPath.ok) return refuse('policy-unavailable', policyPath.detail);
  if (!runDir.ok) return refuse('policy-unavailable', runDir.detail);
  if (!sessionHome.ok) return refuse('policy-unavailable', sessionHome.detail);

  const loaded = readPolicy(policyPath.path);
  if (!loaded.ok) return refuse(loaded.reason, loaded.detail, loaded.digest);

  // The posture is fixed for the process lifetime (EX-11), and the mechanism is
  // the schema, not process state: every call re-reads and re-validates the
  // artefact, and `validatePolicy` refuses any `mode` other than `per-call` with
  // `posture-unsupported`, so a file edited mid-life to name another mode is
  // refused at the next call and no path re-launches into one. (A remembered
  // mode would add nothing: the one value it could hold is the one the schema
  // already enforces.)

  if (!loaded.policy.enabled) {
    return refuse('disabled', 'the operator has disabled pi_agent (enabled = false)', loaded.digest);
  }

  return {
    ok: true,
    policy: loaded.policy,
    digest: loaded.digest,
    policyPath: policyPath.path,
    runDir: runDir.path,
    sessionHome: sessionHome.path,
  };
}
