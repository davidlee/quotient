// The bin's dispatch table (design sec-2): each verb reaches its handler with
// its exit code. The reducer's own behaviour is reduce.test.ts's; the server's
// is server.test.ts's. Both drive this same entry point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageRoot, packageVersion } from './root.ts';
import { validPolicy, workspace, xdgHelpLayer } from './server/test-rig.ts';
import type { Env } from './server/test-rig.ts';

const CLI = new URL('./cli.ts', import.meta.url).pathname;

/** A temp HOME and launch dir, so no run reads the operator's own config. */
function hermetic(): { env: Env; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), 'quotient-cli-home-'));
  const cwd = join(dir, 'launch');
  mkdirSync(cwd);
  return { env: { PATH: process.env.PATH, HOME: dir }, cwd };
}

function quotient(
  args: string[],
  input = '',
  { env, cwd } = hermetic(),
): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', timeout: 30000, env, cwd });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

test('--version prints the package version and exits 0', () => {
  const { status, stdout } = quotient(['--version']);
  assert.equal(status, 0);
  assert.equal(stdout, `${packageVersion()}\n`);
});

test('an unknown verb prints usage on stderr and exits 2', () => {
  for (const verb of ['serve', 'frobnicate', '-x']) {
    const { status, stdout, stderr } = quotient([verb]);
    assert.equal(status, 2, verb);
    assert.equal(stdout, '');
    assert.match(stderr, /^usage: quotient/m);
  }
});

test('reduce passes the rest of argv to the reducer and returns its exit code', () => {
  const usage = quotient(['reduce', '--budget-bytes', 'lots']);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^quotient reduce: --budget-bytes needs a non-negative integer/m);
  assert.match(usage.stderr, /^usage: quotient reduce/m);

  // An empty stream never settles: incomplete, so 1.
  const incomplete = quotient(['reduce', '--out', mkdtempSync(join(tmpdir(), 'quotient-cli-')), '-q'], '');
  assert.equal(incomplete.status, 1);
});

test('help lists the sections; an unknown section exits 2', () => {
  const list = quotient(['help']);
  assert.equal(list.status, 0);
  for (const section of ['agent', 'tool', 'result', 'policy', 'form', 'profiles', 'setup', 'clients', 'reduce']) {
    assert.match(list.stdout, new RegExp(`^  ${section}\\b`, 'm'));
  }
  assert.equal(quotient(['help', 'policy']).status, 0);
  const unknown = quotient(['help', 'nonesuch']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /nonesuch/);
});

test('help prints a contract section verbatim; refusals is result', () => {
  const policy = quotient(['help', 'policy']);
  assert.equal(policy.stdout, readFileSync(join(packageRoot, 'docs/contract/quotient-policy-1.md'), 'utf8'));
  assert.equal(quotient(['help', 'refusals']).stdout, quotient(['help', 'result']).stdout);
});

test('help clients prints both snippets with the running bin and the policy timeout', () => {
  const { env, dir } = workspace(validPolicy());
  const cwd = join(dir, 'launch');
  mkdirSync(cwd);
  const { status, stdout } = quotient(['help', 'clients'], '', { env: { ...env, PATH: process.env.PATH }, cwd });
  assert.equal(status, 0);
  const bin = JSON.stringify(realpathSync(CLI));
  assert.ok(stdout.includes(`"command": ${bin}`), 'the Claude Code snippet names the bin');
  assert.ok(stdout.includes(`command = ${bin}`), 'the Codex snippet names the bin');
  assert.ok(stdout.includes(`cwd = ${JSON.stringify(cwd)}`));
  assert.match(stdout, /^tool_timeout_sec = 660 /m);
});

test('help with an unreadable help layer exits 1 and names it', () => {
  const { env, dir } = workspace();
  const layer = xdgHelpLayer(dir);
  mkdirSync(join(layer, '..'), { recursive: true });
  symlinkSync(join(tmpdir(), 'quotient-no-such-target'), layer);
  const { status, stderr } = quotient(['help', 'setup'], '', { env: { ...env, PATH: process.env.PATH }, cwd: dir });
  assert.equal(status, 1);
  assert.ok(stderr.includes(layer));
});

test('help still prints when the profile snapshot does not load, and says so', () => {
  const { env, dir } = workspace();
  const profiles = join(dir, 'launch', '.quotient', 'profiles');
  mkdirSync(profiles, { recursive: true });
  writeFileSync(join(profiles, 'bad.md'), 'no header\n');
  const { status, stdout, stderr } = quotient(['help', 'profiles'], '', { env: { ...env, PATH: process.env.PATH }, cwd: join(dir, 'launch') });
  assert.equal(status, 0);
  assert.equal(stdout, readFileSync(join(packageRoot, 'help/profiles.md'), 'utf8'));
  assert.ok(stderr.includes(join(profiles, 'bad.md')), 'the broken document is named');
});
