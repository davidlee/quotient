// The approvals store (design sec-2 "The approvals store"): the closed-world
// reader, the containment lookup and the one locked atomic writer.
//
// Every case builds its own temp store: nothing reads the ambient environment and
// nothing is spawned. The writer's collision cases are decided by a lock file the
// case holds itself, so no case waits for a second process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { APPROVALS_SCHEMA, governingApproval, readApprovals, updateApprovals, type Approval } from './approvals.ts';

/** A temp directory and the store path in it. Nothing is created at the path. */
function store(): string {
  return join(mkdtempSync(join(tmpdir(), 'quotient-approvals-')), 'approvals.json');
}

/** One valid entry, with the case's overrides. */
const approval = (overrides: Partial<Approval> = {}): Approval => ({
  root: '/work/one',
  capability: 'write',
  path: '/nix/store/abc-quotient-write',
  sha256: 'a'.repeat(64),
  approved_at: '2026-10-24T05:12:44.000Z',
  ...overrides,
});

/** A store document in the shape the writer publishes, over raw entries. */
const document = (approvals: unknown[]): string =>
  `${JSON.stringify({ schema: APPROVALS_SCHEMA, approvals }, null, 2)}\n`;

/** The detail of a store the reader must refuse, asserting it names the path. */
function refusal(path: string): string {
  const read = readApprovals(path);
  assert.equal(read.ok, false, `the store at ${path} must be refused`);
  assert.ok(read.detail.includes(path), `the detail names the store: ${read.detail}`);
  return read.detail;
}

/** The reader refuses TEXT, with a detail saying WHY. */
function refusedText(text: string, why: string): void {
  const path = store();
  writeFileSync(path, text);
  const detail = refusal(path);
  assert.ok(detail.includes(why), `the detail says "${why}": ${detail}`);
}

/** The entries of the store at PATH, asserting the reader admits it. */
function stored(path: string): Approval[] {
  const read = readApprovals(path);
  assert.equal(read.ok, true, read.ok ? '' : read.detail);
  return read.approvals;
}

/** The reader admits TEXT and returns its entries. */
function admittedText(text: string): Approval[] {
  const path = store();
  writeFileSync(path, text);
  return stored(path);
}

// ── The reader (EX-2, VT-1) ────────────────────────────────────────────────

test('readApprovals: an absent store is an empty store; a valid one round-trips its five fields', () => {
  const path = store();
  assert.equal(existsSync(path), false);
  const empty = readApprovals(path);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.approvals, []);

  const entry = approval();
  assert.deepEqual(admittedText(document([entry])), [entry]);
  // One entry per root and capability: a second capability is a second entry.
  const read = admittedText(document([entry, approval({ capability: 'read', root: '/work/two' })]));
  assert.deepEqual(read.map((item) => [item.root, item.capability]), [['/work/one', 'write'], ['/work/two', 'read']]);
});

test('readApprovals: an unreadable store is refused, naming the path', () => {
  const path = store();
  mkdirSync(path);
  assert.ok(refusal(path).includes('could not be read'));
});

test('readApprovals: the document is closed-world — JSON, an object, the schema, no unknown key, an approvals array', () => {
  refusedText('{\n', 'not valid JSON');
  refusedText('[]', 'not a JSON object');
  refusedText(JSON.stringify({ schema: 'quotient-approvals/2', approvals: [] }), 'is not one this build reads');
  refusedText(JSON.stringify({ approvals: [] }), 'missing approvals field: schema');
  refusedText(
    JSON.stringify({ schema: APPROVALS_SCHEMA, approvals: [], note: 'mine' }),
    'unknown approvals field: note',
  );
  refusedText(JSON.stringify({ schema: APPROVALS_SCHEMA }), 'missing approvals field: approvals');
  refusedText(JSON.stringify({ schema: APPROVALS_SCHEMA, approvals: {} }), 'approvals must be an array');
  refusedText(document(['write']), 'approvals[0] is not an object');
});

test('readApprovals: an entry is closed-world — no unknown key, no missing key', () => {
  refusedText(document([{ ...approval(), comment: 'a friend' }]), 'approvals[0]: unknown key "comment"');
  const { root, capability, path, approved_at: approvedAt } = approval();
  refusedText(document([{ root, capability, path, approved_at: approvedAt }]), 'approvals[0]: missing key "sha256"');
});

test('readApprovals: a non-absolute root or path, a capability outside read/write, a bad digest, a non-string approved_at are refused', () => {
  refusedText(document([approval({ root: 'work/one' })]), 'root must be a canonical absolute path string');
  refusedText(document([approval({ path: 'nix/store/abc' })]), 'path must be a canonical absolute path string');
  for (const capability of ['exec', '', 'Write']) {
    refusedText(document([{ ...approval(), capability }]), 'capability must be "read" or "write"');
  }
  for (const sha256 of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}g`]) {
    refusedText(document([approval({ sha256 })]), 'sha256 must be 64 lowercase hex characters');
  }
  refusedText(document([{ ...approval(), approved_at: 1729751564 }]), 'approved_at must be a string');
});

test('readApprovals: a root or path that is not canonical is refused, so one root is one key', () => {
  for (const root of ['/work/one/', '/work/./one', '/work//one', '/work/two/../one', '//work/one']) {
    refusedText(document([approval({ root })]), 'root must be a canonical absolute path string');
  }
  for (const path of ['/nix/store/abc-quotient-write/', '/nix//store/abc', '/nix/store/../store/abc']) {
    refusedText(document([approval({ path })]), 'path must be a canonical absolute path string');
  }
});

test('readApprovals: a duplicate (root, capability) pair is refused, and the same root under another capability is not', () => {
  refusedText(
    document([approval(), approval({ path: '/nix/store/def-quotient-write' })]),
    'approvals[1]: duplicate entry for the root "/work/one" and the capability "write"',
  );
  assert.equal(admittedText(document([approval(), approval({ capability: 'read' })])).length, 2);
});

// ── `governingApproval` (EX-3, VT-2) ───────────────────────────────────────

test('governingApproval: the deepest approval root containing the call root governs', () => {
  const shallow = approval({ root: '/work' });
  const deep = approval({ root: '/work/one' });
  for (const approvals of [[shallow, deep], [deep, shallow]]) {
    assert.equal(governingApproval(approvals, '/work/one', 'write'), deep);
    assert.equal(governingApproval(approvals, join('/work/one', 'sub'), 'write'), deep);
    // Outside the deeper root the shallower one governs: containment, not a prefix.
    assert.equal(governingApproval(approvals, '/work/two', 'write'), shallow);
  }
});

test('governingApproval: the capability filters, and a sibling prefix is not containment', () => {
  const read = approval({ capability: 'read' });
  assert.equal(governingApproval([read], '/work/one', 'write'), undefined);
  assert.equal(governingApproval([read], '/work/one', 'read'), read);

  // `/work/oneevil` shares the text of `/work/one` and names nothing inside it.
  assert.equal(governingApproval([approval()], '/work/oneevil', 'write'), undefined);
  // An approval inside the call root does not govern it: only a containing root does.
  assert.equal(governingApproval([approval()], '/work', 'write'), undefined);
  assert.equal(governingApproval([], '/work/one', 'write'), undefined);
});

// ── The writer (EX-4, VT-3) ────────────────────────────────────────────────

/** The store's bytes, for a failed write that must leave them untouched. */
const bytes = (path: string): string => readFileSync(path, 'utf8');

test('updateApprovals: a held lock fails the writer, naming the holder and the manual removal, and leaves the store untouched', () => {
  const path = store();
  writeFileSync(path, document([approval()]));
  const before = bytes(path);
  writeFileSync(`${path}.lock`, '4242\n');

  const result = updateApprovals(path, () => [approval({ root: '/work/two' })]);
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes(`${path}.lock`), `the detail names the lock: ${result.detail}`);
  assert.ok(result.detail.includes('pid 4242'), `the detail names the holder: ${result.detail}`);
  assert.ok(result.detail.includes('remove'), `the detail says what to do: ${result.detail}`);

  // No automatic reclaim: the store is untouched and the lock is still the case's.
  assert.equal(bytes(path), before);
  assert.equal(existsSync(`${path}.lock`), true);
});

test('updateApprovals: a malformed store is never overwritten, and the change never runs', () => {
  const path = store();
  const malformed = '{"schema":"quotient-approvals/1"}';
  writeFileSync(path, malformed);

  let ran = false;
  const result = updateApprovals(path, () => {
    ran = true;
    return [approval()];
  });
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes(path) && result.detail.includes('missing approvals field: approvals'), result.detail);
  assert.equal(ran, false, 'a store that cannot be read decides nothing');
  assert.equal(bytes(path), malformed);
  assert.equal(existsSync(`${path}.lock`), false, 'the lock is released when the read fails');
});

test('updateApprovals: a string from CHANGE aborts with that detail and writes nothing', () => {
  const path = store();
  writeFileSync(path, document([approval()]));
  const before = bytes(path);

  const result = updateApprovals(path, () => 'the form changed between the review and the record');
  assert.deepEqual(result, { ok: false, detail: 'the form changed between the review and the record' });
  assert.equal(bytes(path), before);
  assert.equal(existsSync(`${path}.lock`), false);
});

test('updateApprovals: a CHANGE that throws releases the lock, writes nothing, and leaves no stale lock behind', () => {
  const path = store();
  writeFileSync(path, document([approval()]));
  const before = bytes(path);

  assert.throws(
    () =>
      updateApprovals(path, () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(bytes(path), before);
  assert.equal(existsSync(`${path}.lock`), false, 'the lock is unlinked in finally');
  // No stale lock to reclaim: the next writer just runs.
  assert.deepEqual(updateApprovals(path, () => [approval({ root: '/work/two' })]), { ok: true });
});

test('updateApprovals: change sees the stored list under the lock, and the publish is one rename — mode 0600, no lock or tmp left', () => {
  const path = store();
  writeFileSync(path, document([approval()]));

  let seen: Approval[] = [];
  let listed: string[] = [];
  let midBytes = '';
  const result = updateApprovals(path, (current) => {
    seen = current;
    listed = readdirSync(dirname(path));
    midBytes = bytes(path);
    return [approval({ root: '/work/two' }), ...current];
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen.map((entry) => entry.root), ['/work/one'], 'the change reads what the store holds');
  assert.equal(midBytes, document([approval()]), 'the store is not truncated in place under the change');
  assert.deepEqual(listed.filter((name) => name.endsWith('.tmp')), [], 'nothing is published before the change returns');
  assert.equal(statSync(path).mode & 0o777, 0o600, 'the published store is private to its operator');
  assert.deepEqual(readdirSync(dirname(path)), ['approvals.json'], 'no lock and no tmp survive the publish');
  assert.deepEqual(stored(path).map((entry) => entry.root), ['/work/two', '/work/one']);
});

test('updateApprovals: a planted tmp file is replaced, not reused, so the published mode is 0600', () => {
  const path = store();
  writeFileSync(path, document([approval()]));
  const planted = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(planted, 'planted\n');
  chmodSync(planted, 0o666);

  assert.deepEqual(updateApprovals(path, () => [approval({ root: '/work/two' })]), { ok: true });
  assert.equal(statSync(path).mode & 0o777, 0o600, 'the published store is private to its operator');
  assert.deepEqual(stored(path).map((entry) => entry.root), ['/work/two']);
});

test('updateApprovals: a planted tmp symlink is replaced, never written through', () => {
  const path = store();
  const dir = dirname(path);
  writeFileSync(path, document([approval()]));
  const target = join(dir, 'planted-target');
  writeFileSync(target, 'untouched\n');
  symlinkSync(target, `${path}.${String(process.pid)}.tmp`);

  assert.deepEqual(updateApprovals(path, () => [approval({ root: '/work/two' })]), { ok: true });
  assert.equal(readFileSync(target, 'utf8'), 'untouched\n', 'the planted target is not written through');
  assert.equal(lstatSync(path).isSymbolicLink(), false, 'the store is a real file, not a planted link');
  assert.deepEqual(stored(path).map((entry) => entry.root), ['/work/two']);
});

test('updateApprovals: a CHANGE returning a store this build would refuse aborts with its detail and writes nothing', () => {
  const path = store();
  writeFileSync(path, document([approval()]));
  const before = bytes(path);

  const duplicate = updateApprovals(path, () => [approval(), approval()]);
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.detail.includes('duplicate entry'), duplicate.detail);
  assert.equal(bytes(path), before);

  const nonCanonical = updateApprovals(path, () => [approval({ root: '/work/one/' })]);
  assert.equal(nonCanonical.ok, false);
  assert.ok(nonCanonical.detail.includes('root must be a canonical absolute path string'), nonCanonical.detail);
  assert.equal(bytes(path), before);
  assert.equal(existsSync(`${path}.lock`), false, 'no lock survives a refused change');
});

test('updateApprovals: a publish that cannot land unlinks its tmp and its lock', () => {
  const path = store();
  const dir = dirname(path);
  writeFileSync(path, document([approval()]));

  assert.throws(
    () =>
      updateApprovals(path, () => {
        // The store becomes a non-empty directory between the read and the rename, so
        // the publish cannot land — after the tmp file has already been written.
        rmSync(path);
        mkdirSync(path);
        writeFileSync(join(path, 'child'), 'x');
        return [approval({ root: '/work/two' })];
      }),
    /EISDIR|ENOTEMPTY|EEXIST/,
  );
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'no tmp survives a failed publish');
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.lock')), [], 'no lock survives a failed publish');
});

test('updateApprovals: the lock is removed only while it still carries this writer\'s pid', () => {
  const path = store();
  writeFileSync(path, document([approval()]));
  const lock = `${path}.lock`;

  const result = updateApprovals(path, (current) => {
    // Another writer replaces the lock in place: it is then not ours to remove.
    writeFileSync(lock, '4242\n');
    return [...current, approval({ root: '/work/two' })];
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(existsSync(lock), true, 'a lock that is no longer ours is left alone');
  assert.equal(readFileSync(lock, 'utf8').trim(), '4242');
});

test('updateApprovals: what it publishes is what the reader admits; a first write creates the store and the directory', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'quotient-approvals-')), 'nested', 'quotient', 'approvals.json');
  assert.deepEqual(updateApprovals(path, () => [approval()]), { ok: true });
  assert.deepEqual(stored(path), [approval()]);

  // An empty list is a valid store, not a deleted file: a revoke leaves the document.
  assert.deepEqual(updateApprovals(path, () => []), { ok: true });
  assert.deepEqual(stored(path), []);
});
