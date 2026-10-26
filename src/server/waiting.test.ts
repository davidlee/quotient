// Tests for the wait's three pieces (design sec-5, sec-7): `resolveTargets`'s
// selection table, `awaitTargets`'s condition — a live target's `settled`
// promise, a timer, the call's signal, and polling only foreign or unreadable
// targets — and `waitEnvelope`'s answer, re-resolved when it is built so
// `timed_out` never contradicts the entries it reports.
//
// Every case drives a real registry over `fakeLaunch` and the run fixtures the
// other suites share: live runs settle by hand, disk runs are staged, and a
// staged pid table decides which of them this server reads as foreign or lost.
// A live wait wakes on the record's own promise; a disk wait is polled at a few
// milliseconds, as `gateIdleMs` shortens a timer in tests, so no case sleeps for
// a state change. Envelopes are validated before they are asserted on (EX-3).
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { rmSync } from 'node:fs';
import { describe, it, type TestContext } from 'node:test';
import { validateWait, type WaitDocument } from './documents.ts';
import { runName, writeResult } from './evidence.ts';
import type { Registry } from './runs.ts';
import {
  block,
  completedResult,
  FIXTURE_HERE,
  foundResult,
  type FakeLaunch,
  type FakeProcOwner,
  fakeLaunch,
  fakeProc,
  launchFor,
  OWNER_ALIVE,
  OWNER_GONE,
  pause,
  registryFor,
  runIn,
  type Started,
  startRun,
  tick,
} from './test-rig.ts';
import { resolveRun, type Resolution, type ViewState } from './views.ts';
import {
  awaitTargets,
  resolveTargets,
  waitBudgetBytes,
  waitEnvelope,
  waitTimeoutMs,
  WAIT_BUDGET_DEFAULT,
  WAIT_BUDGET_MAX,
  WAIT_TIMEOUT_DEFAULT_S,
  WAIT_TIMEOUT_MAX_S,
  type Target,
  type Until,
} from './waiting.ts';

// ── The waiting suite's own scaffolding ──────────────────────────────────

/** The poll interval every `awaitTargets` call in this suite passes: a few
 *  milliseconds, so a disk target's next read is never what a case waits for. */
const POLL_MS = 5;

/** Everything a case needs: the fake launch, a registry over it, and the one
 *  `resolve` closure bound to this deployment (D-4: waiting.ts never calls
 *  `resolveRun` itself). */
type Rig = {
  fake: FakeLaunch;
  registry: Registry;
  resolve: (run: string) => Resolution;
};

/**
 * A rig: a registry over `fakeLaunch` and the `resolve` every target goes
 * through, bound to this deployment's run dir, this server's identity and a
 * staged pid table. The fixture owner is alive unless a case stages otherwise.
 */
function rig(t: TestContext, options: { owner?: FakeProcOwner } = {}): Rig {
  const fake = fakeLaunch(t);
  const procDir = fakeProc(fake.runDir, options.owner ?? OWNER_ALIVE);
  const registry = registryFor(fake);
  const resolve = (run: string): Resolution => resolveRun(registry, fake.runDir, procDir, FIXTURE_HERE, run);
  return { fake, registry, resolve };
}

/** What a case varies in an envelope: results are asked for and the budget is the
 *  default unless it says otherwise. */
type EnvelopeOptions = { until: Until; statusOnly?: boolean; budgetBytes?: number };

/** The answer a wait gives over TARGETS, validated before any case asserts on it
 *  (EX-3: every envelope this suite builds passes `validateWait`). */
function envelope(
  targets: Target[],
  resolve: (run: string) => Resolution,
  options: EnvelopeOptions,
): WaitDocument {
  const doc = waitEnvelope(targets, resolve, {
    until: options.until,
    statusOnly: options.statusOnly ?? false,
    budgetBytes: options.budgetBytes ?? WAIT_BUDGET_DEFAULT,
  });
  const verdict = validateWait(doc);
  if (!verdict.ok) {
    assert.fail(`the wait envelope must validate: ${verdict.detail}`);
  }
  return doc;
}

/** Settle a live run with a result whose answer text is TEXT, and answer the
 *  serialised size the byte budget counts (C10). */
async function settleRun(fake: FakeLaunch, started: Started, text = 'the answer'): Promise<number> {
  const document = completedResult(started.record.layout, started.record.session, text);
  const pending = await launchFor(fake, started.record);
  pending.result(document);
  await started.record.settled;
  return Buffer.byteLength(JSON.stringify(document));
}

/** Whether WAIT resolved within MS. A check that a wait must NOT resolve yet is
 *  generous; only the timer under test is timed tightly. */
function resolvesWithin(wait: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([wait.then(() => true), pause(ms).then(() => false)]);
}

/** Await WAIT, failing the case if it has not returned within MS: a hung wait
 *  must fail here rather than hang the suite. The default is well under the
 *  5000 ms timeout the cases pass, so a wait that returned only on its timer
 *  fails too. The guard timer is cleared on either path. */
async function within(wait: Promise<void>, ms = 1000): Promise<void> {
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      wait.then(() => {
        finished = true;
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(finished, true, `the wait did not return within ${String(ms)} ms`);
}

/** The state a target's view reports, or null: an unreadable target and an
 *  unknown id have no state to report. */
function viewStateOf(target: Target): ViewState | null {
  return target.view === null || target.view === 'unreadable' ? null : target.view.state;
}

/** A signal nothing will abort, for the cases that do not test the signal. */
const unAborted = (): AbortSignal => new AbortController().signal;

// ── Selection (sec-5's table, C8) ────────────────────────────────────────

describe('Selection', () => {
  it('both selectors omitted target every unacknowledged start run, in start order', async (t) => {
    const { fake, registry, resolve } = rig(t);
    const first = startRun(registry, fake);
    const second = startRun(registry, fake);
    const blocking = startRun(registry, fake, { origin: 'blocking' });
    const task = startRun(registry, fake, { origin: 'task' });
    const used = startRun(registry, fake);
    await settleRun(fake, used);
    assert.equal(registry.ack([used.record.run])[0].acknowledged, true);

    const selected: string[] = resolveTargets(registry, {}, resolve).map((target: Target) => target.run);

    assert.deepEqual(selected, [first.record.run, second.record.run]);
    for (const run of [blocking.record.run, task.record.run, used.record.run]) {
      assert.ok(!selected.includes(run), `${run} must not be an implicit target`);
    }
  });

  it('named runs are reported whatever their door and acknowledgement, a disk id too', async (t) => {
    const { fake, registry, resolve } = rig(t);
    const task = startRun(registry, fake, { origin: 'task' });
    const acked = startRun(registry, fake);
    const blocking = startRun(registry, fake, { origin: 'blocking' });
    await settleRun(fake, acked);
    registry.ack([acked.record.run]);
    const disk = runIn(fake.runDir, { result: true });

    const named = [acked.record.run, disk.run, task.record.run, blocking.record.run];
    const targets = resolveTargets(registry, { runs: named }, resolve);

    assert.deepEqual(targets.map((target: Target) => target.run), named, 'named runs keep the order they were given');
    assert.equal(viewStateOf(targets[1]), 'settled', 'a disk id resolves from its evidence');
  });

  it('a lane selects its unacknowledged runs lane by lane, snapshotting membership at arrival', async (t) => {
    const { fake, registry, resolve } = rig(t);
    const a1 = startRun(registry, fake, { lane: 'a' });
    const b1 = startRun(registry, fake, { lane: 'b' });
    const a2 = startRun(registry, fake, { lane: 'a' });
    startRun(registry, fake, { lane: 'a', origin: 'task' });
    startRun(registry, fake, { lane: 'b', origin: 'blocking' });
    await settleRun(fake, a1);
    await tick();

    const targets = resolveTargets(registry, { lanes: ['b', 'a'] }, resolve);

    assert.deepEqual(
      targets.map((target: Target) => target.run),
      [b1.record.run, a1.record.run, a2.record.run],
      'lanes in the order given, start order within each; owned runs in a lane are never implicit targets',
    );
    assert.equal(viewStateOf(targets[1]), 'settled', 'a settled unacknowledged run is still selected by its lane');

    startRun(registry, fake, { lane: 'a' });

    assert.deepEqual(
      targets.map((target: Target) => target.run),
      [b1.record.run, a1.record.run, a2.record.run],
      'a run started into the lane after the wait arrived is not a target',
    );
  });

  it('named runs come first, then lanes, duplicates dropped at their first position', (t) => {
    const { fake, registry, resolve } = rig(t);
    const laned = startRun(registry, fake, { lane: 'a' });
    const laterLaned = startRun(registry, fake, { lane: 'a' });
    const named = startRun(registry, fake);
    const runs = [named.record.run, laterLaned.record.run, named.record.run];

    const targets = resolveTargets(registry, { runs, lanes: ['a'] }, resolve);

    assert.deepEqual(
      targets.map((target: Target) => target.run),
      [named.record.run, laterLaned.record.run, laned.record.run],
      'named in the order given, then the lane; a run named twice, or named and laned, appears once',
    );
  });

  it('an empty selector selects nothing', (t) => {
    const { fake, registry, resolve } = rig(t);
    startRun(registry, fake);
    startRun(registry, fake, { lane: 'a' });

    assert.deepEqual(resolveTargets(registry, { runs: [] }, resolve), []);
    assert.deepEqual(resolveTargets(registry, { lanes: [] }, resolve), []);
    assert.deepEqual(resolveTargets(registry, { runs: [], lanes: [] }, resolve), []);
  });

  it('a well-formed id with no evidence is a target with a null view, and settled is present only for a live record', (t) => {
    const { fake, registry, resolve } = rig(t);
    const live = startRun(registry, fake);
    const disk = runIn(fake.runDir, { result: true });
    const missing = runName('missing');

    const targets = resolveTargets(registry, { runs: [missing, live.record.run, disk.run] }, resolve);

    assert.deepEqual(targets.map((target: Target) => target.run), [missing, live.record.run, disk.run]);
    assert.equal(targets[0].view, null, 'an id no evidence names is kept, with a null view');
    assert.notEqual(targets[1].settled, undefined, 'a live record contributes its settled promise');
    assert.equal(viewStateOf(targets[1]), 'running');
    assert.equal(targets[2].settled, undefined, 'a disk target has no promise in this process');
  });
});

// ── Condition (C6, C7, C9) ───────────────────────────────────────────────

describe('Condition', () => {
  it("'all' waits for every target, while 'any' returns once one has settled", async (t) => {
    const { fake, registry, resolve } = rig(t);
    const one = startRun(registry, fake);
    const two = startRun(registry, fake);
    const all = resolveTargets(registry, { runs: [one.record.run, two.record.run] }, resolve);

    const waitingAll = awaitTargets(all, 'all', 5000, unAborted(), resolve, POLL_MS);
    assert.equal(await resolvesWithin(waitingAll, 50), false, "'all' must wait while a target runs");
    await settleRun(fake, one);
    assert.equal(await resolvesWithin(waitingAll, 50), false, "'all' must still wait for the second target");
    await settleRun(fake, two);
    await within(waitingAll);

    const three = startRun(registry, fake);
    const four = startRun(registry, fake);
    const any = resolveTargets(registry, { runs: [three.record.run, four.record.run] }, resolve);
    const waitingAny = awaitTargets(any, 'any', 5000, unAborted(), resolve, POLL_MS);
    assert.equal(await resolvesWithin(waitingAny, 50), false, "'any' must wait while every target runs");
    await settleRun(fake, three);
    await within(waitingAny);
  });

  it("'any' over an unknown id and a running run returns at once", async (t) => {
    const { fake, registry, resolve } = rig(t);
    const running = startRun(registry, fake);
    const targets = resolveTargets(registry, { runs: [runName('missing'), running.record.run] }, resolve);

    const waiting = awaitTargets(targets, 'any', 5000, unAborted(), resolve, POLL_MS);

    assert.equal(await resolvesWithin(waiting, 50), true, 'an unknown id counts as done, so the condition holds');
    await within(waiting);

    const doc = envelope(targets, resolve, { until: 'any' });
    assert.deepEqual(doc.unknown, [targets[0].run], 'an unknown id is reported apart, not as a run');
    assert.deepEqual(doc.runs.map((entry) => entry.taskId), [running.record.run]);
    assert.equal(doc.timed_out, false);
  });

  it('no targets: the condition holds for both untils, so the wait returns at once', async (t) => {
    const { resolve } = rig(t);
    for (const until of ['all', 'any'] as const) {
      const waiting = awaitTargets([], until, 5000, unAborted(), resolve, POLL_MS);
      assert.equal(await resolvesWithin(waiting, 50), true, `a wait with no targets returns at once for '${until}'`);
      await within(waiting);
      assert.equal(envelope([], resolve, { until }).timed_out, false);
    }
  });

  it('a run that settles during the wait is reported settled with its result, after a wake and after a timeout', async (t) => {
    const { fake, registry, resolve } = rig(t);
    const woken = startRun(registry, fake);
    const wakeTargets = resolveTargets(registry, { runs: [woken.record.run] }, resolve);
    const waking = awaitTargets(wakeTargets, 'all', 5000, unAborted(), resolve, POLL_MS);
    await settleRun(fake, woken);
    await within(waking);

    const afterWake = envelope(wakeTargets, resolve, { until: 'all' });
    assert.equal(afterWake.timed_out, false, 'the condition held, so the wait did not time out');
    assert.equal(afterWake.runs[0].state, 'settled');
    assert.notEqual(afterWake.runs[0].result, null, 'a settled entry carries its result');

    const settled = startRun(registry, fake);
    const stillRunning = startRun(registry, fake);
    const timedTargets = resolveTargets(registry, { runs: [settled.record.run, stillRunning.record.run] }, resolve);
    const waiting = awaitTargets(timedTargets, 'all', 30, unAborted(), resolve, POLL_MS);
    await settleRun(fake, settled);
    await within(waiting);

    const afterTimeout = envelope(timedTargets, resolve, { until: 'all' });
    assert.equal(afterTimeout.timed_out, true, 'a still-running target keeps the condition from holding');
    assert.equal(afterTimeout.runs[0].state, 'settled', "the run that settled during the wait is reported as it is now");
    assert.notEqual(afterTimeout.runs[0].result, null);
    assert.equal(afterTimeout.runs[1].state, 'running');
    assert.equal(afterTimeout.runs[1].status_only, true);
  });

  it('a timeout reports the current states with timed_out true, and false once they turn done before the answer is built', async (t) => {
    const { fake, registry, resolve } = rig(t);
    const run = startRun(registry, fake);
    const targets = resolveTargets(registry, { runs: [run.record.run] }, resolve);

    await within(awaitTargets(targets, 'all', 30, unAborted(), resolve, POLL_MS));

    const timedOut = envelope(targets, resolve, { until: 'all' });
    assert.equal(timedOut.timed_out, true);
    assert.equal(timedOut.runs[0].state, 'running', 'the timeout reports every target in its current state');

    await settleRun(fake, run);

    const late = envelope(targets, resolve, { until: 'all' });
    assert.equal(late.timed_out, false, 'timed_out comes from the states the answer reports');
    assert.equal(late.runs[0].state, 'settled');
  });

  it('a lost disk target counts as done, with no result, and status_only true', async (t) => {
    const { fake, registry, resolve } = rig(t, { owner: OWNER_GONE });
    const lost = runIn(fake.runDir, {});

    const targets = resolveTargets(registry, { runs: [lost.run] }, resolve);
    assert.equal(viewStateOf(targets[0]), 'lost');

    const waiting = awaitTargets(targets, 'all', 5000, unAborted(), resolve, POLL_MS);
    assert.equal(await resolvesWithin(waiting, 50), true, 'a lost target is done, so there is nothing to wait for');
    await within(waiting);

    const doc = envelope(targets, resolve, { until: 'all' });
    assert.equal(doc.timed_out, false);
    assert.equal(doc.runs[0].state, 'lost');
    assert.equal(doc.runs[0].status_only, true);
    assert.equal(doc.runs[0].result, null, 'a lost run has no result to report');
  });

  it('aborting the signal ends the wait early, and an already-aborted signal ends it at once', async (t) => {
    const { fake, registry, resolve } = rig(t);
    const run = startRun(registry, fake);
    const targets = resolveTargets(registry, { runs: [run.record.run] }, resolve);
    const controller = new AbortController();

    const waiting = awaitTargets(targets, 'all', 5000, controller.signal, resolve, POLL_MS);
    assert.equal(await resolvesWithin(waiting, 50), false);
    controller.abort();
    await within(waiting);

    const aborted = awaitTargets(targets, 'all', 5000, AbortSignal.abort(), resolve, POLL_MS);
    assert.equal(await resolvesWithin(aborted, 50), true, 'an already-aborted signal ends the wait at once');
    await within(aborted);
  });

  it('a wait leaves no timer and no abort listener behind, however it ends', async (t) => {
    const { fake, registry, resolve } = rig(t);
    const run = startRun(registry, fake);
    const targets = resolveTargets(registry, { runs: [run.record.run] }, resolve);
    const timers = (): number => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;

    const before = timers();
    const controller = new AbortController();
    const aborted = awaitTargets(targets, 'all', 60000, controller.signal, resolve, POLL_MS);
    controller.abort();
    await within(aborted);
    assert.equal(timers(), before, 'the 60 s timer is cleared when the signal ends the wait');

    const signal = unAborted();
    const waiting = awaitTargets(targets, 'all', 60000, signal, resolve, POLL_MS);
    await settleRun(fake, run);
    await within(waiting);

    assert.equal(timers(), before, 'the 60 s timer is cleared once the condition holds');
    assert.equal(getEventListeners(signal, 'abort').length, 0, 'the abort listener is removed once the condition holds');
  });
});

// ── Polling (C9: foreign and unreadable targets only) ─────────────────────

describe('Polling', () => {
  it('a live target is never re-read', async (t) => {
    const { fake, registry, resolve } = rig(t);
    const run = startRun(registry, fake);
    const targets = resolveTargets(registry, { runs: [run.record.run] }, resolve);
    let rereads = 0;
    const reread = (id: string): Resolution => {
      rereads += 1;
      return resolve(id);
    };

    const waiting = awaitTargets(targets, 'all', 5000, unAborted(), reread, POLL_MS);
    await pause(10 * POLL_MS);
    await settleRun(fake, run);
    await within(waiting);

    assert.equal(rereads, 0, 'a live record has a promise in this process, so nothing polls it');
  });

  it('a foreign target turns settled when its result.json lands mid-wait', async (t) => {
    const { fake, registry, resolve } = rig(t);
    const foreign = runIn(fake.runDir, {});
    const targets = resolveTargets(registry, { runs: [foreign.run] }, resolve);
    assert.equal(viewStateOf(targets[0]), 'foreign');

    let rereads = 0;
    const reread = (id: string): Resolution => {
      rereads += 1;
      return resolve(id);
    };
    const landing = pause(20).then(() => {
      writeResult(foreign.layout, completedResult(foreign.layout, foreign.session));
    });
    const waiting = awaitTargets(targets, 'all', 5000, unAborted(), reread, POLL_MS);
    await within(waiting);
    await landing;

    assert.ok(rereads > 0, 'a foreign target is re-read while it is not done');
    const doc = envelope(targets, resolve, { until: 'all' });
    assert.equal(doc.timed_out, false);
    assert.equal(doc.runs[0].state, 'settled');
    assert.notEqual(doc.runs[0].result, null);
  });

  it('an unreadable target is listed apart, is not done, and turns settled once its result reads', async (t) => {
    const { fake, registry, resolve } = rig(t);
    const run = runIn(fake.runDir, { result: true });
    const document = foundResult(run.layout).found;
    block(run.layout.result);

    const targets = resolveTargets(registry, { runs: [run.run] }, resolve);
    assert.equal(targets[0].view, 'unreadable');

    const waiting = awaitTargets(targets, 'any', 5000, unAborted(), resolve, POLL_MS);
    assert.equal(await resolvesWithin(waiting, 50), false, 'an unreadable target is not done');

    const unread = envelope(targets, resolve, { until: 'any' });
    assert.deepEqual(unread.unreadable, [run.run], 'an unreadable id is reported apart');
    assert.deepEqual(unread.runs, [], 'it is no entry: its status cannot be derived without the result');
    assert.equal(unread.timed_out, true, "'any' does not hold while the only target is unreadable");

    rmSync(run.layout.result, { recursive: true, force: true });
    writeResult(run.layout, document);
    await within(waiting);

    const readable = envelope(targets, resolve, { until: 'any' });
    assert.deepEqual(readable.unreadable, []);
    assert.equal(readable.runs[0].state, 'settled');
    assert.notEqual(readable.runs[0].result, null, 'the run turns settled once its result reads');
    assert.equal(readable.timed_out, false);
  });
});

// ── The by-name loop (sec-5 "The loops help teaches") ────────────────────

describe('The by-name loop', () => {
  it("drops disk-settled ids even though ack answers 'unknown'", async (t) => {
    const { fake, registry, resolve } = rig(t);
    const disk = [runIn(fake.runDir, { result: true }), runIn(fake.runDir, { result: true }), runIn(fake.runDir, { result: true })];
    let ids = disk.map((fixture) => fixture.run);
    let rounds = 0;

    while (ids.length > 0 && rounds < 5) {
      rounds += 1;
      const targets = resolveTargets(registry, { runs: ids }, resolve);
      await within(awaitTargets(targets, 'any', 5000, unAborted(), resolve, POLL_MS));
      const doc = envelope(targets, resolve, { until: 'any' });
      const used = doc.runs.filter((entry) => entry.state === 'settled' && entry.result !== null).map((entry) => entry.taskId);
      const verdicts = registry.ack(used);
      const reasons = verdicts.map((verdict) => (verdict.acknowledged ? 'acknowledged' : verdict.reason));
      assert.deepEqual(reasons, used.map(() => 'unknown'), 'this server holds no record, so ack answers unknown');
      ids = ids.filter((id) => !used.includes(id) && !doc.unknown.includes(id));
    }

    assert.ok(rounds <= 5, 'the loop must terminate within five rounds');
    assert.deepEqual(ids, [], 'it drains because it drops what it used, not what ack answered');
  });
});

// ── The byte budget (sec-5, C3, C4, C10) ─────────────────────────────────

describe('Budget', () => {
  it('includes the first settled result whole, then only what the total allows', async (t) => {
    const { fake, registry, resolve } = rig(t);
    const first = startRun(registry, fake);
    const second = startRun(registry, fake);
    const third = startRun(registry, fake);
    const firstSize = await settleRun(fake, first, 'a'.repeat(2000));
    await settleRun(fake, second, 'b'.repeat(2000));
    const thirdSize = await settleRun(fake, third, 'c'.repeat(5));
    const ids = [first.record.run, second.record.run, third.record.run];
    const targets = resolveTargets(registry, { runs: ids }, resolve);

    const overBudget = envelope(targets, resolve, { until: 'all', budgetBytes: firstSize - 100 });
    assert.notEqual(overBudget.runs[0].result, null, 'the first settled result is included whole, even over budget');
    assert.equal(overBudget.runs[1].status_only, true, 'a result that would exceed the running total is status-only');
    assert.equal(overBudget.runs[1].result, null);
    assert.equal(overBudget.runs[2].result, null, 'nothing more fits once the first alone exceeds the budget');
    assert.equal(overBudget.truncated, true);

    const roomy = envelope(targets, resolve, { until: 'all' });
    assert.ok(roomy.runs.every((entry) => entry.result !== null), 'under the default budget every result fits');
    assert.equal(roomy.truncated, false, 'nothing left out, nothing truncated');

    const fitting = envelope(targets, resolve, { until: 'all', budgetBytes: firstSize + thirdSize });
    assert.notEqual(fitting.runs[0].result, null);
    assert.equal(fitting.runs[1].status_only, true, 'the second result does not fit');
    assert.notEqual(fitting.runs[2].result, null, 'a later, smaller result still fits: a total equal to the budget is within it');
    assert.equal(fitting.truncated, true);
  });

  it('a first settled result that cannot be read now is status-only and never sets truncated', async (t) => {
    const { fake, registry, resolve } = rig(t);
    const unreadable = startRun(registry, fake);
    const readable = startRun(registry, fake);
    await settleRun(fake, unreadable);
    const readableSize = await settleRun(fake, readable, 'y'.repeat(1000));
    block(unreadable.record.layout.result);

    const targets = resolveTargets(registry, { runs: [unreadable.record.run, readable.record.run] }, resolve);
    const doc = envelope(targets, resolve, { until: 'all', budgetBytes: readableSize - 100 });

    assert.equal(doc.runs[0].state, 'settled');
    assert.equal(doc.runs[0].status_only, true, 'a settled result that cannot be read now is emitted status-only');
    assert.equal(doc.runs[0].result, null);
    assert.equal(doc.runs[1].status_only, false);
    assert.notEqual(doc.runs[1].result, null, 'the guarantee passes to the next readable result, over budget');
    assert.equal(doc.truncated, false, 'leaving out an unreadable result is not truncation (C4)');
  });

  it('status_only asks for no results at all', async (t) => {
    const { fake, registry, resolve } = rig(t);
    const one = startRun(registry, fake);
    const two = startRun(registry, fake);
    await settleRun(fake, one);
    await settleRun(fake, two);
    const targets = resolveTargets(registry, { runs: [one.record.run, two.record.run] }, resolve);

    const doc = envelope(targets, resolve, { until: 'all', statusOnly: true });

    for (const entry of doc.runs) {
      assert.equal(entry.status_only, true);
      assert.equal(entry.result, null);
    }
    assert.equal(doc.truncated, false);
  });

  it('a non-settled target is status-only, carrying no result', (t) => {
    const { fake, registry, resolve } = rig(t);
    const running = startRun(registry, fake);
    const targets = resolveTargets(registry, { runs: [running.record.run] }, resolve);

    const doc = envelope(targets, resolve, { until: 'all' });

    assert.equal(doc.runs[0].state, 'running');
    assert.equal(doc.runs[0].status_only, true);
    assert.equal(doc.runs[0].result, null);
    assert.equal(doc.truncated, false);
  });
});

// ── Constants and pure functions (C1, C2, C12) ───────────────────────────

describe('Constants and pure functions', () => {
  it('the wait constants are the ones the contract names', () => {
    assert.equal(WAIT_TIMEOUT_DEFAULT_S, 45);
    assert.equal(WAIT_TIMEOUT_MAX_S, 900);
    assert.equal(WAIT_BUDGET_DEFAULT, 65536);
    assert.equal(WAIT_BUDGET_MAX, 1048576);
  });

  it('waitTimeoutMs applies the default and caps the request at the policy maximum', () => {
    assert.equal(waitTimeoutMs(undefined, { wall_clock_s: 600 }), 45000);
    assert.equal(waitTimeoutMs(1000, { wall_clock_s: 600 }), 600000);
    assert.equal(waitTimeoutMs(1000, null), 900000, 'no policy read leaves the contract maximum');
    assert.equal(waitTimeoutMs(0, null), 0);
  });

  it('waitBudgetBytes defaults and clamps at the ceiling', () => {
    assert.equal(waitBudgetBytes(undefined), WAIT_BUDGET_DEFAULT);
    assert.equal(waitBudgetBytes(5_000_000), WAIT_BUDGET_MAX);
    assert.equal(waitBudgetBytes(10), 10);
  });
});
