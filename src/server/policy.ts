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
import { appendAttempt, sha256Hex } from './evidence.ts';
import type { CallId } from './evidence.ts';

export const POLICY_VAR = 'PI_MCP_POLICY';
export const RUN_DIR_VAR = 'PI_MCP_RUN_DIR';
export const SESSION_HOME_VAR = 'PI_MCP_SESSION_HOME';

/** The only posture this build serves (design sec-1). */
export type PolicyMode = 'per-call';

export type Maxima = {
  requests?: number;
  tokens?: number;
  cost_usd?: number;
  wall_clock_s?: number;
};

/** The per-call wrapper forms, one per filesystem capability. Each is an
 *  absolute path to a flake-provided launcher; the server names no jail flag. */
export type Forms = { read?: string; write?: string };

export type Policy = {
  mode: PolicyMode;
  /** Canonicalisable roots a call may name (consumed by PHASE-03). */
  roots: string[];
  maxima: Maxima;
  /** Profile names the policy allows (consumed by PHASE-03). */
  profiles: string[];
  forms: Forms;
  /** Fixed child binds the wrapped form adds (consumed by PHASE-05). */
  child_binds: string[];
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

/** The posture the process serves, fixed by the first call it admits (EX-11). */
export type PostureState = { acceptedMode: PolicyMode | null };

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

export function createPostureState(): PostureState {
  return { acceptedMode: null };
}

/** An absolute launch-env value, or null when unset, empty or relative. */
function absoluteVar(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) return null;
  return value;
}

/**
 * Where evidence would go, when the operator set a usable run dir. Used by the
 * request-boundary refusal, which precedes the environment check, so a broken
 * request can still be recorded when the evidence path itself is sound.
 */
export function knownRunDir(env: Record<string, string | undefined>): string | null {
  return absoluteVar(env, RUN_DIR_VAR);
}

const REQUIRED_FIELDS = ['mode', 'roots', 'maxima', 'profiles', 'forms', 'child_binds', 'enabled'];
const OPTIONAL_FIELDS = ['transcript_budget_bytes'];
/**
 * Fields only the static posture declares. Their presence is a posture refusal,
 * not a schema one: this build must not drop them and pretend the policy asked
 * for what it serves (design sec-1, EX-4).
 */
const STATIC_ONLY_FIELDS = ['agent', 'root', 'filesystem', 'session_home', 'run_dir', 'evidence_dir'];
const MAXIMA_FIELDS = ['requests', 'tokens', 'cost_usd', 'wall_clock_s'];
const FORM_FIELDS = ['read', 'write'];

type PolicyCheck = { ok: true; policy: Policy } | { ok: false; reason: RefusalReason; detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAbsolutePath = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value);

const invalid = (detail: string): PolicyCheck => ({ ok: false, reason: 'policy-invalid', detail });

/**
 * Read, parse and validate the artefact. The digest is present whenever the
 * bytes were readable — an unparsable file still has an identity worth recording
 * (EX-3).
 */
function readPolicy(policyPath: string): { ok: true; policy: Policy; digest: string } | { ok: false; reason: RefusalReason; detail: string; digest: string | null } {
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
 * Validate the artefact's shape. Every declared field is type-checked and every
 * unknown key refuses (EX-6): an operator who mistypes a field must not get a
 * policy that silently loses the constraint they meant to declare.
 */
function validatePolicy(value: unknown): PolicyCheck {
  if (!isRecord(value)) return invalid('the policy is not a JSON object');

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
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
      return invalid(`maxima.${field} must be a finite number`);
    }
  }

  const profiles = value.profiles;
  if (!Array.isArray(profiles) || !profiles.every((name) => typeof name === 'string')) {
    return invalid('profiles must be an array of profile names');
  }

  const forms = value.forms;
  if (!isRecord(forms)) return invalid('forms must be an object');
  for (const field of Object.keys(forms)) {
    if (!FORM_FIELDS.includes(field)) return invalid(`unknown policy field: forms.${field}`);
    if (!isAbsolutePath(forms[field])) return invalid(`forms.${field} must be an absolute path string`);
  }

  const childBinds = value.child_binds;
  if (!Array.isArray(childBinds) || !childBinds.every(isAbsolutePath)) {
    return invalid('child_binds must be an array of absolute path strings');
  }

  const enabled = value.enabled;
  if (typeof enabled !== 'boolean') return invalid('enabled must be a boolean');

  const budget = value.transcript_budget_bytes;
  if (budget !== undefined && (typeof budget !== 'number' || !Number.isInteger(budget))) {
    return invalid('transcript_budget_bytes must be an integer');
  }

  const policy: Policy = {
    mode: 'per-call',
    roots: roots as string[],
    maxima: maxima as Maxima,
    profiles: profiles as string[],
    forms: forms as Forms,
    child_binds: childBinds as string[],
    enabled,
  };
  if (budget !== undefined) policy.transcript_budget_bytes = budget as number;
  return { ok: true, policy };
}

/**
 * Steps 1-2 for one call, in order, first failure wins:
 *
 *   1. the launch environment (absent/relative -> `policy-unavailable`), the
 *      artefact (unreadable -> `policy-unavailable`, unparsable or schema-invalid
 *      -> `policy-invalid`) and the posture (`posture-unsupported`);
 *   2. `enabled` (`disabled`).
 *
 * A refusal is recorded as it is decided: nothing spawned, so `attempts.jsonl`
 * is its sink (design sec-6). The caller's verdict is returned unchanged even
 * when the ledger cannot be written.
 */
export function admitCall(
  env: Record<string, string | undefined>,
  posture: PostureState,
  callId: CallId,
): Admission {
  const runDir = knownRunDir(env);
  const refuse = (reason: RefusalReason, detail: string, digest: string | null = null): Admission => {
    appendAttempt(runDir, { callId, reason, detail, policyDigest: digest });
    return { ok: false, reason, detail, digest };
  };

  const policyPath = absoluteVar(env, POLICY_VAR);
  if (policyPath === null) {
    return refuse('policy-unavailable', `${POLICY_VAR} is unset or not an absolute path`);
  }
  if (runDir === null) {
    return refuse('policy-unavailable', `${RUN_DIR_VAR} is unset or not an absolute path`);
  }
  const sessionHome = absoluteVar(env, SESSION_HOME_VAR);
  if (sessionHome === null) {
    return refuse('policy-unavailable', `${SESSION_HOME_VAR} is unset or not an absolute path`);
  }

  const loaded = readPolicy(policyPath);
  if (!loaded.ok) return refuse(loaded.reason, loaded.detail, loaded.digest);

  // The posture is fixed for the process lifetime (EX-11): a file edited to name
  // another mode is refused at the next call, and no path re-launches into it.
  if (posture.acceptedMode !== null && loaded.policy.mode !== posture.acceptedMode) {
    return refuse(
      'posture-unsupported',
      `mode changed from "${posture.acceptedMode}" to "${loaded.policy.mode}" while the server was running; the posture is fixed for the process lifetime`,
      loaded.digest,
    );
  }

  if (!loaded.policy.enabled) {
    return refuse('disabled', 'the operator has disabled pi_agent (enabled = false)', loaded.digest);
  }

  posture.acceptedMode = loaded.policy.mode;
  return {
    ok: true,
    policy: loaded.policy,
    digest: loaded.digest,
    policyPath,
    runDir,
    sessionHome,
  };
}
