import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageRoot, packageVersion } from './root.ts';

const CHECKOUT = realpathSync(new URL('..', import.meta.url).pathname);
const TSC = join(CHECKOUT, 'node_modules', 'typescript', 'bin', 'tsc');

const versionIn = (dir: string): string => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;

test('packageRoot is the checkout from the source tree, and packageVersion reads its package.json', () => {
  assert.equal(packageRoot, CHECKOUT);
  assert.equal(packageVersion(), versionIn(CHECKOUT));
});

test('packageRoot is the package directory from a tsc-built dist tree', (t) => {
  const pkg = mkdtempSync(join(tmpdir(), 'quotient-root-'));
  t.after(() => { rmSync(pkg, { recursive: true, force: true }); });
  execFileSync(process.execPath, [TSC, '-p', join(CHECKOUT, 'tsconfig.build.json'), '--outDir', join(pkg, 'dist')]);
  copyFileSync(join(CHECKOUT, 'package.json'), join(pkg, 'package.json'));

  const probe = `import { packageRoot, packageVersion } from ${JSON.stringify(join(pkg, 'dist', 'root.js'))};
process.stdout.write(JSON.stringify({ packageRoot, version: packageVersion() }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' }));
  assert.deepEqual(out, { packageRoot: realpathSync(pkg), version: versionIn(pkg) });
});
