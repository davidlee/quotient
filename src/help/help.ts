// The built-in help (design sec-2): one sectioned source that serves the human
// (`quotient help`) and the model (the MCP `initialize` instructions and the
// `pi_agent` tool description).
//
// Each overridable section resolves per section: the launch dir's
// `.quotient/help/<section>.md`, then `<xdgConfig>/quotient/help/<section>.md`,
// then the built-in. Contract sections skip both layers: they print
// `docs/contract` verbatim, because an override would let help misstate the
// normative text. Only an absent file falls through, as for profiles: an
// unreadable layer or section file, shadowed or not, refuses start-up.
//
// The layers are read once, at start-up, into a snapshot. Rendering is pure: a
// rendered section takes the profiles, the policy and the bin from its caller.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../root.ts';
import { readPolicy } from '../server/policy.ts';
import { absent, errorCode } from '../server/paths.ts';
import type { Filesystem, Profile } from '../server/profiles.ts';
import type { Resolved } from '../config.ts';
import { USAGE as REDUCE_USAGE } from '../reduce/cli.ts';

export const HELP_SECTIONS = ['agent', 'tool', 'result', 'policy', 'form', 'profiles', 'setup', 'clients', 'reduce'] as const;

export type Section = (typeof HELP_SECTIONS)[number];

const ALIASES: Readonly<Record<string, Section>> = { refusals: 'result' };

/** Where a section's built-in text comes from: a help file, a contract (no
 *  override), or a renderer over the caller's context. */
type Source = { kind: 'file'; path: string } | { kind: 'contract'; path: string } | { kind: 'rendered' };

const SOURCES: Readonly<Record<Section, Source>> = {
  agent: { kind: 'file', path: 'help/agent.md' },
  tool: { kind: 'file', path: 'help/tool.md' },
  result: { kind: 'contract', path: 'docs/contract/pi-agent-result-1.md' },
  policy: { kind: 'contract', path: 'docs/contract/quotient-policy-1.md' },
  form: { kind: 'contract', path: 'docs/contract/form-1.md' },
  profiles: { kind: 'file', path: 'help/profiles.md' },
  setup: { kind: 'file', path: 'help/setup.md' },
  clients: { kind: 'rendered' },
  reduce: { kind: 'rendered' },
};

const SUFFIX = '.md';

/** A section by its name or alias; null for neither. */
export function sectionName(name: string): Section | null {
  if ((HELP_SECTIONS as readonly string[]).includes(name)) return name as Section;
  return ALIASES[name] ?? null;
}

/** One read of the help layers, held for the process lifetime. */
export type HelpSnapshot = {
  /** Each section's text as read; null for a rendered section no layer overrides. */
  readonly texts: ReadonlyMap<Section, string | null>;
  /** Each section's source: a path, or `builtin:<section>` for a rendered one. */
  readonly sources: ReadonlyMap<Section, string>;
  /** sha256 over `section \0 source \0 bytes \0` in section order. On every run's
   *  `spawn` record as `help_digest`. Audit-only. */
  readonly digest: string;
};

export type HelpLoad = { ok: true; snapshot: HelpSnapshot } | { ok: false; path: string; detail: string };

type Failure = { ok: false; path: string; detail: string };

const unreadable = (path: string, error: unknown): Failure => ({
  ok: false,
  path,
  detail: `${path} could not be read (${errorCode(error)})`,
});

/** The section files one layer holds; a missing layer holds none. */
function layerSections(layer: string): { ok: true; sections: Set<string> } | Failure {
  try {
    return { ok: true, sections: new Set(readdirSync(layer).filter((name) => name.endsWith(SUFFIX))) };
  } catch (error) {
    if (absent(layer, error)) return { ok: true, sections: new Set() };
    return unreadable(layer, error);
  }
}

function readText(path: string): { ok: true; text: string } | Failure {
  try {
    return { ok: true, text: readFileSync(path, 'utf8') };
  } catch (error) {
    return unreadable(path, error);
  }
}

/**
 * Read every layer once, highest first, then the built-ins. Every section file
 * a layer holds is read, whether or not a higher layer shadows it: a broken
 * file is a deployment fault whether or not it wins today. A built-in that
 * cannot be read is a broken package and refuses the same way.
 */
export function loadHelp(layers: readonly string[], root: string = packageRoot): HelpLoad {
  const overrides = new Map<Section, { source: string; text: string }>();
  for (const layer of layers) {
    const listed = layerSections(layer);
    if (!listed.ok) return listed;
    for (const section of HELP_SECTIONS) {
      if (SOURCES[section].kind === 'contract' || !listed.sections.has(`${section}${SUFFIX}`)) continue;
      const path = join(layer, `${section}${SUFFIX}`);
      const read = readText(path);
      if (!read.ok) return read;
      if (!overrides.has(section)) overrides.set(section, { source: path, text: read.text });
    }
  }

  const texts = new Map<Section, string | null>();
  const sources = new Map<Section, string>();
  const digest = createHash('sha256');
  for (const section of HELP_SECTIONS) {
    const source = SOURCES[section];
    let chosen = overrides.get(section) ?? null;
    if (chosen === null && source.kind !== 'rendered') {
      const path = join(root, source.path);
      const read = readText(path);
      if (!read.ok) return read;
      chosen = { source: path, text: read.text };
    }
    const sourcePath = chosen?.source ?? `builtin:${section}`;
    texts.set(section, chosen?.text ?? null);
    sources.set(section, sourcePath);
    for (const part of [section, sourcePath, chosen?.text ?? '']) {
      digest.update(part);
      digest.update('\0');
    }
  }
  return { ok: true, snapshot: Object.freeze({ texts, sources, digest: digest.digest('hex') }) };
}

/** What the rendered parts read from the policy: the pins and the wall clock,
 *  or why the policy could not be read. */
export type PolicyView =
  | { ok: true; profiles: Readonly<Record<string, Filesystem>>; wallClockS: number }
  | { ok: false; detail: string };

/** The policy as the rendered sections see it, read now. */
export function policyView(policyPath: Resolved): PolicyView {
  if (!policyPath.ok) return { ok: false, detail: policyPath.detail };
  const loaded = readPolicy(policyPath.path);
  if (!loaded.ok) return { ok: false, detail: loaded.detail };
  return { ok: true, profiles: loaded.policy.profiles, wallClockS: loaded.policy.maxima.wall_clock_s };
}

/** The inputs of the rendered sections. */
export type RenderContext = {
  profiles: readonly Profile[];
  policy: PolicyView;
  /** The absolute path of the running bin. */
  bin: string;
  /** Where the server is launched: where `./.quotient` is found. */
  launchDir: string;
};

const cell = (text: string): string => text.replaceAll('|', '\\|');

/** The snapshot's profiles with the capability the policy pins, as read now. */
export function profileTable(profiles: readonly Profile[], policy: PolicyView): string {
  const heading = '## Profiles\n\n';
  if (profiles.length === 0) return `${heading}This server has no profiles: every call refuses.\n`;
  const pinned = (name: string): string => {
    if (!policy.ok) return 'unknown (policy unavailable)';
    return policy.profiles[name] ?? 'not listed: every call refuses';
  };
  const rows = profiles.map((profile) =>
    [
      `\`${profile.name}\``,
      cell(profile.model),
      profile.thinking ?? 'default',
      cell(profile.tools.join(', ')),
      cell(profile.source),
      pinned(profile.name),
    ].join(' | '),
  );
  return [
    heading,
    'The capability column is the policy as read when this text was rendered; the pin is re-checked on every call.\n\n',
    '| profile | model | thinking | tools | source | capability |\n',
    '|---|---|---|---|---|---|\n',
    ...rows.map((row) => `| ${row} |\n`),
  ].join('');
}

/** The margin over `maxima.wall_clock_s` for spawn, the kill ladder, reduction
 *  and evidence writes (design sec-5). */
const TIMEOUT_MARGIN_S = 60;
const PLACEHOLDER_TIMEOUT_S = 360;

/** The Claude Code and Codex snippets for the running bin. */
export function clientsSnippets(context: RenderContext): string {
  const bin = JSON.stringify(context.bin);
  const timeout = context.policy.ok
    ? `tool_timeout_sec = ${context.policy.wallClockS + TIMEOUT_MARGIN_S}     # policy maxima.wall_clock_s + ${TIMEOUT_MARGIN_S}`
    : `tool_timeout_sec = ${PLACEHOLDER_TIMEOUT_S}     # placeholder: no readable policy (${context.policy.detail}); set maxima.wall_clock_s + ${TIMEOUT_MARGIN_S}`;
  return `# Clients

Claude Code (\`.mcp.json\` in the project, or \`claude mcp add-json quotient '<json>'\`):

\`\`\`json
${JSON.stringify({ mcpServers: { quotient: { command: context.bin } } }, null, 2)}
\`\`\`

Codex (\`~/.codex/config.toml\`). Its default tool timeout is 60 s, which a
delegate run outlasts, so the timeout is part of the setup:

\`\`\`toml
[mcp_servers.quotient]
command = ${bin}
cwd = ${JSON.stringify(context.launchDir)}
${timeout}
\`\`\`

\`cwd\` is the launch dir: where \`./.quotient\` is found.
`;
}

/** One section's text: the snapshot's, with the rendered parts filled in. */
export function sectionText(snapshot: HelpSnapshot, section: Section, context: RenderContext): string {
  const text = snapshot.texts.get(section) ?? null;
  switch (section) {
    case 'agent':
      return `${text}\n${profileTable(context.profiles, context.policy)}`;
    case 'clients':
      return text ?? clientsSnippets(context);
    case 'reduce':
      return text ?? `${REDUCE_USAGE}\n`;
    default:
      return text as string;
  }
}
