// The bin's dispatch table (design sec-2): each verb reaches its handler with
// its exit code. The reducer's own behaviour is reduce.test.ts's; the server's
// is server.test.ts's. Both drive this same entry point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageVersion } from './root.ts';

const CLI = new URL('./cli.ts', import.meta.url).pathname;

function quotient(args: string[], input = ''): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', timeout: 30000 });
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
