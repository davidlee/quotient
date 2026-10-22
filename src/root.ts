// The package's own location. This module sits one level below the package
// root in both trees — src/root.ts and dist/root.js — so the root is the parent
// of its directory. package.json and help/ resolve from it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot: string = dirname(dirname(fileURLToPath(import.meta.url)));

/** The version package.json declares. Read on each call: no I/O at import. */
export function packageVersion(): string {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
}
