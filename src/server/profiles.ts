// Profiles as live authority (design sec-2 steps 3-4, sec-3 "Profiles are live
// authority"), the call's root allowlist (sec-2 step 4) and the call's `tools`
// narrowing (DEC-103).
//
// The tracked documents under `pi/mcp/profiles/` are read ONCE, at start-up,
// into a snapshot the server holds for its whole lifetime. A profile edited on
// disk is therefore inert until a restart, which is a deployment act: that is
// what stops a write-capable delegate rewriting a `read` profile into a `write`
// one and elevating a later call with neither a policy change nor a deployment
// (RV-046 F-5). Nothing here reads the directory per call, and nothing joins the
// caller's `profile` string into a path — the name is a snapshot key, never a
// path component.
//
// Document format. A profile document is markdown whose first non-empty line
// opens an HTML-comment header, followed by one `key: value` line per field, and
// then a line holding just the comment terminator:
//
//     <!-- pi-mcp-profile
//     filesystem: read
//     model: llm-gateway/deepseek-flash
//     thinking: off
//     tools: read, grep, find, ls, bash
//     -->
//
// Three fields are required — `filesystem` (`read` or `write`), `model` (one
// non-empty token) and `tools` (a comma-separated list of tool names) — and one
// is optional: `thinking`, one of `off`, `minimal`, `low`, `medium`, `high`,
// `xhigh` or `max` (THINKING_LEVELS). Each field is declared once, with a
// non-empty value after a space or tab; there is no blank line inside the header
// and no other key. `thinking` is the one place a level is set: a `model` ending
// in pi's `:<level>` shorthand refuses, and an omitted `thinking` leaves the
// child on its own default. The profile's name is the file's base name and
// must match PROFILE_NAME. That is a strict grammar `split` and one regular
// expression can parse, so the loader needs no YAML or markdown dependency.
// Everything after the header is prose for a human and is not parsed.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { canonicalPath, within } from './paths.ts';

/** The profile-name grammar (design sec-2 step 3): 1-32 characters, lower-case. */
export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The one extension a launch form may re-enable (design sec-3, executable contract). */
export const MCP_EXTENSION = 'builtin:mcp';

/** The tool-name prefix the MCP built-in extension registers. */
export const MCP_TOOL_PREFIX = 'mcp__';

/** A tracked profile document's suffix; the base name is the profile name. */
export const PROFILE_SUFFIX = '.md';

/** The filesystem capability a profile grants (design sec-1's capability column). */
export type Filesystem = 'read' | 'write';

/** pi's `--thinking` levels: the optional header field's vocabulary. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** One of pi's thinking levels. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const isThinkingLevel = (value: string): value is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(value);

/** One validated profile document, frozen into a snapshot. */
export type Profile = {
  readonly name: string;
  /** The absolute path of the document this entry was read from. */
  readonly path: string;
  readonly filesystem: Filesystem;
  readonly model: string;
  /** The child's `--thinking` level; absent when the header omits it. */
  readonly thinking?: ThinkingLevel;
  readonly tools: readonly string[];
};

/** One read of the profile directory, held for the process lifetime. */
export type Snapshot = {
  readonly dir: string;
  readonly profiles: ReadonlyMap<string, Profile>;
  /**
   * sha256 over the directory's documents: for each document in ascending name
   * order, its file name, a NUL, its bytes, and a NUL. Recorded in every run's
   * audit spawn record (PHASE-06), so a run names the snapshot it ran under.
   */
  readonly digest: string;
};

/**
 * The directory a path failed in, and why. The caller answers `profile-invalid`
 * with this path: a snapshot that does not validate refuses at start-up rather
 * than being discovered per call (EX-2).
 */
export type SnapshotLoad = { ok: true; snapshot: Snapshot } | { ok: false; path: string; detail: string };

const HEADER_OPEN = '<!-- pi-mcp-profile';
const HEADER_CLOSE = '-->';
const REQUIRED_HEADER_FIELDS = ['filesystem', 'model', 'tools'];
const HEADER_FIELDS = [...REQUIRED_HEADER_FIELDS, 'thinking'];
const HEADER_LINE = /^([a-z][a-z0-9_]*):([ \t].*)?$/;
const MODEL = /^\S+$/;
const TOOL_NAME = /^[a-z][a-z0-9_-]*$/;

const errorCode = (error: unknown): string =>
  error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'unknown error';

/**
 * Parse one document's header. Every failure names the file and, where there is
 * one, the line: a start-up refusal an operator cannot locate is not a refusal
 * they can act on.
 */
function parseDocument(
  name: string,
  path: string,
  text: string,
): { ok: true; profile: Profile } | { ok: false; detail: string } {
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const open = lines.findIndex((line) => line.trim().length > 0);
  if (open < 0 || lines[open].trim() !== HEADER_OPEN) {
    return { ok: false, detail: `${path}: the document must open with "${HEADER_OPEN}"` };
  }
  const close = lines.findIndex((line, index) => index > open && line.trim() === HEADER_CLOSE);
  if (close < 0) {
    return { ok: false, detail: `${path}: the header opened on line ${open + 1} and never closes with "${HEADER_CLOSE}"` };
  }

  const fields = new Map<string, string>();
  for (let index = open + 1; index < close; index += 1) {
    const match = HEADER_LINE.exec(lines[index]);
    if (match === null) {
      return {
        ok: false,
        detail: `${path}:${index + 1}: the header holds one "key: value" per line, and this line is neither`,
      };
    }
    const [, key, raw = ''] = match;
    const value = raw.trim();
    if (value.length === 0) {
      return { ok: false, detail: `${path}:${index + 1}: the header field "${key}" has no value` };
    }
    if (!HEADER_FIELDS.includes(key)) {
      return { ok: false, detail: `${path}:${index + 1}: unknown header field "${key}"` };
    }
    if (fields.has(key)) {
      return { ok: false, detail: `${path}:${index + 1}: the header field "${key}" is declared twice` };
    }
    fields.set(key, value);
  }
  for (const key of REQUIRED_HEADER_FIELDS) {
    if (!fields.has(key)) return { ok: false, detail: `${path}: the header is missing "${key}"` };
  }

  const filesystem = fields.get('filesystem');
  if (filesystem !== 'read' && filesystem !== 'write') {
    return { ok: false, detail: `${path}: filesystem must be "read" or "write", not "${filesystem}"` };
  }
  const model = fields.get('model') ?? '';
  if (!MODEL.test(model)) return { ok: false, detail: `${path}: model must be one non-empty token` };
  const suffix = model.slice(model.lastIndexOf(':') + 1);
  if (model.includes(':') && isThinkingLevel(suffix)) {
    return {
      ok: false,
      detail: `${path}: model "${model}" carries the level ":${suffix}"; set it with the thinking field instead`,
    };
  }

  let thinking: ThinkingLevel | undefined;
  const declaredThinking = fields.get('thinking');
  if (declaredThinking !== undefined) {
    if (!isThinkingLevel(declaredThinking)) {
      const valid = THINKING_LEVELS.map((candidate) => `"${candidate}"`).join(', ');
      return { ok: false, detail: `${path}: thinking must be one of ${valid}, not "${declaredThinking}"` };
    }
    thinking = declaredThinking;
  }

  const tools: string[] = [];
  for (const part of (fields.get('tools') ?? '').split(',')) {
    const tool = part.trim();
    if (!TOOL_NAME.test(tool)) {
      return { ok: false, detail: `${path}: "${tool}" is not a tool name (${TOOL_NAME.source})` };
    }
    if (tools.includes(tool)) return { ok: false, detail: `${path}: the tool "${tool}" is listed twice` };
    tools.push(tool);
  }

  // An omitted `thinking` adds no key at all: a profile's shape stays exactly the
  // fields its document declared.
  return {
    ok: true,
    profile: Object.freeze({
      name,
      path,
      filesystem,
      model,
      tools: Object.freeze(tools),
      ...(thinking === undefined ? {} : { thinking }),
    }),
  };
}

/**
 * Read and validate the profile directory once. Documents are the directory's
 * `*.md` files, in ascending name order, which is also the digest order: the
 * snapshot is a function of the directory's contents and nothing else, so two
 * checkouts of the same documents share one digest.
 */
export function loadProfiles(dir: string): SnapshotLoad {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return { ok: false, path: dir, detail: `${dir} could not be read (${errorCode(error)})` };
  }

  const documents = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(PROFILE_SUFFIX))
    .map((entry) => entry.name)
    .sort();

  const profiles = new Map<string, Profile>();
  const digest = createHash('sha256');
  for (const document of documents) {
    const path = join(dir, document);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      return { ok: false, path, detail: `${path} could not be read (${errorCode(error)})` };
    }
    digest.update(document);
    digest.update('\0');
    digest.update(bytes);
    digest.update('\0');

    const name = document.slice(0, -PROFILE_SUFFIX.length);
    if (!PROFILE_NAME.test(name)) {
      return { ok: false, path, detail: `${path}: "${name}" is not a profile name (${PROFILE_NAME.source})` };
    }
    const parsed = parseDocument(name, path, bytes.toString('utf8'));
    if (!parsed.ok) return { ok: false, path, detail: parsed.detail };
    profiles.set(name, parsed.profile);
  }

  // The entries are frozen at construction; the map is never written again, and
  // every accessor below hands back a copy rather than the stored object.
  return { ok: true, snapshot: Object.freeze({ dir, profiles, digest: digest.digest('hex') }) };
}

/** The three profile refusals, in the order step 3 decides them. */
export type ProfileRefusal = 'profile-invalid' | 'profile-unknown' | 'profile-not-allowed';

export type ProfileResolution =
  | { ok: true; profile: Profile }
  | { ok: false; reason: ProfileRefusal; detail: string };

/**
 * Step 3: resolve a caller's `profile` from the snapshot only, first failure
 * wins — the grammar, then the snapshot, then the policy's allowlist. The name
 * is never joined into a path, and the snapshot is never re-read.
 */
export function resolveProfile(
  snapshot: Snapshot,
  name: string,
  allowed: readonly string[],
): ProfileResolution {
  if (!PROFILE_NAME.test(name)) {
    return {
      ok: false,
      reason: 'profile-invalid',
      detail: `profile "${name}" does not match the profile grammar ${PROFILE_NAME.source}`,
    };
  }
  const found = snapshot.profiles.get(name);
  if (found === undefined) {
    return {
      ok: false,
      reason: 'profile-unknown',
      detail: `profile "${name}" is not in the start-up snapshot of ${snapshot.dir}`,
    };
  }
  if (!allowed.includes(name)) {
    return {
      ok: false,
      reason: 'profile-not-allowed',
      detail: `profile "${name}" is not listed in the policy's profiles (${allowed.join(', ') || 'none'})`,
    };
  }
  return {
    ok: true,
    profile: {
      name: found.name,
      path: found.path,
      filesystem: found.filesystem,
      model: found.model,
      tools: [...found.tools],
      ...(found.thinking === undefined ? {} : { thinking: found.thinking }),
    },
  };
}

/** The three root refusals step 4 can produce. */
export type RootRefusal = 'root-missing' | 'root-not-a-directory' | 'root-not-allowlisted';

export type RootResolution = { ok: true; root: string } | { ok: false; reason: RootRefusal; detail: string };

/**
 * Step 4: canonicalise the call's root and allowlist it by path components.
 *
 * An absent `cwd` is the server's launch directory, put through the same
 * allowlist with no exemption — an operator who has not allowlisted it gets
 * `root-not-allowlisted`, because the root decision belongs to the policy. A
 * relative `cwd` resolves against the launch directory for the same reason: the
 * server never guesses from the caller's notion of a working directory.
 */
export function resolveRoot(
  requested: string | undefined,
  launchDir: string,
  allowedRoots: readonly string[],
): RootResolution {
  const candidate =
    requested === undefined ? launchDir : isAbsolute(requested) ? requested : resolve(launchDir, requested);

  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch (error) {
    if (errorCode(error) === 'ENOTDIR') {
      return { ok: false, reason: 'root-not-a-directory', detail: `${candidate} is not a directory` };
    }
    return { ok: false, reason: 'root-missing', detail: `${candidate} does not exist (${errorCode(error)})` };
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(canonical);
  } catch (error) {
    return { ok: false, reason: 'root-missing', detail: `${canonical} does not exist (${errorCode(error)})` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, reason: 'root-not-a-directory', detail: `${canonical} is not a directory` };
  }

  // The same predicate the child-view check uses (DEC-095): `canonical` is already
  // a realpath, so the comparison is against the allowlisted root's canonical form.
  // `/work/oneevil` is not inside `/work/one`, however much of it the string shares,
  // and a root that does not exist canonicalises to a path that matches nothing.
  for (const allowedRoot of allowedRoots) {
    if (within(canonicalPath(allowedRoot), canonical)) {
      return { ok: true, root: canonical };
    }
  }
  return {
    ok: false,
    reason: 'root-not-allowlisted',
    detail: `${canonical} is not inside an allowlisted root (${allowedRoots.join(', ') || 'none'})`,
  };
}

/** DEC-103's token: the call asked for a tool the profile does not grant. */
export type ToolsRefusal = 'tools-not-allowed';

export type ToolsResolution = { ok: true; tools: string[] } | { ok: false; reason: ToolsRefusal; detail: string };

/**
 * The call's `tools` may only narrow (DEC-103). The effective set is the
 * intersection with the profile's snapshotted set, in the profile's order; a
 * request naming a tool outside it is refused rather than silently intersected,
 * because a caller that asked for authority it does not have should be told.
 */
export function effectiveTools(profile: Profile, requested: readonly string[] | undefined): ToolsResolution {
  if (requested === undefined) return { ok: true, tools: [...profile.tools] };
  const granted = new Set(profile.tools);
  for (const tool of requested) {
    if (!granted.has(tool)) {
      return {
        ok: false,
        reason: 'tools-not-allowed',
        detail: `tool "${tool}" is not in profile "${profile.name}"'s tool set (${profile.tools.join(', ')})`,
      };
    }
  }
  return { ok: true, tools: profile.tools.filter((tool) => requested.includes(tool)) };
}

/**
 * The `--tools` argument: the whole narrowed list, comma-joined. pi's flag
 * *replaces* the selection rather than adding to it, so a subset here would
 * silently drop the tools the caller did not name.
 */
export function toolsArgument(tools: readonly string[]): string {
  return tools.join(',');
}

export type ExtensionResolution = { ok: true } | { ok: false; reason: 'profile-invalid'; detail: string };

/**
 * Design sec-3's executable contract: `--no-extensions` disables the built-in
 * `builtin:mcp`, so a profile that names an `mcp__*` tool needs the launch form
 * to pass `-e builtin:mcp`. A profile asking for tools it can never receive is
 * `profile-invalid`, not a run that silently lacks them.
 *
 * This is decided after the form is selected (step 5), because the form's
 * declared extensions are what it is compared against.
 */
export function checkProfileExtensions(profile: Profile, extensions: readonly string[]): ExtensionResolution {
  if (!profile.tools.some((tool) => tool.startsWith(MCP_TOOL_PREFIX))) return { ok: true };
  if (extensions.includes(MCP_EXTENSION)) return { ok: true };
  return {
    ok: false,
    reason: 'profile-invalid',
    detail: `${profile.path} names an ${MCP_TOOL_PREFIX}* tool while the "${profile.filesystem}" form passes no "-e ${MCP_EXTENSION}": the profile would ask for tools it can never receive`,
  };
}
