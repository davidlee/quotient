// Tests for the per-run evidence sinks: the audit trail, the result document and
// the one layout both live under (design sec-6 "Evidence", EX-5).
//
// Every case builds its own temp run dir: nothing reads the ambient environment
// and nothing is spawned. A sink that cannot write is a fact the caller is told
// (null, `unreadable`, `torn`), never an exception.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { isRecord } from '../json.ts';
import {
  RUN_EVIDENCE_FILES,
  RUN_NAME_GRAMMAR,
  appendAudit,
  layoutFor,
  readAudit,
  readResult,
  runLayout,
  runName,
  writeResult,
  type RunLayout,
} from './evidence.ts';
import { buildResult } from './test-rig.ts';

/** The temp the writer renames away; named here so a residue is provable. */
const TMP = '.result.json.tmp';

/** A fresh temp tree; the run dir under it is only ever named, never created. */
function runDir(): string {
  return mkdtempSync(join(tmpdir(), 'quotient-evidence-'));
}

/** One run's layout in a fresh temp tree. */
function layout(): RunLayout {
  return runLayout(runDir(), 7);
}

/** One JSONL line, as the record it must be. */
function parseLine(line: string | undefined, context: string): Record<string, unknown> {
  assert.ok(line !== undefined, `${context}: missing line`);
  const value: unknown = JSON.parse(line);
  assert.ok(isRecord(value), `${context}: not a JSON object: ${line}`);
  return value;
}

/** A JSONL file's records, in order. */
function jsonLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => parseLine(line, path));
}

/** A run dir holding `text` as its result.json, for the reader's failure cases. */
function seeded(root: string, callId: number, text: string): RunLayout {
  const l = runLayout(root, callId);
  mkdirSync(l.dir, { recursive: true });
  writeFileSync(l.result, text);
  return l;
}

/** The layout's path for one `RUN_EVIDENCE_FILES` key; six keys, not five. */
function fileOf(l: RunLayout, key: string): string | undefined {
  const paths: Record<string, string | undefined> = {
    events: l.events,
    stderr: l.stderr,
    transcript: l.transcript,
    status: l.status,
    audit: l.audit,
    result: l.result,
  };
  return paths[key];
}

test('appendAudit returns the ts it wrote and null when the run directory cannot be created', () => {
  const l = layout();
  const ts = appendAudit(l, { record: 'spawn', n: 1 });
  assert.ok(ts !== null, 'a landed record reports its timestamp');
  assert.ok(!Number.isNaN(Date.parse(ts)), `the returned value is a date: ${ts}`);
  const last = jsonLines(l.audit).at(-1);
  assert.ok(last !== undefined, 'the audit holds the record');
  assert.equal(last.ts, ts, 'the returned value is the ts the line carries');

  const claimed = appendAudit(l, { record: 'admitted', ts: 'a caller timestamp' });
  assert.equal(jsonLines(l.audit).at(-1)?.ts, claimed, 'the server stamps the record; a caller ts does not replace it');

  // A regular file where the run dir should be makes mkdir fail: still no throw.
  const blocker = join(runDir(), 'not-a-dir');
  writeFileSync(blocker, 'occupied');
  assert.equal(
    appendAudit(layoutFor(blocker, runName(1)), { record: 'spawn' }),
    null,
    'an unwritable run dir is reported as null',
  );
});

test('after a torn partial line the next audit record still gets its own line, and the record before the tear survives', () => {
  const l = layout();
  mkdirSync(l.dir, { recursive: true });
  const first = appendAudit(l, { record: 'spawn', n: 1 });
  assert.ok(first !== null);
  appendFileSync(l.audit, '{"ts":"x","rec');

  const second = appendAudit(l, { record: 'admitted', n: 2 });
  assert.ok(second !== null);

  const lines = readFileSync(l.audit, 'utf8').split('\n');
  assert.equal(lines.length, 4, 'two records and the torn fragment, each on its own line');
  assert.equal(lines.at(-1), '', 'the file ends in a newline');
  assert.equal(lines[1], '{"ts":"x","rec', 'the fragment was not glued to the record after it');
  assert.deepEqual(parseLine(lines.at(-2), 'the appended record'), { ts: second, record: 'admitted', n: 2 });

  const audit = readAudit(l);
  assert.ok(audit !== null);
  assert.equal(audit.torn, true, 'the skipped fragment is reported, not hidden');
  assert.deepEqual(audit.records, [
    { ts: first, record: 'spawn', n: 1 },
    { ts: second, record: 'admitted', n: 2 },
  ]);
});

test('an audit whose tail cannot be inspected still gets the record on a line of its own', () => {
  const l = layout();
  appendAudit(l, { record: 'spawn' });
  appendFileSync(l.audit, '{"ts":"x","rec');
  chmodSync(l.audit, 0o200); // writable, not readable: the last byte cannot be checked
  try {
    assert.ok(appendAudit(l, { record: 'lost' }) !== null);
  } finally {
    chmodSync(l.audit, 0o600);
  }
  const audit = readAudit(l);
  assert.ok(audit !== null);
  assert.deepEqual(audit.records.map((r) => r.record), ['spawn', 'lost'], 'the record after the tear is not glued to it');
});

test('readAudit: a clean audit reads in order with torn false, and a missing or unreadable audit is null', () => {
  const l = layout();
  for (const record of ['spawn', 'cancelled', 'dropped', 'lost', 'refused'] as const) {
    appendAudit(l, { record });
  }
  const audit = readAudit(l);
  assert.ok(audit !== null);
  assert.equal(audit.torn, false, 'nothing was skipped');
  assert.deepEqual(audit.records.map((r) => r.record), ['spawn', 'cancelled', 'dropped', 'lost', 'refused']);

  assert.equal(readAudit(layout()), null, 'a run that wrote nothing has no audit');

  const asDir = layout();
  mkdirSync(asDir.audit, { recursive: true });
  assert.equal(readAudit(asDir), null, 'a path that is a directory cannot be read');
});

test('readResult: absent when none was written, found for a written document, unreadable for garbage, a conformance failure, a directory or a dangling link', () => {
  assert.equal(readResult(layout()), 'absent', 'a run that wrote no result is absent, not unreadable');

  const root = runDir();
  const l = runLayout(root, 3);
  const { doc } = buildResult();
  const writtenAt = writeResult(l, doc);
  assert.ok(writtenAt !== null);
  assert.deepEqual(readResult(l), { found: doc, writtenAt }, 'the document and the moment it landed come back together');

  assert.equal(readResult(seeded(root, 4, 'not json at all')), 'unreadable');
  assert.equal(readResult(seeded(root, 5, '{}')), 'unreadable', 'JSON that fails conformance is unreadable, not found');
  const hostile = '{"schema":"pi-agent-result/2","state":{"toString":null}}';
  assert.equal(readResult(seeded(root, 9, hostile)), 'unreadable', 'a document the validator chokes on is unreadable, not a throw');

  const asDir = runLayout(root, 6);
  mkdirSync(asDir.result, { recursive: true });
  assert.equal(readResult(asDir), 'unreadable', 'a result path that is a directory cannot be read');

  const dangling = runLayout(root, 8);
  mkdirSync(dangling.dir, { recursive: true });
  symlinkSync(join(dangling.dir, 'gone'), dangling.result);
  assert.equal(readResult(dangling), 'unreadable', 'a dangling link is a broken entry, not an absent one');
});

test('writeResult: a success leaves pretty JSON and no temp file, and a rename that cannot land leaves no residue', () => {
  const l = layout();
  mkdirSync(l.dir, { recursive: true });
  const { doc } = buildResult();
  const writtenAt = writeResult(l, doc);
  assert.ok(writtenAt !== null);
  assert.ok(existsSync(l.result), 'the document is on disk');
  assert.ok(readFileSync(l.result, 'utf8').includes('\n  '), 'the document is pretty-printed');
  assert.deepEqual(readdirSync(l.dir), [RUN_EVIDENCE_FILES.result], 'the temp was renamed away, not left behind');

  // The commit is a rename, never a write in place: a name hard-linked to the
  // old result.json keeps the old bytes, which a write through it would change.
  const replaced = layout();
  mkdirSync(replaced.dir, { recursive: true });
  const old = join(replaced.dir, 'old-result');
  writeFileSync(old, 'the previous bytes');
  linkSync(old, replaced.result);
  assert.ok(writeResult(replaced, doc) !== null);
  assert.equal(readFileSync(old, 'utf8'), 'the previous bytes', 'result.json was replaced, not written through');
  assert.equal(readResult(replaced) !== 'absent' && readResult(replaced) !== 'unreadable', true, 'the new document reads');

  // A non-empty directory in the way: the rename cannot land over it.
  const blocked = layout();
  mkdirSync(join(blocked.result, 'keep'), { recursive: true });
  assert.equal(writeResult(blocked, doc), null, 'a rename that cannot land is reported, not thrown');
  assert.ok(statSync(blocked.result).isDirectory(), 'nothing was written over the obstacle');
  assert.deepEqual(readdirSync(blocked.dir), [RUN_EVIDENCE_FILES.result], `no ${TMP} and no partial result remain`);
});

test('RUN_NAME_GRAMMAR accepts every name runName mints and refuses traversal, separators and empty ids', () => {
  const minted = [1, 'abc', null, '../../etc', 'a/b', 'x'.repeat(100)].map((id) => runName(id));
  for (const name of minted) {
    assert.match(name, RUN_NAME_GRAMMAR, `a minted name must match: ${name}`);
  }

  const refused = ['..', 'run-../x', 'a/b', '', 'run-2026-x-abc', `${runName(1)}/`];
  for (const candidate of refused) {
    assert.doesNotMatch(candidate, RUN_NAME_GRAMMAR, `must be refused: ${JSON.stringify(candidate)}`);
  }
});

test('layoutFor names the same run as runLayout, and every file sits in the run directory under its constant name', () => {
  const dir = runDir();
  const l = runLayout(dir, 7);
  assert.deepEqual(layoutFor(dir, basename(l.dir)), l, 'the run name is the only thing layoutFor needs');

  const entries = Object.entries(RUN_EVIDENCE_FILES);
  assert.equal(entries.length, 6, 'the layout names six files');
  assert.equal(RUN_EVIDENCE_FILES.result, 'result.json');
  for (const [key, file] of entries) {
    assert.equal(fileOf(l, key), join(l.dir, file), `${key} lives in the run directory`);
  }
});
