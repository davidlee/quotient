// Tests for the built-in help (design sec-2 "Help sections", "Overrides and
// snapshot", sec-5 "Clients"): one sectioned source, two override layers over
// the built-in, contract sections printed verbatim, a start-up snapshot with
// its digest, the rendered profile table and the two client snippets.
//
// Hermetic: every test mints its own temp tree for the override layers; the
// built-in layer is the package's own `help/` and `docs/contract/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageRoot } from '../root.ts';
import { PROFILE_NAME, THINKING_LEVELS, loadProfiles } from '../server/profiles.ts';
import { profileDocument, workspace, writeProfiles } from '../server/test-rig.ts';
import { HELP_SECTIONS, clientsSnippets, loadHelp, policyView, profileTable, sectionName, sectionText } from './help.ts';
import type { HelpSnapshot, RenderContext } from './help.ts';

/** Two empty override layers, launch dir first, as `config.ts` orders them. */
function layers(): { launch: string; xdg: string; all: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'quotient-help-'));
  const launch = join(dir, 'launch', '.quotient', 'help');
  const xdg = join(dir, 'config', 'quotient', 'help');
  return { launch, xdg, all: [launch, xdg] };
}

function write(layer: string, section: string, text: string): string {
  mkdirSync(layer, { recursive: true });
  const path = join(layer, `${section}.md`);
  writeFileSync(path, text);
  return path;
}

function loaded(all: readonly string[]): HelpSnapshot {
  const help = loadHelp(all);
  if (!help.ok) assert.fail(`expected the help to load, got ${help.path}: ${help.detail}`);
  return help.snapshot;
}

const builtin = (path: string): string => readFileSync(join(packageRoot, path), 'utf8');

const CONTEXT: RenderContext = {
  profiles: [],
  policy: { ok: false, detail: 'no policy in this test' },
  bin: '/abs/bin/quotient',
  launchDir: '/abs/project',
};

test('help: every section resolves; refusals is an alias of result; an unknown name is none', () => {
  assert.deepEqual(HELP_SECTIONS, ['agent', 'tool', 'result', 'policy', 'form', 'profiles', 'setup', 'clients', 'reduce']);
  assert.equal(sectionName('refusals'), 'result');
  assert.equal(sectionName('policy'), 'policy');
  assert.equal(sectionName('nope'), null);
  const snapshot = loaded(layers().all);
  for (const section of HELP_SECTIONS) assert.ok(sectionText(snapshot, section, CONTEXT).trim().length > 0, section);
});

test('help: with no override each section is its built-in source', () => {
  const snapshot = loaded(layers().all);
  assert.equal(sectionText(snapshot, 'tool', CONTEXT), builtin('help/tool.md'));
  assert.equal(sectionText(snapshot, 'profiles', CONTEXT), builtin('help/profiles.md'));
  assert.ok(sectionText(snapshot, 'agent', CONTEXT).startsWith(builtin('help/agent.md')));
  assert.match(sectionText(snapshot, 'reduce', CONTEXT), /usage: quotient reduce/);
});

test('help: contract sections print docs/contract verbatim and ignore an override', () => {
  const { launch, xdg, all } = layers();
  for (const section of ['result', 'policy', 'form']) {
    write(launch, section, 'launch override\n');
    write(xdg, section, 'xdg override\n');
  }
  const snapshot = loaded(all);
  assert.equal(sectionText(snapshot, 'result', CONTEXT), builtin('docs/contract/pi-agent-result-1.md'));
  assert.equal(sectionText(snapshot, 'policy', CONTEXT), builtin('docs/contract/quotient-policy-1.md'));
  assert.equal(sectionText(snapshot, 'form', CONTEXT), builtin('docs/contract/form-1.md'));
});

test('help: a file override wins for agent, launch dir over XDG; an absent override falls through', () => {
  const { launch, xdg, all } = layers();
  write(xdg, 'agent', 'xdg agent\n');
  write(xdg, 'tool', 'xdg tool\n');
  write(launch, 'tool', 'launch tool\n');
  const snapshot = loaded(all);
  assert.ok(sectionText(snapshot, 'agent', CONTEXT).startsWith('xdg agent\n'), 'the XDG override wins over the built-in');
  assert.equal(sectionText(snapshot, 'tool', CONTEXT), 'launch tool\n', 'the launch layer wins over XDG');
  assert.equal(sectionText(snapshot, 'setup', CONTEXT), builtin('help/setup.md'), 'absent everywhere falls through');
  assert.equal(snapshot.sources.get('tool'), join(launch, 'tool.md'));
});

test('help: an override replaces a rendered section verbatim', () => {
  const { launch, all } = layers();
  write(launch, 'clients', 'our own snippets\n');
  assert.equal(sectionText(loaded(all), 'clients', CONTEXT), 'our own snippets\n');
});

test('help: an unreadable layer or section file, shadowed or not, refuses start-up', () => {
  const { launch, xdg, all } = layers();
  // A layer that is not a directory.
  mkdirSync(join(launch, '..'), { recursive: true });
  writeFileSync(launch, 'not a directory');
  const notDir = loadHelp(all);
  if (notDir.ok) assert.fail('a layer that is not a readable directory must refuse');
  assert.equal(notDir.path, launch);

  // A section file in the lower layer that does not resolve, shadowed by a
  // readable one above: still a broken deployment.
  const fresh = layers();
  write(fresh.launch, 'agent', 'launch agent\n');
  mkdirSync(fresh.xdg, { recursive: true });
  const dangling = join(fresh.xdg, 'agent.md');
  symlinkSync(join(tmpdir(), 'quotient-no-such-target'), dangling);
  const shadowed = loadHelp(fresh.all);
  if (shadowed.ok) assert.fail('an unreadable shadowed section file must refuse');
  assert.equal(shadowed.path, dangling);
  assert.match(shadowed.detail, /could not be read/);

  // A dangling layer symlink is unreadable, not absent.
  const third = layers();
  mkdirSync(join(third.xdg, '..'), { recursive: true });
  symlinkSync(join(tmpdir(), 'quotient-no-such-target'), third.xdg);
  const unresolved = loadHelp(third.all);
  if (unresolved.ok) assert.fail('a layer entry that does not resolve is unreadable, not absent');
  assert.equal(unresolved.path, third.xdg);
  void xdg;
});

test('help: help_digest is stable, and moves with a section, its source or its bytes', () => {
  const { launch, all } = layers();
  const base = loaded(all).digest;
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(loaded(all).digest, base, 'the same layers give the same digest');
  write(launch, 'setup', 'local setup\n');
  const overridden = loaded(all).digest;
  assert.notEqual(overridden, base);
  write(launch, 'setup', 'local setup, edited\n');
  assert.notEqual(loaded(all).digest, overridden);
});

test('help: the profiles section states the grammar the loader parses', () => {
  const profiles = builtin('help/profiles.md');
  assert.ok(profiles.includes(`\`${PROFILE_NAME.source}\``), 'the name pattern');
  for (const level of THINKING_LEVELS) assert.ok(profiles.includes(`\`${level}\``), `thinking level ${level}`);
  for (const field of ['filesystem', 'model', 'tools', 'thinking']) assert.ok(profiles.includes(`\`${field}\``), field);
});

test('help: the agent section carries the delegation guidance', () => {
  const agent = sectionText(loaded(layers().all), 'agent', CONTEXT);
  for (const phrase of ['final', 'state', 'causes', 'transcript', 'refused', 'session']) {
    assert.ok(agent.includes(`\`${phrase}\``), `agent names \`${phrase}\``);
  }
});

test('help: the profile table renders each profile with its pinned capability, or unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quotient-help-profiles-'));
  const layer = join(dir, 'profiles');
  writeProfiles(layer, {
    read: profileDocument({ thinking: 'off' }),
    write: profileDocument({ filesystem: 'write' }),
  });
  const snapshot = loadProfiles([layer]);
  if (!snapshot.ok) assert.fail(snapshot.detail);
  const profiles = [...snapshot.snapshot.profiles.values()];

  const pinned = profileTable(profiles, { ok: true, profiles: { read: 'read' }, wallClockS: 300 });
  assert.match(pinned, /\| `read` \| .* \| off \| .* \| read \|/);
  assert.match(pinned, /\| `write` \| .* \| not listed: every call refuses \|/);
  assert.ok(pinned.includes(join(layer, 'read.md')), 'the table names the source path');
  assert.match(pinned, /re-checked on every call/);

  const unknown = profileTable(profiles, { ok: false, detail: 'no policy' });
  assert.match(unknown, /\| `read` \| .* \| unknown \(policy unavailable\) \|/);
  assert.match(profileTable([], { ok: false, detail: 'no policy' }), /no profiles/);
});

test('clients: both snippets carry the absolute bin path; tool_timeout_sec is wall_clock_s + 60', () => {
  const text = clientsSnippets({ ...CONTEXT, policy: { ok: true, profiles: {}, wallClockS: 300 } });
  const json = text.match(/```json\n([\s\S]*?)```/);
  assert.ok(json, 'a json block');
  assert.deepEqual(JSON.parse(json[1]), { mcpServers: { quotient: { command: '/abs/bin/quotient' } } });
  assert.match(text, /\[mcp_servers\.quotient\]\ncommand = "\/abs\/bin\/quotient"\ncwd = "\/abs\/project"/);
  assert.match(text, /^tool_timeout_sec = 360 /m);
});

test('clients: with no readable policy tool_timeout_sec is a placeholder that says why', () => {
  const text = clientsSnippets({ ...CONTEXT, policy: { ok: false, detail: '/p/policy.json could not be read (ENOENT)' } });
  assert.match(text, /^tool_timeout_sec = \d+ +# placeholder: no readable policy/m);
  assert.match(text, /ENOENT/);
});

test('policyView: a readable policy gives its pins and wall clock; otherwise why not', () => {
  const { dir, policyPath } = workspace();
  assert.deepEqual(policyView({ ok: true, path: policyPath }), { ok: true, profiles: { read: 'read', write: 'write' }, wallClockS: 600 });
  const missing = policyView({ ok: true, path: join(dir, 'absent.json') });
  if (missing.ok) assert.fail('an absent policy has no view');
  assert.match(missing.detail, /ENOENT/);
  assert.equal(policyView({ ok: false, detail: 'QUOTIENT_POLICY is set but empty' }).ok, false);
});
