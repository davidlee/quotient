// The package's own location. This module sits one level below the package
// root in both trees — src/root.ts and dist/root.js — so the root is the parent
// of its directory. package.json and help/ resolve from it.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { at } from './json.ts';

export const packageRoot: string = dirname(dirname(fileURLToPath(import.meta.url)));

/** The version package.json declares. Read on each call: no I/O at import. */
export function packageVersion(): string {
  const manifest = join(packageRoot, 'package.json');
  const version: unknown = at(JSON.parse(readFileSync(manifest, 'utf8')), 'version');
  if (typeof version !== 'string') {throw new Error(`${manifest} declares no version`);}
  return version;
}

/** The absolute path the running bin was invoked by (`process.argv[1]`), for the
 *  client snippets. Symlinks are kept: a stable link outlives its target. */
export function runningBin(): string {
  return resolve(process.argv[1] ?? '');
}
