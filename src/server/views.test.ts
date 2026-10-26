// Tests for the one answer to "what is run X" (design sec-3, sec-7): `viewOf` for
// a live record, `viewFromDisk` for a handle no registry holds, and `resolveRun`,
// which is both. Every disk case is a fixture run directory — audit records
// through `appendAudit`, `result.json` through `writeResult` — read through a
// staged pid table, so sec-3's flowchart is walked branch by branch with no
// process and no sleep. The two cases that need a file to land BETWEEN the two
// result reads (C5) hook `readFileSync` for the owner's stat line alone, so the
// liveness check itself is what makes the file appear or disappear.
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  type ObjectEncodingOptions,
  type PathOrFileDescriptor,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  appendAudit,
  layoutFor,
  readResult,
  runName,
  writeResult,
  type AuditRecord,
  type RunLayout,
} from './evidence.ts';
import type { AgentResult } from './result.ts';
import { createRegistry, type Registry, type RunRecord, type StartSpec } from './runs.ts';
import { readHostIdentity, type HostIdentity, type RunOwner } from './session.ts';
import {
  completedResult,
  fakeLaunch,
  fakeProc,
  type FakeLaunch,
  type FakeProcOwner,
} from './test-rig.ts';
import { resolveRun, viewFromDisk, viewOf, type Resolution, type RunView, type ViewState } from './views.ts';

// ── The one server, and its run ───────────────────────────────────────────

/** The owner a fixture records: the one server every disk case starts with. */
const OWNER: RunOwner = {
  pid: 4242,
  starttime: '1000',
  boot: 'boot-a',
  pidns: 'pid:[1]',
  timens: 'time:[1]',
  host: 'host-a',
};

/** The reader's identity when it is that same server (D-4: `here` is passed in). */
const HERE: HostIdentity = { boot: 'boot-a', pidns: 'pid:[1]', timens: 'time:[1]', host: 'host-a' };

/** The sessions a fixture run owns, unless it names one. */
const SESSION = 'sess-views';

/** The owner's pid alive in the staged table: same pid, same start time. */
const ALIVE: FakeProcOwner = { pid: OWNER.pid, starttime: OWNER.starttime };

/** The owner's pid reused by another process: a different kernel start time. */
const REUSED: FakeProcOwner = { pid: OWNER.pid, starttime: '2000' };

/** The owner's pid gone: the table stages some other process instead. */
const GONE: FakeProcOwner = { pid: 5000, starttime: '1000' };

/** A fresh temp directory, removed when the test ends. */
function workspace(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-views-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** The stat line the liveness check reads for the recorded owner. */
function statOf(procDir: string): string {
  return join(procDir, String(OWNER.pid), 'stat');
}

/** Append one audit record the test can name: a fixture's records must land. */
function appendRecord(layout: RunLayout, record: AuditRecord): string {
  const ts = appendAudit(layout, record);
  if (ts === null) {
    assert.fail(`the ${record.record} record must land`);
  }
  return ts;
}

/** What a fixture run directory is asked to hold. */
type RunSpec = {
  /** Whether an `admitted` record is written at all (default true). */
  admitted?: boolean;
  /** The owner the admitted record names; null records none (default OWNER). */
  owner?: RunOwner | null;
  lane?: string | null;
  key?: string | null;
  predecessor?: string | null;
  session?: string;
  /** Extra audit records, appended after the admitted one. */
  records?: AuditRecord[];
  /** Whether a completed `result.json` is written (default false). */
  result?: boolean;
  /** Start the audit with a partly written line that has no newline (sec-7). */
  torn?: boolean;
};

/** One fixture run directory, and the timestamps its records were given. */
type Fixture = {
  run: string;
  layout: RunLayout;
  session: string;
  /** Each `appendAudit` answer, in the order the records were appended. */
  stamps: string[];
};

/** The `admitted` record a run from this release leaves: where it sits, the
 *  session it owns and the owner; a run from before the release named no owner. */
function admittedRecord(owner: RunOwner | null, spec: RunSpec, session: string): AuditRecord {
  const record: AuditRecord = {
    record: 'admitted',
    origin: 'start',
    lane: spec.lane ?? null,
    predecessor: spec.predecessor ?? null,
    needs_success: false,
    key: spec.key ?? null,
    session,
    policy_digest: 'policy-digest-1',
  };
  if (owner !== null) {
    record.owner = owner;
  }
  return record;
}

/** A record that was only partly written: no newline, so `appendAudit` starts the
 *  next record on a fresh line and a torn line never hides the records after it. */
function tornLine(layout: RunLayout): void {
  writeFileSync(layout.audit, '{"record":"admit');
}

/**
 * One run directory under DIR: an `admitted` record naming LANE, KEY,
 * PREDECESSOR, SESSION and the owner, any extra records, a torn line if asked,
 * and a completed `result.json` if asked.
 */
function runIn(dir: string, spec: RunSpec = {}): Fixture {
  const run = runName('call');
  const layout = layoutFor(dir, run);
  const session = spec.session ?? SESSION;
  mkdirSync(layout.dir, { recursive: true });
  if (spec.torn === true) {
    tornLine(layout);
  }
  const stamps = auditRecords(layout, spec, session);
  if (spec.result === true) {
    writeResult(layout, completedResult(layout, session));
  }
  return { run, layout, session, stamps };
}

/** The trail a fixture leaves: the admitted record unless a pre-release run is
 *  staged, then any extra records, each stamped as it lands. */
function auditRecords(layout: RunLayout, spec: RunSpec, session: string): string[] {
  const stamps: string[] = [];
  if (spec.admitted !== false) {
    const owner = spec.owner === undefined ? OWNER : spec.owner;
    stamps.push(appendRecord(layout, admittedRecord(owner, spec, session)));
  }
  for (const record of spec.records ?? []) {
    stamps.push(appendRecord(layout, record));
  }
  return stamps;
}

/** The result document a run left, or a failed expectation. */
function foundAt(layout: RunLayout): { found: AgentResult; writtenAt: string } {
  const read = readResult(layout);
  if (read === 'absent' || read === 'unreadable') {
    assert.fail(`the run must have left a result, saw ${read}`);
  }
  return read;
}

/** The latest of these timestamps: all are `toISOString`, so the later string is
 *  the later moment. */
function latest(...stamps: string[]): string {
  let newest = stamps[0];
  for (const stamp of stamps) {
    if (stamp > newest) {
      newest = stamp;
    }
  }
  return newest;
}

/** The view a resolution carries, or a failed expectation naming what it was. */
function resolvedView(resolution: Resolution): RunView {
  if (resolution === null || resolution === 'unreadable') {
    assert.fail(`expected a resolved run, saw ${String(resolution)}`);
  }
  return resolution.view;
}

/** The view in STATE, so every disk case states the branch it walked. */
function viewIn(resolution: Resolution, state: ViewState): RunView {
  const view = resolvedView(resolution);
  assert.equal(view.state, state);
  return view;
}

/** The result document a resolution carries; null when it carries none. */
function resolvedResult(resolution: Resolution): AgentResult | null {
  if (resolution === null || resolution === 'unreadable') {
    assert.fail(`expected a resolved run, saw ${String(resolution)}`);
  }
  return resolution.result;
}

/** Make PATH unwritable as a file, by replacing whatever is there with a
 *  non-empty directory (C6): neither a rename nor an append can land on it, and
 *  a read of it fails with something other than ENOENT. */
function block(path: string): void {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(join(path, 'x'), { recursive: true });
}

// ── C5: a file that lands between the two reads ──────────────────────────

type ReadFileSync = typeof fs.readFileSync;

/** The real read, while a hook is installed: `fs.readFileSync` is the hook then. */
let unstubbed: ReadFileSync | null = null;

/** The one read a hook is armed for: its exact path and what to do first. */
let pendingRead: { path: string; before: () => void } | null = null;

/** `fs.readFileSync`, answering the armed hook's `before` just before its path is
 *  read, then delegating to the real read. */
function hookedReadFileSync(path: PathOrFileDescriptor, options?: { encoding?: null | undefined; flag?: string | undefined } | null): Buffer<ArrayBuffer>;
function hookedReadFileSync(path: PathOrFileDescriptor, options: { encoding: BufferEncoding; flag?: string | undefined } | BufferEncoding): string;
function hookedReadFileSync(path: PathOrFileDescriptor, options?: (ObjectEncodingOptions & { flag?: string | undefined }) | BufferEncoding | null): string | Buffer<ArrayBuffer>;
function hookedReadFileSync(path: PathOrFileDescriptor, options?: (ObjectEncodingOptions & { flag?: string | undefined }) | BufferEncoding | null): string | Buffer<ArrayBuffer> {
  const delegate = unstubbed;
  if (delegate === null) {
    assert.fail('a read hook is installed with no read to delegate to');
  }
  const armed = pendingRead;
  if (armed !== null && String(path) === armed.path) {
    pendingRead = null;
    armed.before();
  }
  return delegate(path, options);
}

/**
 * Arm BEFORE for the next read of PATH, so a test can make `result.json` land or
 * turn unreadable between `viewFromDisk`'s two reads (C5). Other modules hold
 * `readFileSync` as a named import, so the reassignment reaches them only through
 * `syncBuiltinESMExports`. The answer restores the builtin.
 */
function hookReadOf(path: string, before: () => void): () => void {
  if (unstubbed !== null) {
    assert.fail('a read hook is already installed');
  }
  unstubbed = fs.readFileSync;
  pendingRead = { path, before };
  fs.readFileSync = hookedReadFileSync;
  syncBuiltinESMExports();
  return (): void => {
    pendingRead = null;
    const original = unstubbed;
    if (original !== null) {
      fs.readFileSync = original;
      unstubbed = null;
      syncBuiltinESMExports();
    }
  };
}

/** What READ answers, with BEFORE armed for the next read of PATH and the
 *  builtin restored however READ ends (the `finally` C5 asks for). */
function withReadHook<T>(path: string, before: () => void, read: () => T): T {
  const restore = hookReadOf(path, before);
  try {
    return read();
  } finally {
    restore();
  }
}

// ── The live registry (EX-4 drives a settle through it) ───────────────────

/** The fields `start` defaults: a plain unlaned start in the only door a disk
 *  case needs. */
const DEFAULT_START: Omit<StartSpec, 'admitted'> = {
  origin: 'start',
  lane: null,
  needsSuccess: false,
  key: null,
  argsDigest: 'digest-1',
};

/** A registry over the fake launch; its diagnostics sink is not asserted here. */
function registryFor(fake: FakeLaunch): Registry {
  return createRegistry({ launch: fake.launch, diagnostics: new PassThrough() });
}

/** One admitted run through the fake launch, which the test ends by hand. */
function startRun(registry: Registry, fake: FakeLaunch): RunRecord {
  const started = registry.start({ ...DEFAULT_START, admitted: fake.admitted().admitted });
  if (!started.ok) {
    assert.fail(`start refused: ${started.reason}: ${started.detail}`);
  }
  return started.record;
}

/** Make RUN's `result.json` unwritable while leaving it absent: the temp it is
 *  written to cannot be made, so the rename never happens — what a failed commit
 *  leaves on disk (blocking `result.json` itself would make it unreadable). */
function blockResultWrite(layout: RunLayout): void {
  block(join(layout.dir, '.result.json.tmp'));
}

/** One macrotask, so every microtask the registry queued has run. */
const tick = (): Promise<void> => new Promise<void>((resolve) => {
  setImmediate(resolve);
});

/** The launch the fake recorded for RECORD, once the registry's microtask ran it. */
async function launchFor(fake: FakeLaunch, record: RunRecord): Promise<FakeLaunch['launches'][number]> {
  for (let tries = 0; tries < 50; tries += 1) {
    const found = fake.launches.find((pending) => pending.record.run === record.run);
    if (found !== undefined) {
      return found;
    }
    await tick();
  }
  assert.fail(`no launch for ${record.run}`);
}

// ── Live records ──────────────────────────────────────────────────────────

describe('Live records', () => {
  it('a live record answers from memory, and a settled one carries its result document', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const procDir = fakeProc(workspace(t), ALIVE);
    const record = startRun(registry, fake);

    const running = resolveRun(registry, fake.runDir, procDir, HERE, record.run);
    const view = viewIn(running, record.state);
    assert.deepEqual(view, viewOf(record), 'a live view is the record, copied');
    assert.equal(view.run, record.run);
    assert.equal(view.session, record.session);
    assert.equal(view.createdAt, record.createdAt);
    assert.equal(view.foreignPid, null, 'a live run names no foreign pid');
    assert.equal(resolvedResult(running), null, 'a running record has no result');

    const pending = await launchFor(fake, record);
    pending.result(completedResult(record.layout, record.session));
    await record.settled;

    const settled = resolveRun(registry, fake.runDir, procDir, HERE, record.run);
    const afterwards = viewIn(settled, 'settled');
    const document = foundAt(record.layout).found;
    assert.deepEqual(resolvedResult(settled), document, 'the result comes back with the view');
    assert.deepEqual(afterwards.outcome, { state: document.state, causes: document.causes });
    assert.equal(afterwards.foreignPid, null);
  });

  it('a live settled record whose result.json cannot be read now keeps its state, with no result', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const procDir = fakeProc(workspace(t), ALIVE);
    const record = startRun(registry, fake);
    const pending = await launchFor(fake, record);
    pending.result(completedResult(record.layout, record.session));
    await record.settled;

    block(record.layout.result);
    const resolution = resolveRun(registry, fake.runDir, procDir, HERE, record.run);
    assert.notEqual(resolution, 'unreadable', 'a live record is never an unreadable resolution');
    assert.equal(viewIn(resolution, 'settled').outcome?.state, 'completed', 'a failed read changes no status');
    assert.equal(resolvedResult(resolution), null);
  });

  it('resolveRun answers a run the registry does not hold from disk', (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const procDir = fakeProc(workspace(t), ALIVE);
    const foreign = runIn(fake.runDir);
    const settled = runIn(fake.runDir, { result: true });

    assert.equal(viewIn(resolveRun(registry, fake.runDir, procDir, HERE, foreign.run), 'foreign').foreignPid, OWNER.pid);
    assert.deepEqual(
      resolveRun(registry, fake.runDir, procDir, HERE, settled.run),
      viewFromDisk(fake.runDir, settled.run, procDir, HERE),
    );
    assert.equal(resolveRun(registry, fake.runDir, procDir, HERE, runName('nowhere')), null, 'unknown');
  });
});

// ── Disk answers (sec-3's flowchart, one branch per case) ─────────────────

describe('On disk', () => {
  it('a valid result.json reads settled, with its document and the timestamps of the admitted record and the file', (t) => {
    const dir = workspace(t);
    const run = runIn(dir, { result: true });
    const procDir = fakeProc(dir, ALIVE);

    const resolution = viewFromDisk(dir, run.run, procDir, HERE);
    const view = viewIn(resolution, 'settled');
    const written = foundAt(run.layout);
    assert.deepEqual(resolvedResult(resolution), written.found, 'the document is read once, with the view');
    assert.deepEqual(view.outcome, { state: written.found.state, causes: written.found.causes });
    assert.equal(view.createdAt, run.stamps[0], 'createdAt is the admitted record ts');
    // File timestamps are coarse: the mtime may round below the record's ts.
    assert.equal(view.updatedAt, latest(run.stamps[0], written.writtenAt), 'updatedAt is the result.json write');
    assert.equal(view.cancelled, false);
    assert.equal(view.foreignPid, null);
  });

  it('no result with the owner alive reads foreign, naming its pid', (t) => {
    const dir = workspace(t);
    const run = runIn(dir);
    const procDir = fakeProc(dir, ALIVE);

    const resolution = viewFromDisk(dir, run.run, procDir, HERE);
    const view = viewIn(resolution, 'foreign');
    assert.equal(view.foreignPid, OWNER.pid);
    assert.equal(resolvedResult(resolution), null, 'a foreign run carries no result');
  });

  it('an unreadable pid table reads foreign', (t) => {
    const dir = workspace(t);
    const run = runIn(dir);
    const procDir = fakeProc(dir, 'unreadable');

    const view = viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'foreign');
    assert.equal(view.foreignPid, OWNER.pid, 'the recorded pid is all the answer names');
  });

  it('an owner whose pid is gone, or whose pid was reused, reads lost', (t) => {
    const dir = workspace(t);
    const gone = runIn(dir);
    const reused = runIn(dir);
    const procDir = fakeProc(dir, GONE);
    const view = viewIn(viewFromDisk(dir, gone.run, procDir, HERE), 'lost');
    assert.equal(view.foreignPid, null);

    const reusedProc = fakeProc(workspace(t), REUSED);
    assert.equal(viewIn(viewFromDisk(dir, reused.run, reusedProc, HERE), 'lost').foreignPid, null);
  });

  it('an owner that reads stale but whose result lands at the second read reads settled', (t) => {
    const dir = workspace(t);
    const run = runIn(dir);
    const procDir = fakeProc(dir, REUSED);

    const resolution = withReadHook(
      statOf(procDir),
      () => {
        writeResult(run.layout, completedResult(run.layout, run.session));
      },
      () => viewFromDisk(dir, run.run, procDir, HERE),
    );

    const view = viewIn(resolution, 'settled');
    assert.deepEqual(resolvedResult(resolution), foundAt(run.layout).found, 'the second read settles the run');
    assert.equal(view.foreignPid, null);
  });

  it('a run with no owner recorded reads lost', (t) => {
    const dir = workspace(t);
    const run = runIn(dir, { owner: null });
    const procDir = fakeProc(dir, ALIVE);

    const view = viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'lost');
    assert.equal(view.foreignPid, null, 'no owner was ever recorded, so none is named');
    assert.equal(view.createdAt, run.stamps[0]);
  });

  it('an audit that cannot be read reads foreign with no pid', (t) => {
    const dir = workspace(t);
    const run = runIn(dir);
    block(run.layout.audit);
    const procDir = fakeProc(dir, ALIVE);

    const view = viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'foreign');
    assert.equal(view.foreignPid, null, 'an unreadable audit names no owner, so no pid');
  });

  it('no admitted record and a torn line reads foreign', (t) => {
    const dir = workspace(t);
    const run = runIn(dir, { admitted: false, torn: true });
    const procDir = fakeProc(dir, ALIVE);

    const view = viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'foreign');
    assert.equal(view.foreignPid, null);
    assert.equal(run.stamps.length, 0, 'the fixture left one torn line and no record');
  });

  it('a torn line followed by a lost record reads lost with the owner alive', (t) => {
    const dir = workspace(t);
    const run = runIn(dir, { torn: true, records: [{ record: 'lost' }] });
    const procDir = fakeProc(dir, ALIVE);

    const view = viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'lost');
    assert.equal(view.createdAt, run.stamps[0], 'the admitted record is the first whole one');
  });

  it('a lost record reads lost with the owner alive', (t) => {
    const dir = workspace(t);
    const run = runIn(dir, { records: [{ record: 'lost' }] });
    const procDir = fakeProc(dir, ALIVE);

    const view = viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'lost');
    assert.equal(view.foreignPid, null);
  });

  it('an owner on another host or in another pid namespace reads foreign, even with its pid absent here', (t) => {
    const dir = workspace(t);
    const elsewhere = runIn(dir, { owner: { ...OWNER, host: 'host-b' } });
    const otherNamespace = runIn(dir, { owner: { ...OWNER, pidns: 'pid:[2]' } });
    const procDir = fakeProc(dir, GONE);

    assert.equal(viewIn(viewFromDisk(dir, elsewhere.run, procDir, HERE), 'foreign').foreignPid, OWNER.pid);
    assert.equal(viewIn(viewFromDisk(dir, otherNamespace.run, procDir, HERE), 'foreign').foreignPid, OWNER.pid);
  });

  it('same host and a different boot id reads lost', (t) => {
    const dir = workspace(t);
    const run = runIn(dir, { owner: { ...OWNER, boot: 'boot-b' } });
    const procDir = fakeProc(dir, ALIVE);

    const view = viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'lost');
    assert.equal(view.foreignPid, null);
  });

  it('an owner with a missing identity component reads foreign', (t) => {
    const dir = workspace(t);
    const run = runIn(dir, { owner: { ...OWNER, timens: null } });
    const procDir = fakeProc(dir, ALIVE);

    const view = viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'foreign');
    assert.equal(view.foreignPid, OWNER.pid);
  });

  it('a reader whose pid table numbers pids in an ancestor namespace reads foreign', (t) => {
    const dir = workspace(t);
    const run = runIn(dir);
    // Two NSpid fields: the table below numbers pids in an ancestor namespace, so
    // this server records no pid namespace id at all and judges every owner unknown.
    const procDir = fakeProc(dir, {
      pid: 5000,
      starttime: '1000',
      nspid: [7, 1],
      pidns: 'pid:[1]',
      boot: 'boot-a',
      timens: 'time:[1]',
    });
    const here = readHostIdentity(procDir, () => 'host-a');
    assert.equal(here.pidns, null, 'a nested NSpid line records no pid namespace');

    const view = viewIn(viewFromDisk(dir, run.run, procDir, here), 'foreign');
    assert.equal(view.foreignPid, OWNER.pid);
  });

  it('result.json unreadable beside a lost record reads lost', (t) => {
    const dir = workspace(t);
    const run = runIn(dir, { records: [{ record: 'lost' }] });
    block(run.layout.result);
    const procDir = fakeProc(dir, ALIVE);

    assert.equal(viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'lost').state, 'lost');
  });

  it('result.json unreadable at the first read reads unreadable, then settled once it reads', (t) => {
    const dir = workspace(t);
    const run = runIn(dir, { result: true });
    const procDir = fakeProc(dir, ALIVE);

    block(run.layout.result);
    assert.equal(viewFromDisk(dir, run.run, procDir, HERE), 'unreadable');

    rmSync(run.layout.result, { recursive: true, force: true });
    writeResult(run.layout, completedResult(run.layout, run.session));
    assert.deepEqual(resolvedResult(viewFromDisk(dir, run.run, procDir, HERE)), foundAt(run.layout).found);
  });

  it('a first read absent and a second read unreadable reads unreadable', (t) => {
    const dir = workspace(t);
    const run = runIn(dir);
    const procDir = fakeProc(dir, REUSED);

    const resolution = withReadHook(
      statOf(procDir),
      () => {
        block(run.layout.result);
      },
      () => viewFromDisk(dir, run.run, procDir, HERE),
    );

    assert.equal(resolution, 'unreadable', 'a result may be there, so the run is neither lost nor foreign');
  });

  it('a run read settled and then made unreadable answers unreadable, never a working view', (t) => {
    const dir = workspace(t);
    const run = runIn(dir, { result: true });
    const procDir = fakeProc(dir, ALIVE);

    viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'settled');
    block(run.layout.result);
    assert.equal(viewFromDisk(dir, run.run, procDir, HERE), 'unreadable');
  });

  it('an invalid result.json reads unreadable, never lost', (t) => {
    const dir = workspace(t);
    const run = runIn(dir);
    writeFileSync(run.layout.result, '{"ok":true}\n');
    const procDir = fakeProc(dir, ALIVE);

    assert.equal(viewFromDisk(dir, run.run, procDir, HERE), 'unreadable');
  });

  it('no directory reads null, and so does a malformed id', (t) => {
    const dir = workspace(t);
    const procDir = fakeProc(dir, ALIVE);

    assert.equal(viewFromDisk(dir, runName('nowhere'), procDir, HERE), null);
    assert.equal(viewFromDisk(dir, '../x', procDir, HERE), null);
  });

  it('a directory from before this release reads lost, with createdAt from its spawn record', (t) => {
    const dir = workspace(t);
    const run = runIn(dir, { admitted: false, records: [{ record: 'spawn' }, { record: 'exit' }] });
    const procDir = fakeProc(dir, ALIVE);

    const view = viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'lost');
    assert.equal(view.createdAt, run.stamps[0], 'createdAt is the first record ts, a spawn one');
    assert.equal(view.session, null, 'a run from before this release recorded no session');
    assert.equal(view.lane, null);
    assert.equal(view.key, null);
    assert.equal(view.predecessor, null);
    assert.equal(view.foreignPid, null);
  });

  it('a directory with no readable audit but a found result reads settled, with createdAt from its mtime', (t) => {
    const dir = workspace(t);
    const run = runIn(dir, { admitted: false, result: true });
    const procDir = fakeProc(dir, ALIVE);
    const dirMtime = statSync(run.layout.dir).mtime.toISOString();

    const view = viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'settled');
    assert.equal(view.createdAt, dirMtime, 'no audit record is readable, so the directory is the first stamp');
    assert.equal(view.session, null);
  });

  it('an owner record that is not a RunOwner reads foreign, never lost', (t) => {
    const dir = workspace(t);
    const run = runIn(dir, { owner: null, records: [] });
    // Rewritten by hand: an owner with a pid but no start time cannot be judged.
    writeFileSync(run.layout.audit, `${JSON.stringify({ ...admittedRecord(null, {}, SESSION), ts: run.stamps[0], owner: { pid: OWNER.pid } })}\n`);
    const procDir = fakeProc(dir, GONE);

    assert.equal(viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'foreign').foreignPid, OWNER.pid);
  });

  it('createdAt is the first audit record and updatedAt the last, with no result', (t) => {
    const dir = workspace(t);
    const run = runIn(dir, { admitted: false });
    const first = '2026-01-01T00:00:00.000Z';
    const last = '2026-01-01T00:00:05.000Z';
    writeFileSync(
      run.layout.audit,
      [{ ...admittedRecord(OWNER, {}, SESSION), ts: first }, { record: 'abort', ts: last }]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(''),
    );
    const procDir = fakeProc(dir, GONE);

    const view = viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'lost');
    assert.equal(view.createdAt, first);
    assert.equal(view.updatedAt, last);
  });

  it('the admitted record supplies lane, key, predecessor and session, and updatedAt is the latest stamp', (t) => {
    const dir = workspace(t);
    const predecessor = 'run-20260101T000000Z-before-0123456789ab';
    const run = runIn(dir, {
      lane: 'build',
      key: 'step-2',
      predecessor,
      session: 'sess-laned',
      records: [{ record: 'exit' }],
      result: true,
    });
    const procDir = fakeProc(dir, ALIVE);

    const view = viewIn(viewFromDisk(dir, run.run, procDir, HERE), 'settled');
    assert.equal(view.lane, 'build');
    assert.equal(view.key, 'step-2');
    assert.equal(view.predecessor, predecessor);
    assert.equal(view.session, 'sess-laned');
    const written = foundAt(run.layout);
    const lastAudit = run.stamps[run.stamps.length - 1];
    assert.equal(
      view.updatedAt,
      latest(run.stamps[0], lastAudit, written.writtenAt),
      'the latest of the audit, the result write and createdAt',
    );

    // The same rule with the audit the newer of the two: a record appended after
    // the result was written moves updatedAt with it.
    const later = runIn(dir, { result: true });
    const late = appendRecord(later.layout, { record: 'abort' });
    const lateWritten = foundAt(later.layout).writtenAt;
    assert.equal(viewIn(viewFromDisk(dir, later.run, procDir, HERE), 'settled').updatedAt, latest(later.stamps[0], late, lateWritten));
  });
});

// ── A settle that left no result (EX-4, deferred from runs.test.ts) ───────

describe('A settle that left no result', () => {
  it('after a settle whose result.json could not be written, the directory reads lost with the owner alive', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const procDir = fakeProc(workspace(t), ALIVE);
    const record = startRun(registry, fake);
    const pending = await launchFor(fake, record);

    blockResultWrite(record.layout);
    pending.result(completedResult(record.layout, record.session));
    await record.settled;
    assert.equal(record.state, 'lost');
    assert.equal(readResult(record.layout), 'absent', 'no result was ever recorded');

    const view = viewIn(viewFromDisk(fake.runDir, record.run, procDir, HERE), 'lost');
    assert.equal(view.foreignPid, null, 'a lost run names no pid');
    assert.equal(view.createdAt, record.createdAt);
  });

  it('with result.json and the audit unwritable the directory reads foreign while the live record is lost', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const procDir = fakeProc(workspace(t), ALIVE);
    const record = startRun(registry, fake);
    const pending = await launchFor(fake, record);

    blockResultWrite(record.layout);
    block(record.layout.audit);
    pending.result(completedResult(record.layout, record.session));
    await record.settled;
    assert.equal(record.state, 'lost', 'the loss is unpublished but the run is lost');

    const view = viewIn(viewFromDisk(fake.runDir, record.run, procDir, HERE), 'foreign');
    assert.equal(view.foreignPid, null);
  });
});
