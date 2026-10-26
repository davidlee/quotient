// Tests for the run registry (design sec-3, sec-4, sec-6, sec-7): the record a
// run becomes, its one settlement sequence, lanes, keys, acks, cancels and EOF.
// Every case drives `createRegistry` through its one seam — a fake `launch` — so
// no process is spawned and no wire is touched. `fakeLaunch` hands each launched
// run back to the test, which ends it with a document, a refusal, a rejection or
// a synchronous throw; that puts the suite *inside* a settlement, which is where
// sec-3's ordering is observable: the file lands, then the session is released,
// then the state flips. The release spy records what was true at the moment the
// session came free, so a wrong order is a failing assertion rather than a race.
//
// `lost` is reached only when `result.json` cannot be written, so those cases
// turn the file's path into a directory after `start` and before settling (C6):
// the run is published, so its directory is never deleted (sec-3), and the loss
// is published as a `lost` audit record. C7: `viewFromDisk` (PHASE-05) does not
// exist yet, so the disk half of the answer is `readAudit` plus the record.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reduce } from '../reduce/reduce.ts';
import { RUN_NAME_GRAMMAR, readAudit, readResult, type RunLayout } from './evidence.ts';
import { failedResult, refusedResult, validateAgentResult, type AgentResult } from './result.ts';
import { matchKey, type RunRecord } from './runs.ts';
import {
  attempts,
  auditKinds,
  block,
  completedResult,
  DEFAULT_START,
  fakeLaunch,
  foundResult,
  launchFor,
  registryFor,
  startRun,
  tick,
  type FakeLaunch,
  type ReleaseCall,
  type ReleaseSpy,
  type Started,
} from './test-rig.ts';

/** The status an unread stream leaves: the reducer's own empty verdict. */
const EMPTY_STATUS = reduce([], {}).status;

/** Whether RECORD was ever handed to the fake launch. */
const wasLaunched = (fake: FakeLaunch, record: RunRecord): boolean =>
  fake.launches.some((pending) => pending.record.run === record.run);

/** The one release the spy saw, or a failed expectation. */
function releaseOf(release: ReleaseSpy): ReleaseCall {
  assert.equal(release.calls.length, 1, 'the session is released exactly once');
  return release.calls[0];
}

/** The refusal a settled run recorded, or a failed expectation. */
function refusalOf(layout: RunLayout): { reason: string; detail: string } {
  const written = foundResult(layout).found;
  if (written.refusal === null) {
    assert.fail('the run must have settled as a refusal');
  }
  return written.refusal;
}

/** Every record in RUN's audit names the policy it was admitted under and its
 *  session, whichever writer appended it (sec-7's one private audit()). */
function assertStamped(run: Started): void {
  const audit = readAudit(run.record.layout);
  assert.ok(audit !== null, 'the audit must be readable');
  for (const record of audit.records) {
    assert.equal(record.policy_digest, run.admitted.policyDigest, `${record.record} names its policy`);
    assert.equal(record.session, run.record.session, `${record.record} names its session`);
  }
}

/** A well-formed handle no registry holds: the five disk answers' input (sec-3). */
const UNKNOWN_RUN = 'run-20260101T000000Z-none-0123456789ab';

describe('Records', () => {
  it('origin is what start was given, and the admitted record names the session and owner', (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const blocking = startRun(registry, fake, { origin: 'blocking' });
    const task = startRun(registry, fake, { origin: 'task' });

    assert.equal(blocking.record.origin, 'blocking');
    assert.equal(task.record.origin, 'task');
    assert.equal(blocking.record.session, blocking.admitted.session.session);
    assert.equal(RUN_NAME_GRAMMAR.test(blocking.record.run), true, 'the handle is the run directory name');

    const audit = readAudit(blocking.record.layout);
    assert.ok(audit !== null, 'the admitted record must be written');
    const admitted = audit.records[0];
    assert.equal(admitted.record, 'admitted');
    assert.deepEqual(admitted.owner, blocking.admitted.session.owner, 'the owner is the session lock\'s');
  });

  it('createdAt is the admitted record ts and updatedAt follows the audit, then the result write', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const run = startRun(registry, fake);
    const audit = readAudit(run.record.layout);
    assert.ok(audit !== null);
    assert.equal(run.record.createdAt, audit.records[0].ts, 'createdAt is the admitted record\'s ts');
    assert.equal(run.record.updatedAt, run.record.createdAt, 'the admitted record is the first update');

    const pending = await launchFor(fake, run.record);
    const spawnTs = '2099-01-01T00:00:00.000Z';
    pending.onAudit(spawnTs);
    assert.equal(run.record.updatedAt, spawnTs, 'updatedAt follows each audit ts the run task reports');

    pending.result(completedResult(run.record.layout, run.record.session));
    await run.record.settled;
    const written = readResult(run.record.layout);
    assert.ok(typeof written === 'object', 'the result landed');
    assert.equal(run.record.updatedAt, written.writtenAt, 'then updatedAt is the result.json write');
  });

  it('every record the registry writes carries policy_digest and session', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const run = startRun(registry, fake);
    const pending = await launchFor(fake, run.record);
    pending.refuse({ ok: false, reason: 'approval-revoked', detail: 'the approval was revoked' });
    await run.record.settled;

    const audit = readAudit(run.record.layout);
    assert.ok(audit !== null);
    assert.deepEqual(auditKinds(run.record.layout), ['admitted', 'refused']);
    for (const record of audit.records) {
      assert.equal(record.policy_digest, run.admitted.policyDigest, `${record.record} names its policy`);
      assert.equal(record.session, run.record.session, `${record.record} names its session`);
    }
  });
});

describe('Publish', () => {
  it('an unwritable admitted record refuses audit-failed, leaves no directory and frees the session', (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const blocked = join(fake.runDir, 'not-a-dir');
    writeFileSync(blocked, 'a run dir this is not');
    const fixture = fake.admitted({ runDir: blocked });

    const outcome = registry.start({
      admitted: fixture.admitted,
      origin: 'start',
      lane: null,
      needsSuccess: false,
      key: null,
      argsDigest: 'digest-1',
    });

    if (outcome.ok) {
      assert.fail('a run whose admitted record cannot be written must refuse');
    }
    assert.equal(outcome.reason, 'audit-failed');
    assert.equal(releaseOf(fixture.release).state, 'unwatched', 'no record was ever inserted');
    assert.equal(statSync(blocked).isFile(), true, 'the directory was never made');
    assert.equal(fake.launches.length, 0, 'nothing was launched');
  });
});

describe('Settle', () => {
  it('a result settles the run: result.json lands before the release and the state flips', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const run = startRun(registry, fake);
    const pending = await launchFor(fake, run.record);
    assert.equal(pending.queued, false, 'an unlaned run launches from start (C4)');
    assert.equal(run.record.state, 'running');

    const document = completedResult(run.record.layout, run.record.session);
    pending.result(document);
    await run.record.settled;

    const written = foundResult(run.record.layout).found;
    assert.deepEqual(written, document);
    assert.equal(validateAgentResult(written).ok, true, 'a landed result must conform');
    assert.deepEqual(await run.document, document, 'the blocking caller is handed the document written');
    assert.equal(run.record.state, 'settled');
    assert.deepEqual(run.record.outcome, { state: 'completed', causes: ['stop'] });

    const seen = releaseOf(run.release);
    assert.equal(seen.resultExists, true, 'the file lands before the release');
    assert.equal(seen.state, 'running', 'the state flips only after the release');
  });

  it('a { refused } launch writes a refused audit record and settles as that refusal', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const run = startRun(registry, fake);
    const pending = await launchFor(fake, run.record);

    pending.refuse({ ok: false, reason: 'root-missing', detail: 'the root no longer canonicalises' });
    await run.record.settled;

    assert.ok(auditKinds(run.record.layout).includes('refused'), 'the refusal is recorded');
    const written = foundResult(run.record.layout).found;
    assert.equal(written.state, 'refused');
    assert.equal(written.refusal?.reason, 'root-missing');
    assert.equal(run.record.state, 'settled');
    assert.deepEqual(run.record.outcome, { state: 'refused', causes: ['refused'] });
    assert.equal(releaseOf(run.release).state, 'running');
    assert.equal(run.release.calls.length, 1);
  });

  const unwritable: [string, (layout: RunLayout, session: string) => AgentResult][] = [
    ['a completed document', (layout: RunLayout, session: string): AgentResult => completedResult(layout, session)],
    ['a cancelled document', (layout: RunLayout, session: string): AgentResult => failedResult('cancelled', ['cancelled'], session, EMPTY_STATUS, layout)],
    ['a refused document', (): AgentResult => refusedResult('request-invalid', 'the request was invalid')],
  ];

  for (const [what, documentFor] of unwritable) {
    it(`an unwritable result.json makes the run lost, after ${what}`, async (t) => {
      const fake = fakeLaunch(t);
      const registry = registryFor(fake);
      const run = startRun(registry, fake);
      const pending = await launchFor(fake, run.record);
      block(run.record.layout.result);

      pending.result(documentFor(run.record.layout, run.record.session));
      await run.record.settled;

      assert.equal(run.record.state, 'lost');
      assert.equal(run.record.outcome, null, 'no result was recorded, so no outcome');
      assert.deepEqual(auditKinds(run.record.layout), ['admitted', 'lost'], 'the loss is published, once');
      assertStamped(run);

      const seen = releaseOf(run.release);
      assert.equal(seen.lostReadable, true, 'the lost record is readable before the release');
      assert.equal(seen.state, 'running', 'the state flips only after the release');
      assert.equal(run.release.calls.length, 1);

      const handed = await run.document;
      assert.equal(handed.state, 'audit_failed', 'a blocking caller is handed the failed arm');
      assert.equal(handed.causes[0], 'audit');
      assert.equal(validateAgentResult(handed).ok, true);
    });
  }

  it('with result.json and the lost record unwritable the loss is unpublished but the run is lost and ackable', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const run = startRun(registry, fake);
    const pending = await launchFor(fake, run.record);
    block(run.record.layout.result);
    block(run.record.layout.audit);

    pending.result(completedResult(run.record.layout, run.record.session));
    await run.record.settled;

    assert.equal(run.record.state, 'lost');
    assert.equal(readAudit(run.record.layout), null, 'the loss stayed unpublished');
    assert.equal(releaseOf(run.release).state, 'running', 'the session is freed regardless');
    assert.equal(run.release.calls.length, 1);
    assert.deepEqual(registry.ack([run.record.run]), [{ taskId: run.record.run, acknowledged: true }]);
  });

  it('a cancel and close() of a terminal record change nothing', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'again' });
    const queued = startRun(registry, fake, { lane: 'again' });
    const pending = await launchFor(fake, head.record);
    await registry.cancel([queued.record.run]);
    const document = foundResult(queued.record.layout).found;

    const again = registry.cancel([queued.record.run]);
    const closed = registry.close();
    pending.result(completedResult(head.record.layout, head.record.session));
    await again;
    await closed;

    assert.deepEqual(foundResult(queued.record.layout).found, document, 'the first settlement is the only one');
    assert.deepEqual(auditKinds(queued.record.layout), ['admitted', 'cancelled'], 'no second ending is recorded');
    assert.equal(queued.record.state, 'settled');
    assert.equal(queued.release.calls.length, 1, 'a session is released once');
    assert.equal(fake.launches.length, 1);
  });

  it('a launch that rejects with an unprintable value still settles failed', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const run = startRun(registry, fake);
    const pending = await launchFor(fake, run.record);

    pending.reject(Object.create(null));
    await run.record.settled;

    assert.deepEqual(run.record.outcome, { state: 'failed', causes: ['error'] });
    assert.equal(run.release.calls.length, 1);
    await registry.close();
  });

  it('a launch that rejects settles failed with cause error, frees the session, advances the lane and close() resolves', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'build' });
    const tail = startRun(registry, fake, { lane: 'build' });
    const pending = await launchFor(fake, head.record);

    pending.reject(new Error('the run task threw after launch'));
    await head.record.settled;

    assert.equal(head.record.state, 'settled');
    assert.deepEqual(head.record.outcome, { state: 'failed', causes: ['error'] });
    assert.equal(releaseOf(head.release).state, 'running');
    assert.equal(head.release.calls.length, 1);
    const handed = await head.document;
    assert.equal(handed.state, 'failed');
    assert.equal(handed.causes[0], 'error');

    const next = await launchFor(fake, tail.record);
    assert.equal(next.queued, true, 'the lane advanced to the head\'s successor');
    next.result(completedResult(tail.record.layout, tail.record.session));
    await tail.record.settled;

    await registry.close();
    assert.equal(tail.record.state, 'settled');
  });

  it('a launch that throws synchronously settles failed with cause error and lets close() resolve', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    fake.throwNext();

    const run = startRun(registry, fake);
    await run.record.settled;

    assert.equal(fake.launches.length, 0, 'the throw happened before the launch was recorded');
    assert.equal(run.record.state, 'settled');
    assert.deepEqual(run.record.outcome, { state: 'failed', causes: ['error'] });
    assert.equal(releaseOf(run.release).state, 'running');
    assert.equal(run.release.calls.length, 1);
    assert.equal((await run.document).causes[0], 'error');

    await registry.close();
  });
});

describe('Lanes', () => {
  it('runs in one lane launch strictly in start order', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const first = startRun(registry, fake, { lane: 'build' });
    const second = startRun(registry, fake, { lane: 'build' });
    const third = startRun(registry, fake, { lane: 'build' });

    const launched = await launchFor(fake, first.record);
    assert.deepEqual(fake.launches.map((pending) => pending.record.run), [first.record.run]);
    assert.equal(launched.queued, false, 'the head of an idle lane launches from start');
    assert.equal(second.record.state, 'queued');
    assert.equal(second.record.predecessor, first.record.run);
    assert.equal(third.record.predecessor, second.record.run);

    launched.result(completedResult(first.record.layout, first.record.session));
    await first.record.settled;
    const next = await launchFor(fake, second.record);
    assert.deepEqual(fake.launches.map((pending) => pending.record.run), [first.record.run, second.record.run]);
    assert.equal(next.queued, true, 'a run reaching the head launches outside its start (C4)');
    assert.equal(wasLaunched(fake, third.record), false);

    next.result(completedResult(second.record.layout, second.record.session));
    await second.record.settled;
    const last = await launchFor(fake, third.record);
    assert.deepEqual(fake.launches.map((pending) => pending.record.run), [first.record.run, second.record.run, third.record.run]);
    last.result(completedResult(third.record.layout, third.record.session));
    await third.record.settled;
  });

  it('an unlaned run ignores a busy lane', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'build' });
    const queued = startRun(registry, fake, { lane: 'build' });
    const free = startRun(registry, fake, { lane: null });

    await launchFor(fake, head.record);
    await launchFor(fake, free.record);
    assert.equal(wasLaunched(fake, queued.record), false, 'the lane has no say over an unlaned run');
    assert.equal(queued.record.state, 'queued');
  });

  it('needs_success refuses lane-predecessor-failed after a failed predecessor', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'build' });
    const guarded = startRun(registry, fake, { lane: 'build', needsSuccess: true });
    const pending = await launchFor(fake, head.record);

    pending.reject(new Error('the head failed'));
    await head.record.settled;
    await guarded.record.settled;

    assert.equal(foundResult(guarded.record.layout).found.state, 'refused');
    const refusal = refusalOf(guarded.record.layout);
    assert.equal(refusal.reason, 'lane-predecessor-failed');
    assert.ok(refusal.detail.includes(head.record.run), `the detail names the predecessor handle: ${refusal.detail}`);
    assert.ok(refusal.detail.includes('failed'), `the detail names the predecessor's state: ${refusal.detail}`);
    assert.equal(guarded.record.state, 'settled');
    assert.equal(wasLaunched(fake, guarded.record), false);
    assert.deepEqual(auditKinds(guarded.record.layout), ['admitted', 'refused']);
    assertStamped(guarded);
    assert.equal(releaseOf(guarded.release).state, 'queued', 'released before the state flips, never launched');
    assert.equal(guarded.release.calls.length, 1);

    const ledger = attempts(guarded.admitted.runDir).filter((line) => line.reason === 'lane-predecessor-failed');
    assert.equal(ledger.length, 1, 'attempts.jsonl records the refusal');
    assert.equal(ledger[0].call_id, guarded.admitted.callId);
  });

  it('needs_success refuses lane-predecessor-failed after a lost predecessor', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'lost-lane' });
    const guarded = startRun(registry, fake, { lane: 'lost-lane', needsSuccess: true });
    const pending = await launchFor(fake, head.record);
    block(head.record.layout.result);

    pending.result(completedResult(head.record.layout, head.record.session));
    await head.record.settled;
    await guarded.record.settled;

    assert.equal(head.record.state, 'lost');
    const refusal = refusalOf(guarded.record.layout);
    assert.equal(refusal.reason, 'lane-predecessor-failed');
    assert.ok(refusal.detail.includes(head.record.run), 'a lost predecessor has no outcome, so it failed the guard');
    assert.equal(wasLaunched(fake, guarded.record), false);
  });

  it('a failed head cascades lane-predecessor-failed down the needs_success queue', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'cascade' });
    const second = startRun(registry, fake, { lane: 'cascade', needsSuccess: true });
    const third = startRun(registry, fake, { lane: 'cascade', needsSuccess: true });
    const pending = await launchFor(fake, head.record);

    pending.reject(new Error('the head failed'));
    await head.record.settled;
    await second.record.settled;
    await third.record.settled;

    const secondDetail = refusalOf(second.record.layout).detail;
    const thirdDetail = refusalOf(third.record.layout).detail;
    assert.ok(secondDetail.includes(head.record.run), 'the second refuses on the head');
    assert.ok(thirdDetail.includes(second.record.run), 'the third refuses on the second, not the head');
    assert.equal(wasLaunched(fake, second.record), false);
    assert.equal(wasLaunched(fake, third.record), false);
    assert.equal(fake.launches.length, 1, 'nothing but the head ever launched');
  });

  it('depth: a needs_success cascade over a thousand runs never recurses', async (t) => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = Infinity;
    t.after(() => {
      Error.stackTraceLimit = limit;
    });
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'deep' });
    const queued: Started[] = [];
    for (let index = 0; index < 1000; index += 1) {
      queued.push(startRun(registry, fake, { lane: 'deep', needsSuccess: true }));
    }

    const pending = await launchFor(fake, head.record);
    pending.reject(new Error('the head failed'));
    await head.record.settled;
    await Promise.all(queued.map((run) => run.record.settled));

    const frames = queued.map((run) => releaseOf(run.release).frames);
    const first = frames[0];
    const deepest = Math.max(...frames);
    assert.ok(deepest - first < 50, `the cascade must not grow the stack: ${String(first)} to ${String(deepest)}`);
    assert.equal(queued.filter((run) => run.record.state !== 'settled').length, 0, 'every run settled');
    assert.equal(queued.filter((run) => refusalOf(run.record.layout).reason === 'lane-predecessor-failed').length, 1000);
  });

  it('a needs_success run started after its predecessor failed and settled refuses at start', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'late' });
    const pending = await launchFor(fake, head.record);
    pending.reject(new Error('the head failed'));
    await head.record.settled;

    const late = startRun(registry, fake, { lane: 'late', needsSuccess: true });
    await late.record.settled;

    assert.equal(registry.get(late.record.run), late.record, 'start answered the record that settled');
    assert.equal(late.record.state, 'settled');
    assert.equal(refusalOf(late.record.layout).reason, 'lane-predecessor-failed');
    assert.equal(wasLaunched(fake, late.record), false);
  });

  it('a needs_success run started after a completed predecessor launches', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'after-completed' });
    const pending = await launchFor(fake, head.record);
    pending.result(completedResult(head.record.layout, head.record.session));
    await head.record.settled;

    const next = startRun(registry, fake, { lane: 'after-completed', needsSuccess: true });
    await launchFor(fake, next.record);
    assert.equal(next.record.state, 'running');
    assert.equal(wasLaunched(fake, next.record), true);
  });

  it('the first run in a lane launches with needs_success set: there is no predecessor', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const first = startRun(registry, fake, { lane: 'fresh', needsSuccess: true });

    await launchFor(fake, first.record);
    assert.equal(first.record.predecessor, null);
    assert.equal(first.record.needsSuccess, true);
    assert.equal(first.record.state, 'running');
  });

  it('a run without the flag launches after a failed predecessor', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'unflagged' });
    const plain = startRun(registry, fake, { lane: 'unflagged' });
    const pending = await launchFor(fake, head.record);

    pending.reject(new Error('the head failed'));
    await head.record.settled;
    await launchFor(fake, plain.record);
    assert.equal(plain.record.state, 'running');
  });
});

describe('Keys and acks', () => {
  it('the same key and arguments return the same record and launch nothing', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const run = startRun(registry, fake, { key: 'k1', argsDigest: 'digest-1' });
    const pending = await launchFor(fake, run.record);
    pending.result(completedResult(run.record.layout, run.record.session));
    await run.record.settled;

    const again = matchKey(registry.findKey('k1'), 'digest-1');
    if (again === null || !('reuse' in again)) {
      assert.fail('the same key and arguments must answer the original run');
    }
    assert.equal(again.reuse, run.record, 'the original record, terminal included');
    assert.equal(again.reuse.state, 'settled');
    assert.equal(fake.launches.length, 1, 'a reuse launches nothing');
  });

  it('the same key with different arguments refuses request-invalid', (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const run = startRun(registry, fake, { key: 'k2', argsDigest: 'digest-1' });

    const clash = matchKey(registry.findKey('k2'), 'digest-2');
    if (clash === null || 'reuse' in clash) {
      assert.fail('a key used with different arguments must refuse');
    }
    assert.equal(clash.ok, false);
    assert.equal(clash.reason, 'request-invalid');
    assert.equal(clash.detail, 'the key was used with different arguments');
    assert.equal(registry.findKey('k2'), run.record, 'the key still names its first run');
  });

  it('matchKey admits as new when no record holds the key', () => {
    assert.equal(matchKey(undefined, 'digest-1'), null);
  });

  it('a refused start records no key, so a retry re-admits', (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const blocked = join(fake.runDir, 'blocked-run-dir');
    writeFileSync(blocked, 'not a run dir');

    const refused = registry.start({
      admitted: fake.admitted({ runDir: blocked }).admitted,
      origin: 'start',
      lane: null,
      needsSuccess: false,
      key: 'k-retry',
      argsDigest: 'digest-1',
    });

    if (refused.ok) {
      assert.fail('an unwritable admitted record must refuse');
    }
    assert.equal(refused.reason, 'audit-failed');
    assert.equal(registry.findKey('k-retry'), undefined, 'a refused start records no key');

    const retried = startRun(registry, fake, { key: 'k-retry', argsDigest: 'digest-1' });
    assert.equal(registry.findKey('k-retry'), retried.record, 'the retry re-admits and takes the key');
  });

  it('ack acknowledges settled and lost records, and a lost record then leaves implicit()', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const settled = startRun(registry, fake);
    const settledPending = await launchFor(fake, settled.record);
    settledPending.result(completedResult(settled.record.layout, settled.record.session));
    await settled.record.settled;

    const lost = startRun(registry, fake);
    const lostPending = await launchFor(fake, lost.record);
    block(lost.record.layout.result);
    lostPending.result(completedResult(lost.record.layout, lost.record.session));
    await lost.record.settled;
    assert.equal(lost.record.state, 'lost');

    assert.deepEqual(registry.ack([settled.record.run, lost.record.run]), [
      { taskId: settled.record.run, acknowledged: true },
      { taskId: lost.record.run, acknowledged: true },
    ]);
    assert.deepEqual(registry.implicit().map((record: RunRecord) => record.run), [], 'acknowledged runs leave implicit()');
  });

  it('ack reports not-settled and unknown', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'busy' });
    const queued = startRun(registry, fake, { lane: 'busy' });
    await launchFor(fake, head.record);
    assert.equal(RUN_NAME_GRAMMAR.test(UNKNOWN_RUN), true);

    assert.deepEqual(registry.ack([queued.record.run, head.record.run, UNKNOWN_RUN]), [
      { taskId: queued.record.run, acknowledged: false, reason: 'not-settled' },
      { taskId: head.record.run, acknowledged: false, reason: 'not-settled' },
      { taskId: UNKNOWN_RUN, acknowledged: false, reason: 'unknown' },
    ]);
    assert.deepEqual(registry.implicit(['busy']).map((record: RunRecord) => record.run), [head.record.run, queued.record.run]);
  });

  it('ack applies none when any id is malformed (C3)', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const run = startRun(registry, fake);
    const pending = await launchFor(fake, run.record);
    pending.result(completedResult(run.record.layout, run.record.session));
    await run.record.settled;

    assert.deepEqual(registry.ack([run.record.run, 'not-a-run']), [
      { taskId: run.record.run, acknowledged: false, reason: 'unknown' },
      { taskId: 'not-a-run', acknowledged: false, reason: 'unknown' },
    ]);
    assert.deepEqual(registry.implicit().map((record: RunRecord) => record.run), [run.record.run], 'nothing was acknowledged');
  });

  it('ack is idempotent', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const run = startRun(registry, fake);
    const pending = await launchFor(fake, run.record);
    pending.result(completedResult(run.record.layout, run.record.session));
    await run.record.settled;

    assert.deepEqual(registry.ack([run.record.run]), [{ taskId: run.record.run, acknowledged: true }]);
    assert.deepEqual(registry.ack([run.record.run]), [{ taskId: run.record.run, acknowledged: true }]);
    assert.deepEqual(registry.implicit(), []);
    assert.equal(registry.get(run.record.run)?.acknowledged, true, 'an acknowledged run stays addressable');
  });

  it('implicit() names only unacknowledged start runs, by lane when asked, a settled one included', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const build = startRun(registry, fake, { lane: 'build' });
    const other = startRun(registry, fake, { lane: 'other' });
    const unlaned = startRun(registry, fake);
    startRun(registry, fake, { origin: 'blocking' });
    startRun(registry, fake, { origin: 'task', lane: 'build' });

    const pending = await launchFor(fake, build.record);
    pending.result(completedResult(build.record.layout, build.record.session));
    await build.record.settled;

    assert.deepEqual(registry.implicit().map((record: RunRecord) => record.run), [build.record.run, other.record.run, unlaned.record.run]);
    assert.deepEqual(registry.implicit(['build']).map((record: RunRecord) => record.run), [build.record.run]);
    assert.deepEqual(registry.implicit(['build', 'other']).map((record: RunRecord) => record.run), [build.record.run, other.record.run]);
  });
});

describe('Cancel', () => {
  it('cancel( of a queued run) settles it cancelled, with a cancelled record and no launch', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'cancel' });
    const queued = startRun(registry, fake, { lane: 'cancel' });
    await launchFor(fake, head.record);

    await registry.cancel([queued.record.run]);

    assert.equal(queued.record.cancelled, true);
    assert.equal(queued.record.state, 'settled');
    assert.deepEqual(queued.record.outcome, { state: 'cancelled', causes: ['cancelled'] });
    assert.deepEqual(auditKinds(queued.record.layout), ['admitted', 'cancelled']);
    assertStamped(queued);
    assert.equal(foundResult(queued.record.layout).found.state, 'cancelled');
    assert.equal(wasLaunched(fake, queued.record), false);
    assert.equal(releaseOf(queued.release).state, 'queued', 'released before the state flips, never launched');
    assert.equal(queued.release.calls.length, 1);
    assert.equal(head.record.cancelled, false, 'only the named run is marked');
    assert.equal(head.record.state, 'running');
  });

  it('cancelling a running head and its queued tail in one call launches neither queued run', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'both' });
    const tail = startRun(registry, fake, { lane: 'both' });
    const pending = await launchFor(fake, head.record);

    const done = registry.cancel([head.record.run, tail.record.run]);
    await tick();
    assert.equal(wasLaunched(fake, tail.record), false, 'the mark is taken before any await');
    assert.equal(tail.record.state, 'settled');
    assert.equal(head.record.cancelled, true);
    assert.equal(head.record.state, 'running');
    assert.equal(head.record.controller.signal.reason, 'cancelled', 'the running head is handed to its ladder');

    pending.result(failedResult('cancelled', ['cancelled'], head.record.session, EMPTY_STATUS, head.record.layout));
    await done;

    assert.deepEqual(head.record.outcome, { state: 'cancelled', causes: ['cancelled'] });
    assert.equal(head.record.state, 'settled');
    assert.equal(fake.launches.length, 1, 'nothing but the head ever launched');
    assert.equal(tail.record.state, 'settled');
  });

  it('a run that completes before its ladder settles completes', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const run = startRun(registry, fake);
    const pending = await launchFor(fake, run.record);

    const done = registry.cancel([run.record.run]);
    assert.equal(run.record.cancelled, true, 'the intent mark is taken before the await');
    assert.equal(run.record.controller.signal.reason, 'cancelled', 'the ladder is started synchronously');
    pending.result(completedResult(run.record.layout, run.record.session));
    await done;

    assert.equal(run.record.state, 'settled');
    assert.deepEqual(run.record.outcome, { state: 'completed', causes: ['stop'] });
    assert.equal(run.record.cancelled, true, 'the mark never changes the state');
  });
});

describe('Close', () => {
  it('closing() before a launch fires drops the run instead of launching it', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const run = startRun(registry, fake);

    registry.closing();
    await run.record.settled;

    assert.equal(wasLaunched(fake, run.record), false, 'nothing launches after closing()');
    assert.deepEqual(run.record.outcome, { state: 'incomplete', causes: ['eof'] });
    assert.deepEqual(auditKinds(run.record.layout), ['admitted', 'dropped']);
    assert.equal(run.release.calls.length, 1);
    await registry.close();
  });

  it('a start after closing() refuses and frees its session', (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    registry.closing();
    const fixture = fake.admitted();

    const refused = registry.start({ ...DEFAULT_START, lane: 'late', admitted: fixture.admitted });

    if (refused.ok) {
      assert.fail('a closing registry must not take a new run');
    }
    assert.equal(refused.reason, 'server-error');
    assert.equal(releaseOf(fixture.release).state, 'unwatched', 'no record was inserted');
    assert.deepEqual(registry.implicit(), []);
  });

  it('after closing() a head that settles launches no successor', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'eof' });
    const tail = startRun(registry, fake, { lane: 'eof' });
    const pending = await launchFor(fake, head.record);

    registry.closing();
    pending.result(completedResult(head.record.layout, head.record.session));
    await head.record.settled;
    await tick();

    assert.equal(wasLaunched(fake, tail.record), false, 'no lane advances from here');
    assert.equal(tail.record.state, 'queued');

    const done = registry.close();
    await tail.record.settled;
    await done;
    assert.equal(tail.record.outcome?.state, 'incomplete');
  });

  it('close() aborts a running run with eof and resolves once it settles', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const run = startRun(registry, fake);
    const pending = await launchFor(fake, run.record);

    const done = registry.close();
    await tick();
    assert.equal(run.record.controller.signal.aborted, true);
    assert.equal(run.record.controller.signal.reason, 'eof');

    pending.result(failedResult('eof', ['eof'], run.record.session, EMPTY_STATUS, run.record.layout));
    await done;

    assert.equal(run.record.state, 'settled');
    assert.deepEqual(run.record.outcome, { state: 'incomplete', causes: ['eof'] });
    assert.equal(releaseOf(run.release).state, 'running');
  });

  it('close() settles a queued run incomplete with cause eof and a dropped record', async (t) => {
    const fake = fakeLaunch(t);
    const registry = registryFor(fake);
    const head = startRun(registry, fake, { lane: 'drop' });
    const queued = startRun(registry, fake, { lane: 'drop' });
    const pending = await launchFor(fake, head.record);

    const done = registry.close();
    await queued.record.settled;

    assert.equal(queued.record.state, 'settled');
    assert.deepEqual(queued.record.outcome, { state: 'incomplete', causes: ['eof'] });
    assert.deepEqual(auditKinds(queued.record.layout), ['admitted', 'dropped']);
    assertStamped(queued);
    assert.equal(foundResult(queued.record.layout).found.causes[0], 'eof');
    assert.equal(wasLaunched(fake, queued.record), false);
    assert.equal(releaseOf(queued.release).state, 'queued', 'released before the state flips, never launched');
    assert.equal(queued.release.calls.length, 1);

    pending.result(failedResult('eof', ['eof'], head.record.session, EMPTY_STATUS, head.record.layout));
    await done;
    assert.equal(head.record.state, 'settled');
  });
});
