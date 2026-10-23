// Tests for profiles as live authority (design sec-2 steps 3-4, sec-3's profile
// section), the call's root allowlist (sec-2 step 4) and the call's `tools`
// narrowing (DEC-103): the start-up snapshot and its digest, the document
// grammar, the three profile refusals, root classification by path components,
// the `-e builtin:mcp` contract and narrow-only tool selection.
//
// Hermetic: every test mints its own temp tree for the profile directory, the
// policy, the run dir and the roots; the ambient environment is never read and
// nothing is spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MCP_EXTENSION,
  PROFILE_NAME,
  THINKING_LEVELS,
  checkProfileExtensions,
  effectiveTools,
  loadProfiles,
  resolveProfile,
  resolveRoot,
  toolsArgument,
} from './profiles.ts';
import type { Filesystem } from './profiles.ts';
import { readPolicy } from './policy.ts';
import {
  attempts,
  callLine,
  converse,
  launchEnv,
  profileDocument,
  validPolicy,
  writeProfiles,
  xdgProfileLayer,
} from './test-rig.ts';
import type { Env } from './test-rig.ts';

/** The example documents the package ships to start from (not a built-in layer). */
const EXAMPLE_PROFILES = new URL('../../examples/profiles/', import.meta.url).pathname;

const document = profileDocument;

/** A temp profile layer holding one document per named profile. */
function profileDir(documents: Record<string, string>): string {
  return writeProfiles(mkdtempSync(join(tmpdir(), 'quotient-profiles-')), documents);
}

/** The read-only profile map most cases pin: every name to `read`. */
const pinRead = (...names: string[]): Record<string, Filesystem> =>
  Object.fromEntries(names.map((name) => [name, 'read' as const]));

function snapshotOf(documents: Record<string, string>) {
  const loaded = loadProfiles([profileDir(documents)]);
  if (!loaded.ok) assert.fail(`expected a snapshot, got ${loaded.path}: ${loaded.detail}`);
  return loaded.snapshot;
}

/** Load one `read` document that must refuse at start-up; the detail it names. */
function refuseDocument(text: string, detail: RegExp): void {
  const dir = profileDir({ read: text });
  const loaded = loadProfiles([dir]);
  if (loaded.ok) assert.fail(`expected a start-up refusal matching ${detail}`);
  assert.equal(loaded.path, join(dir, 'read.md'));
  assert.match(loaded.detail, detail);
}

function refuseProfile(
  resolution: ReturnType<typeof resolveProfile>,
  reason: string,
  detail?: RegExp,
): void {
  if (resolution.ok) assert.fail(`expected a ${reason} refusal, got profile "${resolution.profile.name}"`);
  assert.equal(resolution.reason, reason);
  if (detail !== undefined) assert.match(resolution.detail, detail);
}

function refuseRoot(resolution: ReturnType<typeof resolveRoot>, reason: string, detail?: RegExp): void {
  if (resolution.ok) assert.fail(`expected a ${reason} refusal, got root "${resolution.root}"`);
  assert.equal(resolution.reason, reason);
  if (detail !== undefined) assert.match(resolution.detail, detail);
}

// ── The example documents ──────────────────────────────────────────────────

test('every example document loads as a profile layer', () => {
  const loaded = loadProfiles([EXAMPLE_PROFILES]);
  if (!loaded.ok) assert.fail(`the example profiles do not validate: ${loaded.path}: ${loaded.detail}`);
  const snapshot = loaded.snapshot;

  assert.match(snapshot.digest, /^[0-9a-f]{64}$/);
  const shipped = readdirSync(EXAMPLE_PROFILES)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort();
  assert.deepEqual([...snapshot.profiles.keys()].sort(), shipped, 'every shipped document is exercised');
  assert.ok(shipped.includes('read') && shipped.includes('write'), 'a read and a write example ship');

  const read = snapshot.profiles.get('read');
  if (read === undefined) assert.fail('the read profile is missing');
  assert.equal(read.filesystem, 'read');
  assert.equal(read.model, 'llm-gateway/deepseek-flash');
  assert.equal(read.thinking, 'off');
  assert.ok(read.tools.includes('bash'), 'read-only is an OS claim, not a tool list');

  const write = snapshot.profiles.get('write');
  if (write === undefined) assert.fail('the write profile is missing');
  assert.equal(write.filesystem, 'write');
  assert.equal(write.model, 'llm-gateway/deepseek-flash');
  assert.equal(write.thinking, 'off');
  assert.ok(write.tools.includes('bash'));
  assert.ok(write.tools.includes('write'));

  const research = snapshot.profiles.get('research');
  if (research === undefined) assert.fail('the research profile is missing');
  assert.equal(research.filesystem, 'read');
  assert.equal(research.thinking, 'low');
  assert.deepEqual(research.tools, ['read', 'grep', 'find', 'ls', 'bash']);

  for (const [name, thinking, base] of [
    ['review', 'max', read],
    ['judgement', 'high', read],
    ['implement', 'high', write],
  ] as const) {
    const profile = snapshot.profiles.get(name);
    if (profile === undefined) assert.fail(`the ${name} profile is missing`);
    assert.equal(profile.thinking, thinking);
    assert.equal(profile.filesystem, base.filesystem);
    assert.equal(profile.model, base.model);
    assert.deepEqual(profile.tools, base.tools);
  }

  // Copying the shipped policy and profiles together must admit every example.
  const policy = readPolicy(new URL('../../examples/policy.json', import.meta.url).pathname);
  if (!policy.ok) assert.fail(`the example policy does not validate: ${policy.detail}`);
  assert.deepEqual(Object.keys(policy.policy.profiles).sort(), shipped);
  for (const name of shipped) {
    const result = resolveProfile(snapshot, name, policy.policy.profiles);
    if (!result.ok) assert.fail(`${name}: ${result.reason}: ${result.detail}`);
  }
});

// ── The optional thinking field ────────────────────────────────────────────

test('every thinking level parses, and an omitted field leaves no thinking key', () => {
  for (const level of THINKING_LEVELS) {
    const snapshot = snapshotOf({ read: document({ thinking: level }) });
    const profile = snapshot.profiles.get('read');
    if (profile === undefined) assert.fail('the fixture profile is missing');
    assert.equal(profile.thinking, level);

    // The accessor copies the field like the rest of the profile.
    const resolved = resolveProfile(snapshot, 'read', pinRead('read'));
    if (!resolved.ok) assert.fail(`expected the profile, got ${resolved.reason}: ${resolved.detail}`);
    assert.equal(resolved.profile.thinking, level);
  }

  const snapshot = snapshotOf({ read: document() });
  const profile = snapshot.profiles.get('read');
  if (profile === undefined) assert.fail('the fixture profile is missing');
  assert.equal('thinking' in profile, false, 'an omitted field is no key at all, not undefined');
  const resolved = resolveProfile(snapshot, 'read', pinRead('read'));
  if (!resolved.ok) assert.fail(`expected the profile, got ${resolved.reason}: ${resolved.detail}`);
  assert.equal('thinking' in resolved.profile, false, 'the copy keeps the key absent');
});

test('an invalid, empty or duplicated thinking field refuses at start-up, naming the path', () => {
  const levels = THINKING_LEVELS.map((level) => `"${level}"`).join(', ');
  refuseDocument(document({ thinking: 'turbo' }), new RegExp(`thinking must be one of ${levels}, not "turbo"`));
  refuseDocument(document({ thinking: '' }), /the header field "thinking" has no value/);
  refuseDocument(document({ thinking: 'low' }).replace('tools:', 'thinking: high\ntools:'), /"thinking" is declared twice/);
});

test("a model carrying pi's :<level> shorthand refuses: the thinking field is the one place a level is set", () => {
  refuseDocument(document({ model: 'llm-gateway/deepseek-flash:high' }), /model.*:high.*thinking/);
  refuseDocument(document({ model: 'llm-gateway/deepseek-flash:off', thinking: 'low' }), /model.*:off.*thinking/);

  // A colon that names no level is part of the model id.
  const snapshot = snapshotOf({ read: document({ model: 'ollama/llama3:8b' }) });
  assert.equal(snapshot.profiles.get('read')?.model, 'ollama/llama3:8b');
});

// ── The start-up snapshot (EX-1, EX-2) ─────────────────────────────────────

test('the snapshot is frozen for the process: a mutated document is inert until a restart', () => {
  const dir = profileDir({ read: document() });
  const loaded = loadProfiles([dir]);
  if (!loaded.ok) assert.fail(`expected a snapshot, got ${loaded.path}: ${loaded.detail}`);
  const snapshot = loaded.snapshot;
  const digest = snapshot.digest;
  assert.ok(Object.isFrozen(snapshot), 'the snapshot itself is frozen');

  // A delegate with a write root can rewrite this file; the snapshotted
  // authority must not move until the server is restarted (RV-046 F-5).
  writeFileSync(join(dir, 'read.md'), document({ filesystem: 'write', tools: 'read, bash, write, edit' }));

  const resolved = resolveProfile(snapshot, 'read', pinRead('read'));
  if (!resolved.ok) assert.fail(`expected the snapshotted profile, got ${resolved.reason}: ${resolved.detail}`);
  assert.equal(resolved.profile.filesystem, 'read', 'the snapshotted capability survives the edit');
  assert.deepEqual(resolved.profile.tools, ['read', 'grep', 'find', 'ls', 'bash'], 'so does the tool set');
  assert.equal(snapshot.digest, digest, 'and the digest still describes what was loaded');
  assert.ok(Object.isFrozen(snapshot.profiles.get('read')), 'the entry is frozen');

  // Each accessor hands back a copy, so a caller cannot edit the authority.
  const copied = resolved.profile.tools as string[];
  copied.push('write');
  const again = resolveProfile(snapshot, 'read', pinRead('read'));
  if (!again.ok) assert.fail('the snapshot must keep resolving');
  assert.deepEqual(again.profile.tools, ['read', 'grep', 'find', 'ls', 'bash']);

  // A restart is a deployment act: it picks the edit up.
  const restarted = loadProfiles([dir]);
  if (!restarted.ok) assert.fail(`expected a snapshot after the restart, got ${restarted.path}: ${restarted.detail}`);
  const reloaded = restarted.snapshot.profiles.get('read');
  assert.equal(reloaded?.filesystem, 'write');
  assert.notEqual(restarted.snapshot.digest, digest, 'the digest follows the directory contents');
});

test('an invalid document refuses at start-up, naming the path, and never per call', async () => {
  const dir = profileDir({ read: document(), broken: '<!-- quotient-profile\nfilesystem: read\n-->\n' });
  const loaded = loadProfiles([dir]);
  if (loaded.ok) assert.fail('a document missing model and tools must not load');
  assert.equal(loaded.path, join(dir, 'broken.md'));
  assert.match(loaded.detail, /model/);

  // A mutation after the snapshot was taken does not re-open validation: the
  // state is decided once, at start-up.
  const good = profileDir({ read: document() });
  const held = loadProfiles([good]);
  if (!held.ok) assert.fail(`expected a snapshot, got ${held.path}: ${held.detail}`);
  writeFileSync(join(good, 'read.md'), '{ not a document');
  assert.equal(resolveProfile(held.snapshot, 'read', pinRead('read')).ok, true, 'the held snapshot is unaffected');

  // Over the wire: one stderr line at start-up, and every call refused with the
  // token the design names, naming the path (EX-2).
  const wire = mintWire({ documents: { read: document(), broken: '<!-- quotient-profile\nfilesystem: read\n-->\n' } });
  const { replies, stderr } = await converse(
    [callLine(1, { prompt: 'hi', profile: 'read', cwd: wire.root })],
    wire.env,
    { launchDir: wire.root },
  );
  assert.equal(replies.length, 1);
  const doc = JSON.parse(replies[0].result.content[0].text);
  assert.equal(doc.state, 'refused');
  assert.equal(doc.refusal.reason, 'profile-invalid');
  assert.match(doc.refusal.detail, /broken\.md/);
  assert.equal(stderr.trim().split('\n').length, 1, 'one stderr line, naming the path');
  assert.match(stderr, /broken\.md/);
});

test('the snapshot digest is deterministic over the layer contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quotient-digest-'));
  const digestOf = (documents: Record<string, string>): string => {
    for (const name of readdirSync(dir)) rmSync(join(dir, name));
    writeProfiles(dir, documents);
    const loaded = loadProfiles([dir]);
    if (!loaded.ok) assert.fail(`expected a snapshot, got ${loaded.path}: ${loaded.detail}`);
    return loaded.snapshot.digest;
  };
  const first = digestOf({ read: document(), write: document({ filesystem: 'write' }) });
  const second = digestOf({ write: document({ filesystem: 'write' }), read: document() });
  assert.equal(first, second, 'file creation order must not change the digest');

  const changed = digestOf({ read: document(), write: document({ filesystem: 'write', tools: 'read, bash' }) });
  assert.notEqual(changed, first, 'a changed tool list is a different snapshot');
});

// ── The layers: launch dir over XDG (SL-031 PHASE-05 EX-1, EX-2) ───────────

/** Two layers in one temp tree, highest first; documents per layer. */
function layers(launch: Record<string, string>, xdg: Record<string, string>): [string, string] {
  const dir = mkdtempSync(join(tmpdir(), 'quotient-layers-'));
  return [writeProfiles(join(dir, 'launch'), launch), writeProfiles(join(dir, 'xdg'), xdg)];
}

test('loadProfiles: per name the launch-dir layer wins, and each profile carries its source', () => {
  const [launch, xdg] = layers(
    { read: document({ tools: 'read' }) },
    { read: document(), write: document({ filesystem: 'write' }) },
  );
  const loaded = loadProfiles([launch, xdg]);
  if (!loaded.ok) assert.fail(`expected a snapshot, got ${loaded.path}: ${loaded.detail}`);
  const read = loaded.snapshot.profiles.get('read');
  assert.deepEqual(read?.tools, ['read'], 'the launch-dir document shadows the XDG one');
  assert.equal(read?.source, join(launch, 'read.md'));
  assert.equal(loaded.snapshot.profiles.get('write')?.source, join(xdg, 'write.md'), 'an unshadowed name falls through');
});

test('loadProfiles: a missing layer is empty; an unreadable one refuses start-up', () => {
  const [, xdg] = layers({}, { read: document() });
  const absent = join(tmpdir(), 'quotient-no-such-layer', 'profiles');
  const loaded = loadProfiles([absent, xdg]);
  if (!loaded.ok) assert.fail(`a missing layer must be empty, got ${loaded.path}: ${loaded.detail}`);
  assert.deepEqual([...loaded.snapshot.profiles.keys()], ['read']);

  const none = loadProfiles([absent]);
  assert.equal(none.ok && none.snapshot.profiles.size, 0, 'no layer at all is an empty snapshot, not a refusal');

  const dangling = join(mkdtempSync(join(tmpdir(), 'quotient-layer-link-')), 'profiles');
  symlinkSync(join(tmpdir(), 'quotient-no-such-target'), dangling);
  const unresolved = loadProfiles([dangling, xdg]);
  if (unresolved.ok) assert.fail('a layer entry that does not resolve is unreadable, not absent');
  assert.equal(unresolved.path, dangling);

  const file = join(mkdtempSync(join(tmpdir(), 'quotient-layer-file-')), 'profiles');
  writeFileSync(file, 'not a directory');
  const unreadable = loadProfiles([file, xdg]);
  if (unreadable.ok) assert.fail('a layer that is not a readable directory must refuse');
  assert.equal(unreadable.path, file);
});

test('loadProfiles: an invalid document refuses start-up even when another layer shadows it', () => {
  const broken = '<!-- quotient-profile\nfilesystem: read\n-->\n';
  const [launch, xdg] = layers({ read: document() }, { read: broken });
  const shadowed = loadProfiles([launch, xdg]);
  if (shadowed.ok) assert.fail('a shadowed invalid document must still refuse');
  assert.equal(shadowed.path, join(xdg, 'read.md'));

  const [top, bottom] = layers({ read: broken }, { read: document() });
  const shadowing = loadProfiles([top, bottom]);
  assert.equal(!shadowing.ok && shadowing.path, join(top, 'read.md'));
});

test('the old pi-mcp-profile marker is not an alias: it refuses', () => {
  refuseDocument(document().replace('<!-- quotient-profile', '<!-- pi-mcp-profile'), /quotient-profile/);
});

test('the digest covers each winning source path as well as its bytes', () => {
  const same = document();
  const [launch, xdg] = layers({}, { read: same });
  const [launch2, xdg2] = layers({ read: same }, {});
  const fromXdg = loadProfiles([launch, xdg]);
  const fromLaunch = loadProfiles([launch2, xdg2]);
  if (!fromXdg.ok || !fromLaunch.ok) assert.fail('both layouts load');
  assert.notEqual(fromXdg.snapshot.digest, fromLaunch.snapshot.digest, 'the same bytes from another path are another snapshot');
});

// ── Step 3: the name grammar and the three refusals (EX-3) ─────────────────

test('the profile name grammar splits profile-invalid from the snapshot refusals', () => {
  const longest = 'a'.repeat(32);
  const snapshot = snapshotOf({ a: document(), [longest]: document(), read: document() });
  assert.equal(PROFILE_NAME.source, '^[a-z][a-z0-9-]{0,31}$');
  const allowed = pinRead('a', longest, 'read');

  const single = resolveProfile(snapshot, 'a', allowed);
  assert.equal(single.ok, true, 'a single-character name is valid');
  assert.equal(resolveProfile(snapshot, longest, allowed).ok, true, '32 characters is the last valid length');

  for (const name of ['read/', 'Read', '-read', 'read_', longest + 'a', '', 'read md', '../read']) {
    refuseProfile(resolveProfile(snapshot, name, allowed), 'profile-invalid');
  }
});

test('a well-formed name absent from the snapshot is profile-unknown; one the policy omits is profile-not-allowed', () => {
  const snapshot = snapshotOf({ read: document() });

  refuseProfile(resolveProfile(snapshot, 'ghost', pinRead('read')), 'profile-unknown', /ghost/);
  refuseProfile(resolveProfile(snapshot, 'read', {}), 'profile-not-allowed', /read/);
  assert.equal(resolveProfile(snapshot, 'read', pinRead('read')).ok, true);
});

test('step 3 pins capability: a document whose filesystem differs from the policy map is profile-capability-mismatch', () => {
  const snapshot = snapshotOf({ read: document(), write: document({ filesystem: 'write' }) });
  refuseProfile(resolveProfile(snapshot, 'read', { read: 'write' }), 'profile-capability-mismatch', /read\.md/);
  refuseProfile(resolveProfile(snapshot, 'write', { write: 'read' }), 'profile-capability-mismatch', /write/);
  assert.equal(resolveProfile(snapshot, 'write', { write: 'write' }).ok, true);

  // Order: an unmapped name is not-allowed before any capability is compared,
  // and an unknown one is unknown before the map is consulted.
  refuseProfile(resolveProfile(snapshot, 'write', pinRead('read')), 'profile-not-allowed');
  refuseProfile(resolveProfile(snapshot, 'ghost', { ghost: 'write' }), 'profile-unknown');
});

test('the policy map is own-keyed: a profile named constructor is not mapped by Object.prototype', () => {
  const snapshot = snapshotOf({ constructor: document() });
  refuseProfile(resolveProfile(snapshot, 'constructor', pinRead('read')), 'profile-not-allowed');
  const parsed = JSON.parse('{"__proto__": "read"}') as Record<string, Filesystem>;
  refuseProfile(resolveProfile(snapshot, 'constructor', parsed), 'profile-not-allowed');
});

// ── Step 4: the root (EX-4) ────────────────────────────────────────────────

type Roots = { dir: string; one: string; oneevil: string; file: string };

function roots(): Roots {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-roots-'));
  const one = join(dir, 'one');
  const oneevil = join(dir, 'oneevil');
  mkdirSync(one);
  mkdirSync(join(one, 'sub'));
  mkdirSync(oneevil);
  const file = join(dir, 'file.txt');
  writeFileSync(file, 'x');
  return { dir, one, oneevil, file };
}

test('root classification: a missing path, a file, and a canonical directory', () => {
  const tree = roots();

  refuseRoot(resolveRoot(join(tree.dir, 'absent'), tree.dir, [tree.dir]), 'root-missing', /absent/);
  refuseRoot(resolveRoot(tree.file, tree.dir, [tree.dir]), 'root-not-a-directory', /file\.txt/);
  refuseRoot(resolveRoot(join(tree.file, 'under'), tree.dir, [tree.dir]), 'root-not-a-directory');

  const allowed = resolveRoot(tree.one, tree.dir, [tree.one]);
  if (!allowed.ok) assert.fail(`expected an allowed root, got ${allowed.reason}: ${allowed.detail}`);
  assert.equal(allowed.root, realpathSync(tree.one), 'the canonical path is what the call proceeds with');

  // A non-canonical spelling is canonicalised before the allowlist compares.
  const dotted = resolveRoot(`${tree.one}/sub/..`, tree.dir, [tree.one]);
  if (!dotted.ok) assert.fail(`expected the canonical root, got ${dotted.reason}: ${dotted.detail}`);
  assert.equal(dotted.root, realpathSync(tree.one));
});

test('allowlisting is by path components, never by string prefix', () => {
  const tree = roots();

  refuseRoot(resolveRoot(tree.oneevil, tree.dir, [tree.one]), 'root-not-allowlisted', /oneevil/);

  const descendant = resolveRoot(join(tree.one, 'sub'), tree.dir, [tree.one]);
  assert.equal(descendant.ok, true, 'a descendant is inside its root');

  const link = join(tree.dir, 'link');
  symlinkSync(tree.one, link);
  const viaLink = resolveRoot(link, tree.dir, [tree.one]);
  if (!viaLink.ok) assert.fail(`expected the symlink to canonicalise onto its target, got ${viaLink.reason}`);
  assert.equal(viaLink.root, realpathSync(tree.one));
});

test('an absent cwd resolves to the server launch directory through the same allowlist, with no exemption', () => {
  const tree = roots();

  const inside = resolveRoot(undefined, join(tree.one, 'sub'), [tree.one]);
  if (!inside.ok) assert.fail(`expected the launch directory to be allowed, got ${inside.reason}`);
  assert.equal(inside.root, realpathSync(join(tree.one, 'sub')));

  refuseRoot(resolveRoot(undefined, tree.dir, [tree.one]), 'root-not-allowlisted', /pi-mcp-roots/);
});

// ── Step 5's extension contract (EX-7) ─────────────────────────────────────

test('a profile naming an mcp__ tool under a form that passes no -e builtin:mcp refuses profile-invalid', () => {
  const snapshot = snapshotOf({
    mcp: document({ tools: 'read, mcp__doctrine__search' }),
    read: document(),
  });

  const mcp = snapshot.profiles.get('mcp');
  if (mcp === undefined) assert.fail('the fixture profile is missing');
  const refused = checkProfileExtensions(mcp, []);
  if (refused.ok) assert.fail('expected profile-invalid: the profile asks for tools it can never receive');
  assert.equal(refused.reason, 'profile-invalid');
  assert.match(refused.detail, /mcp__/);
  assert.match(refused.detail, /builtin:mcp/);

  assert.equal(checkProfileExtensions(mcp, [MCP_EXTENSION]).ok, true, 'the extension the form declares satisfies it');

  const read = snapshot.profiles.get('read');
  if (read === undefined) assert.fail('the fixture profile is missing');
  assert.equal(checkProfileExtensions(read, []).ok, true, 'a profile with no mcp__ tool needs no extension');
});

// ── The call's tools may only narrow (EX-10) ───────────────────────────────

test("a call's tools may only narrow: the intersection in profile order, handed whole to --tools", () => {
  const snapshot = snapshotOf({ read: document({ tools: 'read, grep, find, ls, bash' }) });
  const profile = snapshot.profiles.get('read');
  if (profile === undefined) assert.fail('the fixture profile is missing');

  const whole = effectiveTools(profile, undefined);
  if (!whole.ok) assert.fail(`expected the profile's own set, got ${whole.reason}`);
  assert.deepEqual(whole.tools, ['read', 'grep', 'find', 'ls', 'bash']);

  const narrowed = effectiveTools(profile, ['bash', 'read']);
  if (!narrowed.ok) assert.fail(`expected the intersection, got ${narrowed.reason}: ${narrowed.detail}`);
  assert.deepEqual(narrowed.tools, ['read', 'bash'], 'the intersection, in the profile order');
  assert.equal(toolsArgument(narrowed.tools), 'read,bash', '--tools receives the whole narrowed list');

  refuseTools(effectiveTools(profile, ['read', 'write']), 'tools-not-allowed', /"write"/);
  refuseTools(effectiveTools(profile, ['write', 'edit']), 'tools-not-allowed', /"write"/, 'the FIRST offending tool');
});

function refuseTools(
  resolution: ReturnType<typeof effectiveTools>,
  reason: string,
  detail?: RegExp,
  note?: string,
): void {
  if (resolution.ok) assert.fail(`expected a ${reason} refusal, got [${resolution.tools.join(', ')}]${note ? ` (${note})` : ''}`);
  assert.equal(resolution.reason, reason);
  if (detail !== undefined) assert.match(resolution.detail, detail);
}

// ── Steps 3-6 and the narrowing over the wire ──────────────────────────────

type Wire = { env: Env; runDir: string; root: string };

/** A temp tree with an XDG profile layer, a policy, a run dir and one real root,
 *  which is also the launch dir. */
function mintWire(options: { documents?: Record<string, string>; policy?: Record<string, unknown> } = {}): Wire {
  const dir = mkdtempSync(join(tmpdir(), 'quotient-wire-'));
  writeProfiles(xdgProfileLayer(dir), options.documents ?? { read: document() });
  const root = join(dir, 'root');
  mkdirSync(root);
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(validPolicy({ roots: [root], ...(options.policy ?? {}) }), null, 2));
  return { env: launchEnv(dir), runDir: join(dir, 'run'), root };
}

async function drive(args: Record<string, unknown>, wire: Wire): Promise<Record<string, any>> {
  const { replies } = await converse([callLine(1, args)], wire.env, { launchDir: wire.root });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].error, undefined, 'a refusal is a tool result, never a JSON-RPC error');
  return JSON.parse(replies[0].result.content[0].text);
}

test('a call that clears steps 3-6 reaches the run, with an absent cwd taken from the launch directory', async () => {
  const wire = mintWire();
  const doc = await drive({ prompt: 'review this', profile: 'read', tools: ['read', 'bash'] }, wire);
  assert.equal(doc.state, 'failed');
  assert.equal(doc.termination, 'spawn');
  // The run was reached: step 8 passed, a run directory exists, and its `spawn`
  // record names the root the absent `cwd` resolved to through the launch
  // directory and the policy's allowlist.
  assert.ok(doc.artifacts !== null);
  const audit = readFileSync(doc.artifacts.audit, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(audit[0].record, 'spawn');
  assert.equal(audit[0].root, realpathSync(wire.root));
  // The snapshot it ran under, and the document that won, are audited.
  const layer = xdgProfileLayer(dirname(wire.root));
  assert.equal(audit[0].profile_source, join(layer, 'read.md'));
  const snapshot = loadProfiles([join(wire.root, '.quotient', 'profiles'), layer]);
  assert.equal(audit[0].profile_digest, snapshot.ok && snapshot.snapshot.digest);
});

test('the profile refusals reach the caller as tool results, in grammar -> snapshot -> map -> capability order', async () => {
  const wire = mintWire();

  const malformed = await drive({ prompt: 'hi', profile: 'read/', cwd: wire.root }, wire);
  assert.equal(malformed.refusal.reason, 'profile-invalid');
  assert.match(malformed.refusal.detail, /read\//);

  const unknown = await drive({ prompt: 'hi', profile: 'ghost', cwd: wire.root }, wire);
  assert.equal(unknown.refusal.reason, 'profile-unknown');

  const listed = await drive({ prompt: 'hi', profile: 'read', cwd: wire.root }, wire);
  assert.equal(listed.state, 'failed', 'the same name is admitted once the policy lists it');

  const restricted = mintWire({ policy: { profiles: {} } });
  const refused = await drive({ prompt: 'hi', profile: 'read', cwd: restricted.root }, restricted);
  assert.equal(refused.refusal.reason, 'profile-not-allowed');

  const elevated = mintWire({ policy: { profiles: { read: 'write' } } });
  const mismatch = await drive({ prompt: 'hi', profile: 'read', cwd: elevated.root }, elevated);
  assert.equal(mismatch.refusal.reason, 'profile-capability-mismatch');
  assert.equal(attempts(elevated.runDir).at(-1)?.reason, 'profile-capability-mismatch', 'the refusal is in the ledger');
});

test('a root outside the allowlist, or missing, refuses before the seam', async () => {
  const wire = mintWire();

  const missing = await drive({ prompt: 'hi', profile: 'read', cwd: join(wire.root, 'absent') }, wire);
  assert.equal(missing.refusal.reason, 'root-missing');

  const outside = await drive({ prompt: 'hi', profile: 'read', cwd: '/tmp' }, wire);
  assert.equal(outside.refusal.reason, 'root-not-allowlisted');
});

test('a capability with no wrapper form refuses wrapper-unavailable', async () => {
  const wire = mintWire({
    documents: { read: document(), write: document({ filesystem: 'write' }) },
    policy: { forms: { read: '/nix/store/aaa/bin/pi-mcp-read' } },
  });
  const doc = await drive({ prompt: 'hi', profile: 'write', cwd: wire.root }, wire);
  assert.equal(doc.refusal.reason, 'wrapper-unavailable');
  assert.match(doc.refusal.detail, /write/);
});

test('a ceiling above a policy maximum is refused, naming the unit and both numbers', async () => {
  const wire = mintWire();
  const doc = await drive({ prompt: 'hi', profile: 'read', cwd: wire.root, ceilings: { tokens: 100001 } }, wire);
  assert.equal(doc.refusal.reason, 'ceiling-above-maximum');
  assert.match(doc.refusal.detail, /tokens/);
  assert.match(doc.refusal.detail, /100001/);
  assert.match(doc.refusal.detail, /100000/);

  const clamped = await drive({ prompt: 'hi', profile: 'read', cwd: wire.root, ceilings: { tokens: 10 } }, wire);
  assert.equal(clamped.state, 'failed', 'a ceiling at or below the maximum is clamped, not refused');
});

test('a profile naming an mcp__ tool under a form with no builtin:mcp extension refuses profile-invalid', async () => {
  const documents = { read: document({ tools: 'read, mcp__doctrine__search' }) };
  const withoutExtension = mintWire({ documents });
  const refused = await drive({ prompt: 'hi', profile: 'read', cwd: withoutExtension.root }, withoutExtension);
  assert.equal(refused.refusal.reason, 'profile-invalid');
  assert.match(refused.refusal.detail, /builtin:mcp/);

  const withExtension = mintWire({
    documents,
    policy: { forms: { read: { path: '/nix/store/aaa/bin/pi-mcp-read', extensions: ['builtin:mcp'] } } },
  });
  const admitted = await drive({ prompt: 'hi', profile: 'read', cwd: withExtension.root }, withExtension);
  assert.equal(admitted.state, 'failed', 'the form that passes -e builtin:mcp admits the same profile');
});

test('a widening tools request is refused tools-not-allowed before the seam, naming the first offending tool', async () => {
  const wire = mintWire();
  const doc = await drive({ prompt: 'hi', profile: 'read', cwd: wire.root, tools: ['read', 'write'] }, wire);
  assert.equal(doc.refusal.reason, 'tools-not-allowed');
  assert.match(doc.refusal.detail, /"write"/);
  assert.match(doc.refusal.detail, /read/, 'the detail names the profile so the operator can find it');

  const lines = attempts(wire.runDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'tools-not-allowed');
  assert.match(String(lines[0].policy_digest), /^[0-9a-f]{64}$/);
});
