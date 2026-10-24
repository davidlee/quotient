// Where everything is (design sec-3). One pure resolver over the environment, so
// the policy, profile and help layers share one idea of XDG.
//
// Split by authority: the policy is never looked up in the project tree;
// profiles and help come from XDG only (a launch-dir layer is a legacy install
// that fails start-up, named by `legacyLayers`); state defaults to XDG.
// Only an unset QUOTIENT_* variable falls through — a set but empty or relative
// value is unusable, so a typo never silently moves the policy. An unusable
// location is the caller's `policy-unavailable`.
import { isAbsolute, join, normalize } from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

export type Resolved = { ok: true; path: string } | { ok: false; detail: string };

export type Locations = {
  policyPath: Resolved;
  runDir: Resolved;
  sessionHome: Resolved;
  /** [<xdgConfig>/quotient/profiles]; empty when the XDG config base is unusable. */
  profileLayers: string[];
  /** [<xdgConfig>/quotient/help]; empty when the XDG config base is unusable. */
  helpLayers: string[];
  /** The path a wrapper was run as, for the client snippets; null when unset or
   *  not absolute. A hint, not a location the server reads, so it never refuses. */
  launcher: string | null;
};

export const POLICY_VAR = 'QUOTIENT_POLICY';
export const RUN_DIR_VAR = 'QUOTIENT_RUN_DIR';
export const SESSION_HOME_VAR = 'QUOTIENT_SESSION_HOME';
export const LAUNCHER_VAR = 'QUOTIENT_LAUNCHER';

/** A resolved path, or null when unusable: the shape the evidence writers take. */
export const usable = (resolved: Resolved): string | null => (resolved.ok ? resolved.path : null);

const absolute = (value: string | undefined): string | null =>
  value !== undefined && value.length > 0 && isAbsolute(value) ? value : null;

/** An XDG base: `$<name>` when absolute (a relative one is ignored), else `$HOME/<fallback>`. */
function xdgBase(env: Env, name: string, fallback: string): Resolved {
  const set = absolute(env[name]);
  if (set !== null) {return { ok: true, path: set };}
  const home = absolute(env.HOME);
  if (home !== null) {return { ok: true, path: join(home, fallback) };}
  return { ok: false, detail: `neither ${name} nor HOME is an absolute path` };
}

/** The variable when set, else the default under an XDG base. */
function located(env: Env, name: string, base: Resolved, under: string): Resolved {
  const value = env[name];
  if (value !== undefined) {
    if (value.length === 0) {return { ok: false, detail: `${name} is set but empty` };}
    return isAbsolute(value) ? { ok: true, path: value } : { ok: false, detail: `${name} is set but not an absolute path` };
  }
  if (!base.ok) {return { ok: false, detail: `${name} is unset and ${base.detail}` };}
  return { ok: true, path: join(base.path, under) };
}

const launcherPath = (env: Env): string | null => {
  const value = absolute(env[LAUNCHER_VAR]);
  return value === null ? null : normalize(value);
};

/** The one layer of each kind: the XDG config home's, when it resolves. */
const xdgLayer = (config: Resolved, kind: string): string[] =>
  config.ok ? [join(config.path, 'quotient', kind)] : [];

/**
 * The launch-dir layers earlier versions read, highest first. Their presence
 * fails start-up with migration guidance (DEC-011): the paths are derived, not
 * looked up, and whether they exist is the start-up check's question.
 */
export function legacyLayers(launchDir: string): string[] {
  return ['profiles', 'help'].map((kind) => join(launchDir, '.quotient', kind));
}

export function resolveLocations(env: Env): Locations {
  const config = xdgBase(env, 'XDG_CONFIG_HOME', '.config');
  const state = xdgBase(env, 'XDG_STATE_HOME', '.local/state');
  return {
    policyPath: located(env, POLICY_VAR, config, 'quotient/policy.json'),
    runDir: located(env, RUN_DIR_VAR, state, 'quotient/runs'),
    sessionHome: located(env, SESSION_HOME_VAR, state, 'quotient/sessions'),
    profileLayers: xdgLayer(config, 'profiles'),
    helpLayers: xdgLayer(config, 'help'),
    launcher: launcherPath(env),
  };
}
