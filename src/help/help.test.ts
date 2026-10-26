// Tests for the built-in help (design sec-2 "Help sections", "Overrides and
// snapshot", sec-5 "Clients"): one sectioned source, two override layers over
// the built-in, contract sections printed verbatim, a start-up snapshot with
// its digest, the rendered profile table and the two client snippets.
//
// Hermetic: every test mints its own temp tree for the override layers; the
// built-in layer is the package's own `help/` and `docs/contract/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packageRoot } from '../root.ts';
import { resolveLocations } from '../config.ts';
import { PROFILE_NAME, THINKING_LEVELS, loadProfiles } from '../server/profiles.ts';
import {
  callLine,
  converse,
  jsonLines,
  line,
  onlyRunDir,
  profileDocument,
  spawnRecord,
  validPolicy,
  workspace,
  writeProfiles,
  xdgHelpLayer,
  xdgProfileLayer,
  type Env,
} from '../server/test-rig.ts';
import { TOOLS } from '../server/tools.ts';
import { HELP_SECTIONS, clientsSnippets, loadHelp, maximaTable, policyView, profileTable, sectionName, sectionText, type HelpSnapshot, type RenderContext } from './help.ts';

/** Two empty override layers, higher first: the loader still takes a list, though
 *  production supplies only the XDG one. */
function layers(): { over: string; under: string; all: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'quotient-help-'));
  const over = join(dir, 'over');
  const under = join(dir, 'under');
  return { over, under, all: [over, under] };
}

function write(layer: string, section: string, text: string): string {
  mkdirSync(layer, { recursive: true });
  const path = join(layer, `${section}.md`);
  writeFileSync(path, text);
  return path;
}

function loaded(all: readonly string[]): HelpSnapshot {
  const help = loadHelp(all);
  if (!help.ok) {assert.fail(`expected the help to load, got ${help.path}: ${help.detail}`);}
  return help.snapshot;
}

const builtin = (path: string): string => readFileSync(join(packageRoot, path), 'utf8');

const MAXIMA = { requests: 20, context_tokens: 100000, cost_usd: 1.5, wall_clock_s: 300 };

const CONTEXT: RenderContext = {
  profiles: [],
  policy: { ok: false, detail: 'no policy in this test' },
  bin: '/abs/bin/quotient',
  launchDir: '/abs/project',
};

/** FIELD of VALUE, which must be a record; a test failure when it is not. */
function field(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {assert.fail(`no ${name}: not an object (${JSON.stringify(value)})`);}
  return Reflect.get(value, name);
}

/** One element of VALUE, which must be an array; a test failure when it is not. */
function element(value: unknown, index: number): unknown {
  if (!Array.isArray(value)) {assert.fail(`no element ${String(index)}: not an array`);}
  return value[index];
}

/** FIELD of VALUE as a string; a test failure when it is not one. */
function stringField(value: unknown, name: string): string {
  const found = field(value, name);
  if (typeof found !== 'string') {assert.fail(`no ${name}: not a string (${JSON.stringify(found)})`);}
  return found;
}

/** The two answers a server gives at start-up, as this file reads them:
 *  initialize's instructions and the one tool description. `converse` types the
 *  JSON-RPC envelope only, so each field is checked rather than asserted. */
function startUpText(replies: readonly unknown[]): { instructions: string; description: string } {
  return {
    instructions: stringField(field(replies[0], 'result'), 'instructions'),
    description: stringField(element(field(field(replies[1], 'result'), 'tools'), 0), 'description'),
  };
}

/** The pi-agent-result/2 document one `tools/call` reply carries. */
function callDocument(reply: unknown): unknown {
  const document: unknown = JSON.parse(stringField(element(field(field(reply, 'result'), 'content'), 0), 'text'));
  return document;
}

test('help: every section resolves; refusals is an alias of result; an unknown name is none', () => {
  assert.deepEqual(HELP_SECTIONS, [
    'agent',
    'tool',
    'tool-start',
    'tool-wait',
    'tool-ack',
    'tool-cancel',
    'orchestrate',
    'result',
    'policy',
    'form',
    'profiles',
    'setup',
    'clients',
    'reduce',
  ]);
  assert.equal(sectionName('refusals'), 'result');
  assert.equal(sectionName('policy'), 'policy');
  assert.equal(sectionName('nope'), null);
  const snapshot = loaded(layers().all);
  for (const section of HELP_SECTIONS) {assert.ok(sectionText(snapshot, section, CONTEXT).trim().length > 0, section);}
});

test('help: with no override each section is its built-in source', () => {
  const snapshot = loaded(layers().all);
  assert.equal(sectionText(snapshot, 'tool', CONTEXT), builtin('help/tool.md'));
  assert.equal(sectionText(snapshot, 'orchestrate', CONTEXT), builtin('help/orchestrate.md'));
  assert.equal(sectionText(snapshot, 'profiles', CONTEXT), builtin('help/profiles.md'));
  assert.ok(sectionText(snapshot, 'agent', CONTEXT).startsWith(builtin('help/agent.md')));
  assert.match(sectionText(snapshot, 'reduce', CONTEXT), /usage: quotient reduce/);
});

test('help: contract sections print docs/contract verbatim and ignore an override', () => {
  const { over, under, all } = layers();
  for (const section of ['result', 'policy', 'form']) {
    write(over, section, 'higher override\n');
    write(under, section, 'lower override\n');
  }
  const snapshot = loaded(all);
  assert.equal(sectionText(snapshot, 'result', CONTEXT), builtin('docs/contract/pi-agent-result-2.md'));
  assert.equal(sectionText(snapshot, 'policy', CONTEXT), builtin('docs/contract/quotient-policy-2.md'));
  assert.equal(sectionText(snapshot, 'form', CONTEXT), builtin('docs/contract/form-1.md'));
});

test('help: a file override wins for agent, the higher layer over the lower; an absent override falls through', () => {
  const { over, under, all } = layers();
  write(under, 'agent', 'lower agent\n');
  write(under, 'tool', 'lower tool\n');
  write(over, 'tool', 'higher tool\n');
  const snapshot = loaded(all);
  assert.ok(sectionText(snapshot, 'agent', CONTEXT).startsWith('lower agent\n'), 'the override wins over the built-in');
  assert.equal(sectionText(snapshot, 'tool', CONTEXT), 'higher tool\n', 'the higher layer wins');
  assert.equal(sectionText(snapshot, 'setup', CONTEXT), builtin('help/setup.md'), 'absent everywhere falls through');
  assert.equal(snapshot.sources.get('tool'), join(over, 'tool.md'));
});

/** The sections that describe the four task tools, one each (design sec-8). */
const TOOL_SECTIONS = ['tool-start', 'tool-wait', 'tool-ack', 'tool-cancel'] as const;

test('help: each task tool section resolves by name to its non-empty built-in file', () => {
  const snapshot = loaded(layers().all);
  for (const section of TOOL_SECTIONS) {
    assert.equal(sectionName(section), section);
    const text = sectionText(snapshot, section, CONTEXT);
    assert.ok(text.trim().length > 0, `${section} is not empty`);
    assert.equal(text, builtin(`help/${section}.md`), section);
  }
});

test('help: an operator layer overrides each task tool section, as it does tool', () => {
  const { over, all } = layers();
  for (const section of TOOL_SECTIONS) {write(over, section, `operator ${section}\n`);}
  const snapshot = loaded(all);
  for (const section of TOOL_SECTIONS) {
    assert.equal(sectionText(snapshot, section, CONTEXT), `operator ${section}\n`);
    assert.equal(snapshot.sources.get(section), join(over, `${section}.md`));
  }
});

test('help: every tool\'s description section is a help section', () => {
  for (const [name, tool] of Object.entries(TOOLS)) {
    assert.ok(HELP_SECTIONS.includes(tool.section), `${name}: ${tool.section}`);
  }
});

test('help: an override replaces a rendered section verbatim', () => {
  const { over, all } = layers();
  write(over, 'clients', 'our own snippets\n');
  assert.equal(sectionText(loaded(all), 'clients', CONTEXT), 'our own snippets\n');
});

test('help: an unreadable layer or section file, shadowed or not, refuses start-up', () => {
  const { over, all } = layers();
  // A layer that is not a directory.
  mkdirSync(join(over, '..'), { recursive: true });
  writeFileSync(over, 'not a directory');
  const notDir = loadHelp(all);
  if (notDir.ok) {assert.fail('a layer that is not a readable directory must refuse');}
  assert.equal(notDir.path, over);

  // A section file in the lower layer that does not resolve, shadowed by a
  // readable one above: still a broken deployment.
  const fresh = layers();
  write(fresh.over, 'agent', 'higher agent\n');
  mkdirSync(fresh.under, { recursive: true });
  const dangling = join(fresh.under, 'agent.md');
  symlinkSync(join(tmpdir(), 'quotient-no-such-target'), dangling);
  const shadowed = loadHelp(fresh.all);
  if (shadowed.ok) {assert.fail('an unreadable shadowed section file must refuse');}
  assert.equal(shadowed.path, dangling);
  assert.match(shadowed.detail, /could not be read/);

  // A dangling layer symlink is unreadable, not absent.
  const third = layers();
  mkdirSync(join(third.under, '..'), { recursive: true });
  symlinkSync(join(tmpdir(), 'quotient-no-such-target'), third.under);
  const unresolved = loadHelp(third.all);
  if (unresolved.ok) {assert.fail('a layer entry that does not resolve is unreadable, not absent');}
  assert.equal(unresolved.path, third.under);
});

test('help: help_digest is stable, and moves with a section, its source or its bytes', () => {
  const { over, all } = layers();
  const base = loaded(all).digest;
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(loaded(all).digest, base, 'the same layers give the same digest');
  write(over, 'setup', 'local setup\n');
  const overridden = loaded(all).digest;
  assert.notEqual(overridden, base);
  write(over, 'setup', 'local setup, edited\n');
  assert.notEqual(loaded(all).digest, overridden);
});

test('help: the profiles section states the grammar the loader parses', () => {
  const profiles = builtin('help/profiles.md');
  assert.ok(profiles.includes(`\`${PROFILE_NAME.source}\``), 'the name pattern');
  for (const level of THINKING_LEVELS) {assert.ok(profiles.includes(`\`${level}\``), `thinking level ${level}`);}
  for (const field of ['filesystem', 'model', 'tools', 'thinking']) {assert.ok(profiles.includes(`\`${field}\``), field);}
});

test('help: the agent section carries the delegation guidance', () => {
  const agent = sectionText(loaded(layers().all), 'agent', CONTEXT);
  for (const phrase of ['final', 'state', 'causes', 'transcript', 'refused', 'session']) {
    assert.ok(agent.includes(`\`${phrase}\``), `agent names \`${phrase}\``);
  }
});

test('help: the agent section points at the orchestration guide', () => {
  assert.ok(builtin('help/agent.md').includes('`quotient help orchestrate`'));
});

test('help: the orchestration guide names no profile: profiles are the operator\'s', () => {
  const orchestrate = builtin('help/orchestrate.md');
  const examples = readdirSync(join(packageRoot, 'examples/profiles')).map((file) => file.replace(/\.md$/, ''));
  assert.ok(examples.length > 0, 'the scan has example profiles to look for');
  for (const name of examples) {assert.ok(!orchestrate.includes(`\`${name}\``), `orchestrate names \`${name}\``);}
});

test('help: the profile table renders each profile with its pinned capability, or unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quotient-help-profiles-'));
  const layer = join(dir, 'profiles');
  writeProfiles(layer, {
    read: profileDocument({ thinking: 'off' }),
    write: profileDocument({ filesystem: 'write' }),
  });
  const snapshot = loadProfiles([layer]);
  if (!snapshot.ok) {assert.fail(snapshot.detail);}
  const profiles = [...snapshot.snapshot.profiles.values()];

  const pinned = profileTable(profiles, { ok: true, profiles: { read: 'read' }, maxima: MAXIMA });
  assert.match(pinned, /\| `read` \| .* \| off \| .* \| read \|/);
  assert.match(pinned, /\| `write` \| .* \| not listed: every call refuses \|/);
  assert.ok(pinned.includes(join(layer, 'read.md')), 'the table names the source path');
  assert.match(pinned, /re-checked on every call/);

  const unknown = profileTable(profiles, { ok: false, detail: 'no policy' });
  assert.match(unknown, /\| `read` \| .* \| unknown \(policy unavailable\) \|/);
  assert.match(profileTable([], { ok: false, detail: 'no policy' }), /no profiles/);
});

test('help: the maxima table renders each per-run maximum, or why the policy is unreadable', () => {
  const known = maximaTable({ ok: true, profiles: {}, maxima: MAXIMA });
  for (const [unit, value] of Object.entries(MAXIMA)) {assert.match(known, new RegExp(`\\| \`${unit}\` \\| ${String(value)} \\|`), unit);}
  assert.match(known, /re-read on every call/);
  assert.ok(known.includes('`ceilings`'), 'says a call\'s ceilings may only lower them');

  const unknown = maximaTable({ ok: false, detail: 'no policy here' });
  assert.match(unknown, /no policy here/);
  assert.doesNotMatch(unknown, /\| `requests` \|/);
});

test('clients: both snippets carry the absolute bin path; tool_timeout_sec is wall_clock_s + 60', () => {
  const text = clientsSnippets({ ...CONTEXT, policy: { ok: true, profiles: {}, maxima: MAXIMA } });
  const json = /```json\n([\s\S]*?)```/.exec(text);
  assert.ok(json !== null, 'a json block');
  assert.deepEqual(JSON.parse(json[1]), { mcpServers: { quotient: { command: '/abs/bin/quotient' } } });
  assert.ok(text.includes('[mcp_servers.quotient]'), 'the Codex table');
  assert.match(text, /\[mcp_servers\.quotient\]\ncommand = "\/abs\/bin\/quotient"\ncwd = "\/abs\/project"/);
  assert.match(text, /^tool_timeout_sec = 360 /m);
});

test('clients: with no readable policy tool_timeout_sec is a placeholder that says why', () => {
  const text = clientsSnippets({ ...CONTEXT, policy: { ok: false, detail: '/p/policy.json could not be read (ENOENT)' } });
  assert.match(text, /^tool_timeout_sec = \d+ +# placeholder: no readable policy/m);
  assert.match(text, /ENOENT/);
});

// ── The shipped text: no launch-dir layer ──────────────────────────────────

/** The shipped prose this slice must keep true: the help files, the README, the
 *  examples, the rationale and the active contracts. The historical /1
 *  contracts describe the layers of their time and are left alone. */
const SHIPPED_PROSE = [
  'help',
  'README.md',
  'examples',
  'docs/design.md',
  'docs/contract/quotient-policy-2.md',
  'docs/contract/form-1.md',
  'docs/contract/pi-agent-result-2.md',
  'docs/contract/quotient-approvals-1.md',
];

/** Every file under PATH, which is a file or a directory. */
function proseFiles(path: string): string[] {
  return statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => proseFiles(join(path, name))) : [path];
}

/** A mention of a launch-dir layer. In shipped text `.quotient` is either a
 *  project's own forms (`.quotient/forms/…`, which the policy contract teaches)
 *  or one of the two layers quotient read from the launch directory until 0.3.0:
 *  `profiles` and `help`. Any other spelling — `<launch dir>/.quotient/`, a bare
 *  `./.quotient` — can only be describing a layer. */
const LAYER_MENTION = /(^|[^\w])\.quotient(?![\\/]forms\b)/;

/** What only the legacy start-up failure may say in a paragraph naming a layer. */
const LEGACY_MARKERS = ['no longer reads', 'fails start-up', 'remove or replace'];

/**
 * Every paragraph of TEXT that describes a launch-dir profile or help layer. The
 * one exception is the start-up failure that tells the operator to move those
 * documents: it must name them to be actionable.
 */
export function launchDirLayerViolations(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .filter((paragraph) => LAYER_MENTION.test(paragraph) && !LEGACY_MARKERS.some((marker) => paragraph.includes(marker)))
    .map((paragraph) => `describes a launch-dir layer: ${paragraph.trim().split('\n')[0]}`);
}

test('the shipped text describes no launch-dir profile or help layer', () => {
  const files = SHIPPED_PROSE.flatMap((path) => proseFiles(join(packageRoot, path)));
  assert.ok(files.includes(join(packageRoot, 'README.md')), 'the scan reaches the README');
  const violations = files.flatMap((file) =>
    launchDirLayerViolations(readFileSync(file, 'utf8')).map((line) => `${file.slice(packageRoot.length)}: ${line}`),
  );
  assert.deepEqual(violations, []);
});

test('the launch-dir guard catches a layer description and admits the start-up failure', () => {
  const old = 'A project can carry its own profiles in `.quotient/profiles/`, which win over the user\'s.';
  assert.equal(launchDirLayerViolations(old).length, 1, 'a relative layer mention is a violation');
  assert.equal(launchDirLayerViolations('The server finds its layers in `<launch dir>/.quotient/help/`.').length, 1);
  const failure =
    'quotient no longer reads help from the launch directory; move these documents to ~/.config/quotient/help and restart';
  assert.deepEqual(launchDirLayerViolations(failure), [], 'the start-up failure may name the layers');
  assert.deepEqual(launchDirLayerViolations('A project form lives at `<root>/.quotient/forms/write`.'), []);
});

test('help: the rendered clients snippet and the setup section teach XDG only, and project forms', () => {
  const clients = clientsSnippets({ ...CONTEXT, policy: { ok: true, profiles: {}, maxima: MAXIMA } });
  assert.deepEqual(launchDirLayerViolations(clients), [], 'the snippet names no launch-dir layer');
  assert.match(clients, /only defaults/, 'the `cwd` note says the launch dir only defaults a call\'s cwd');
  const setup = builtin('help/setup.md');
  assert.ok(setup.includes('quotient allow'), 'the setup says how a project form is approved');
  assert.ok(setup.includes('.quotient/forms/'), 'the setup names the project form path');
  const profiles = builtin('help/profiles.md');
  assert.ok(profiles.includes('quotient/profiles/'), 'the profiles section names the XDG layer');
});

test('help: the setup section names the doc that builds a form family', () => {
  assert.ok(builtin('help/setup.md').includes('docs/nix-forms.md'), 'the setup section points at docs/nix-forms.md');
});

test('policyView: a readable policy gives its pins and maxima; otherwise why not', () => {
  const { dir, policyPath } = workspace();
  assert.deepEqual(policyView({ ok: true, path: policyPath }), { ok: true, profiles: { read: 'read', write: 'write' }, maxima: { requests: 20, context_tokens: 100000, cost_usd: 1.5, wall_clock_s: 600 } });
  const missing = policyView({ ok: true, path: join(dir, 'absent.json') });
  if (missing.ok) {assert.fail('an absent policy has no view');}
  assert.match(missing.detail, /ENOENT/);
  assert.equal(policyView({ ok: false, detail: 'QUOTIENT_POLICY is set but empty' }).ok, false);
});

// ── The server's self-description ──────────────────────────────────────────

/** The agent and tool sections a server launched with ENV in LAUNCH would
 *  assemble, computed by the same loaders and renderer. */
function expected(env: Env, launchDir: string): { agent: string; tool: string; digest: string } {
  const locations = resolveLocations(env);
  const profiles = loadProfiles(locations.profileLayers);
  if (!profiles.ok) {assert.fail(profiles.detail);}
  const snapshot = loaded(locations.helpLayers);
  const context: RenderContext = {
    profiles: [...profiles.snapshot.profiles.values()],
    policy: policyView(locations.policyPath),
    bin: '/unused',
    launchDir,
  };
  return { agent: sectionText(snapshot, 'agent', context), tool: sectionText(snapshot, 'tool', context), digest: snapshot.digest };
}

async function selfDescription(env: Env, launchDir: string): Promise<{ instructions: string; description: string; stderr: string }> {
  const { replies, stderr } = await converse([line({ id: 1, method: 'initialize' }), line({ id: 2, method: 'tools/list' })], env, { launchDir });
  return { ...startUpText(replies), stderr };
}

test('server: initialize instructions equals the assembled agent section; the tool description equals tool', async () => {
  const { env, dir } = workspace();
  const launchDir = join(dir, 'launch');
  const { instructions, description } = await selfDescription(env, launchDir);
  const want = expected(env, launchDir);
  assert.equal(instructions, want.agent);
  assert.equal(description, want.tool);
  assert.match(instructions, /\| `read` \| .* \| read \|/, 'the table pins read as the policy reads');
  assert.match(instructions, /\| `requests` \| 20 \|/, 'the instructions carry the policy maxima');
});

test('server: an XDG override wins for agent and tool, as read at start-up', async () => {
  const { env, dir } = workspace();
  const launchDir = join(dir, 'launch');
  write(xdgHelpLayer(dir), 'agent', 'operator agent text\n');
  const { instructions, description } = await selfDescription(env, launchDir);
  assert.ok(instructions.startsWith('operator agent text\n'));
  assert.equal(description, builtin('help/tool.md'), 'tool falls through to the built-in');
  // The rendered agent section carries the profile table, whose source column
  // is the only layer path it can name: it is the XDG one (EX-4).
  assert.ok(instructions.includes(xdgProfileLayer(dir)), instructions);
  for (const text of [instructions, description]) {
    assert.equal(text.includes(join(launchDir, '.quotient')), false, 'no rendered text names a launch-dir path');
  }
});

test('server: a launch-dir help layer fails start-up instead of overriding', async () => {
  const { env, dir } = workspace();
  const launchDir = join(dir, 'launch');
  const legacy = write(join(launchDir, '.quotient', 'help'), 'agent', 'project agent text\n');
  const { instructions, description, stderr } = await selfDescription(env, launchDir);
  assert.match(instructions, /refused start-up/);
  assert.ok(instructions.includes(dirname(legacy)), instructions);
  assert.ok(description.includes(dirname(legacy)), description);
  assert.equal(instructions.includes('project agent text'), false, 'the legacy override is never read');
  assert.ok(stderr.includes(dirname(legacy)), stderr);
});

test('server: an unreadable policy at initialize reads unknown, and the server still starts', async () => {
  const { env, dir } = workspace('{', { raw: true });
  const { instructions } = await selfDescription(env, join(dir, 'launch'));
  assert.match(instructions, /\| `read` \| .* \| unknown \(policy unavailable\) \|/);
});

test('server: an unreadable help layer refuses start-up: every call is profile-invalid with the help path', async () => {
  const { env, dir } = workspace();
  const layer = xdgHelpLayer(dir);
  mkdirSync(join(layer, '..'), { recursive: true });
  symlinkSync(join(tmpdir(), 'quotient-no-such-target'), layer);
  const { replies, stderr } = await converse(
    [line({ id: 1, method: 'initialize' }), line({ id: 2, method: 'tools/list' }), callLine(3, { prompt: 'hi', profile: 'read' })],
    env,
    { launchDir: join(dir, 'launch') },
  );
  const { instructions, description } = startUpText(replies);
  const doc = callDocument(replies[2]);
  assert.match(instructions, /refused start-up/);
  assert.ok(instructions.includes(layer));
  assert.ok(description.includes(layer));
  assert.equal(field(doc, 'state'), 'refused');
  const refusal = field(doc, 'refusal');
  assert.equal(field(refusal, 'reason'), 'profile-invalid');
  assert.ok(stringField(refusal, 'detail').includes(layer), 'the help path is in detail');
  assert.ok(stderr.includes(layer), 'one stderr line names it');
});

test('server: help_digest is on the spawn record', async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'quotient-help-root-')), 'root');
  mkdirSync(root, { recursive: true });
  const { env, dir, runDir } = workspace(validPolicy({ roots: [root] }));
  const launchDir = join(dir, 'launch');
  write(xdgHelpLayer(dir), 'setup', 'local setup\n');
  await converse([callLine(1, { prompt: 'hi', profile: 'read', cwd: root })], env, { launchDir });
  const auditPath = join(onlyRunDir(runDir), 'audit.jsonl');
  assert.equal(jsonLines(auditPath)[0].record, 'admitted', 'the run was published before it was spawned');
  assert.equal(spawnRecord(auditPath).help_digest, expected(env, launchDir).digest);
});
