// The bin's dispatch table (design sec-2): each verb reaches its handler with
// its exit code. The reducer's own behaviour is reduce.test.ts's; the server's
// is server.test.ts's. Both drive this same entry point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageRoot, packageVersion } from './root.ts';
import { readApprovals } from './server/approvals.ts';
import {
  newRig,
  plantProjectForm,
  rigApprovalsPath,
  rigForm,
  validPolicy,
  workspace,
  xdgHelpLayer,
  xdgProfileLayer,
  type Env,
} from './server/test-rig.ts';

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
  { env, cwd, script = CLI }: { env: Env; cwd: string; script?: string } = hermetic(),
): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', timeout: 30000, env, cwd });
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
  for (const section of ['agent', 'tool', 'orchestrate', 'result', 'policy', 'form', 'profiles', 'setup', 'clients', 'reduce']) {
    assert.match(list.stdout, new RegExp(`^  ${section}\\b`, 'm'));
  }
  assert.equal(quotient(['help', 'policy']).status, 0);
  const unknown = quotient(['help', 'nonesuch']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /nonesuch/);
});

test('help prints a contract section verbatim; refusals is result', () => {
  const policy = quotient(['help', 'policy']);
  assert.equal(policy.stderr, '', 'a clean launch dir warns about nothing');
  assert.equal(policy.stdout, readFileSync(join(packageRoot, 'docs/contract/quotient-policy-2.md'), 'utf8'));
  const result = quotient(['help', 'result']);
  assert.equal(result.stdout, readFileSync(join(packageRoot, 'docs/contract/pi-agent-result-2.md'), 'utf8'));
  assert.equal(quotient(['help', 'refusals']).stdout, result.stdout);
});

test('help clients prints both snippets with the running bin and the policy timeout', () => {
  const { env, dir } = workspace(validPolicy());
  const cwd = join(dir, 'launch');
  mkdirSync(cwd);
  const { status, stdout } = quotient(['help', 'clients'], '', { env: { ...env, PATH: process.env.PATH }, cwd });
  assert.equal(status, 0);
  const bin = JSON.stringify(CLI);
  assert.ok(stdout.includes(`"command": ${bin}`), 'the Claude Code snippet names the bin');
  assert.ok(stdout.includes(`command = ${bin}`), 'the Codex snippet names the bin');
  assert.ok(stdout.includes(`cwd = ${JSON.stringify(cwd)}`));
  assert.match(stdout, /^tool_timeout_sec = 660 /m);
});

/** The command line `help clients` prints in the Codex snippet. */
const codexCommand = (stdout: string): string | undefined => /^command = (.*)$/m.exec(stdout)?.[1];

test('help clients names the bin by the path it was run as, not its symlink target', () => {
  const { env, dir } = workspace(validPolicy());
  const link = join(dir, 'bin-quotient.ts');
  symlinkSync(CLI, link);
  const { stdout } = quotient(['help', 'clients'], '', { env: { ...env, PATH: process.env.PATH }, cwd: dir, script: link });
  assert.equal(codexCommand(stdout), JSON.stringify(link), 'a stable link survives the target moving');
});

test('help clients names QUOTIENT_LAUNCHER, a wrapper\'s own path, over the script it runs', () => {
  const { env, dir } = workspace(validPolicy());
  const run = (launcher: string) =>
    codexCommand(quotient(['help', 'clients'], '', { env: { ...env, PATH: process.env.PATH, QUOTIENT_LAUNCHER: launcher }, cwd: dir }).stdout);
  assert.equal(run('/opt/quotient/bin/quotient'), JSON.stringify('/opt/quotient/bin/quotient'));
  assert.equal(run('relative/quotient'), JSON.stringify(CLI), 'a relative launcher is ignored');
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
  const profiles = xdgProfileLayer(dir);
  writeFileSync(join(profiles, 'bad.md'), 'no header\n');
  const { status, stdout, stderr } = quotient(['help', 'profiles'], '', { env: { ...env, PATH: process.env.PATH }, cwd: dir });
  assert.equal(status, 0);
  assert.equal(stdout, readFileSync(join(packageRoot, 'help/profiles.md'), 'utf8'));
  assert.ok(stderr.includes(join(profiles, 'bad.md')), 'the broken document is named');
});

test('help warns that a legacy launch-dir layer is refused, and still prints the section', () => {
  for (const kind of ['profiles', 'help'] as const) {
    const { env, dir } = workspace();
    const cwd = join(dir, 'launch');
    const legacy = join(cwd, '.quotient', kind);
    mkdirSync(legacy, { recursive: true });
    const { status, stdout, stderr } = quotient(['help', 'profiles'], '', { env: { ...env, PATH: process.env.PATH }, cwd });
    assert.equal(status, 0, `help still prints with a legacy ${kind} layer`);
    assert.equal(stdout, readFileSync(join(packageRoot, 'help/profiles.md'), 'utf8'), kind);
    assert.ok(stderr.includes(legacy), stderr);
    assert.match(stderr, new RegExp(`quotient no longer reads ${kind} from the launch directory`));
    assert.ok(stderr.includes(`quotient/${kind}/ and restart`), `the destination is named: ${stderr}`);
  }
});

test('allow reports and records a project form, and revoke removes it', (t) => {
  const rig = newRig(t);
  const form = rigForm(rig, 'approved');
  plantProjectForm(rig, form);
  const run = (argv: string[]): { status: number | null; stdout: string; stderr: string } =>
    quotient(argv, '', { env: rig.env, cwd: rig.root });

  const report = run(['allow']);
  assert.equal(report.status, 0, report.stderr);
  assert.ok(report.stdout.includes(`resolves  ${form.path}`), report.stdout);
  assert.ok(report.stdout.includes(`quotient allow ${rig.root} write=${form.path}@${form.sha256}`), report.stdout);
  assert.equal(existsSync(rigApprovalsPath(rig)), false, 'a report never writes');

  const record = run(['allow', rig.root, `write=${form.path}@${form.sha256}`]);
  assert.equal(record.status, 0, record.stderr);
  assert.equal(record.stdout, `recorded write=${form.path}@${form.sha256} for ${rig.root}\n`);
  const stored = readApprovals(rigApprovalsPath(rig));
  assert.equal(stored.ok, true, stored.ok ? '' : stored.detail);
  assert.deepEqual(stored.approvals.map((entry) => entry.path), [form.path]);

  const revoked = run(['revoke', rig.root]);
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.equal(revoked.stdout, `revoked write for ${rig.root}\n`);
  const after = readApprovals(rigApprovalsPath(rig));
  assert.equal(after.ok, true, after.ok ? '' : after.detail);
  assert.deepEqual(after.approvals, []);
});

test('allow and revoke pass their usage errors through as exit 2', () => {
  const { env, cwd } = hermetic();
  for (const argv of [['allow', `write=/nix/store/x@${'a'.repeat(64)}`], ['revoke']]) {
    const { status, stdout, stderr } = quotient(argv, '', { env, cwd });
    assert.equal(status, 2, `${argv.join(' ')}: ${stderr}`);
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`^usage: quotient ${argv[0]}`, 'm'));
  }
});
