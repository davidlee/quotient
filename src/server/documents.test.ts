// Tests for the run documents quotient emits besides the result itself: the Task
// status every one carries, the handle start answers, the wait and ack envelopes,
// and the validators that hold every emitted document to design sec-2 (SL-004
// PHASE-05, EX-5, VT-2).
//
// Nothing here spawns or reads the ambient environment: a view is built by hand
// over a temp layout, and the result documents come from the real builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '../json.ts';
import { EMPTY_STATUS } from '../reduce/reduce.ts';
import {
  POLL_INTERVAL_MS,
  ackDocument,
  envelopeResult,
  handleDocument,
  runDocument,
  taskStatus,
  toolResult,
  validateAck,
  validateHandle,
  validateWait,
  type TaskStatus,
} from './documents.ts';
import { layoutFor, runName } from './evidence.ts';
import { failedResult, refusedResult, type AgentResult, type Validation } from './result.ts';
import type { AckEntry } from './runs.ts';
import { ARTIFACTS, completedResult } from './test-rig.ts';
import type { RunView } from './views.ts';

/** One temp root for every view's layout: a layout is named here, never read. */
const RUN_DIR = join(tmpdir(), 'quotient-documents-never-made');

/** A settled run's outcome for the two result states a status table row names. */
const COMPLETED: RunView['outcome'] = { state: 'completed', causes: ['stop'] };
const CANCELLED: RunView['outcome'] = { state: 'cancelled', causes: ['cancelled'] };

/** The predecessor every queued-behind message names; a well-formed handle. */
const PREDECESSOR = 'run-20261026T120259870Z-6-0b1c2d3e4f5a';

/** One run view, by hand: a running run unless a case says otherwise. */
function view(overrides: Partial<RunView> = {}): RunView {
  const run = runName('t');
  const base: RunView = {
    run,
    layout: layoutFor(RUN_DIR, run),
    state: 'running',
    createdAt: '2026-10-26T12:03:01.123Z',
    updatedAt: '2026-10-26T12:03:02.456Z',
    lane: null,
    key: null,
    session: 'sess-1',
    predecessor: null,
    cancelled: false,
    outcome: null,
    foreignPid: null,
  };
  return { ...base, ...overrides };
}

// ── Document surgery: the malformed variants, hand-made ────────────────────

/** A copy of DOC with one field replaced. */
function withField(doc: unknown, field: string, value: unknown): Record<string, unknown> {
  assert.ok(isRecord(doc), 'a document to mutate must be an object');
  return { ...doc, [field]: value };
}

/** A copy of DOC with one field removed. */
function withoutField(doc: unknown, field: string): Record<string, unknown> {
  assert.ok(isRecord(doc), 'a document to mutate must be an object');
  return Object.fromEntries(Object.entries(doc).filter(([name]) => name !== field));
}

/** A validator accepts DOC, or the test names the document it refused. */
function assertAccepts(validate: (doc: unknown) => Validation, doc: unknown, label: string): void {
  const verdict = validate(doc);
  if (!verdict.ok) {
    assert.fail(`${label}: expected a valid document, got ${verdict.detail}`);
  }
}

/** A validator rejects DOC, and names a defect. */
function assertRejects(validate: (doc: unknown) => Validation, doc: unknown, label: string): void {
  const verdict = validate(doc);
  if (verdict.ok) {
    assert.fail(`${label}: expected a rejection, got none`);
  }
  assert.ok(verdict.detail.length > 0, `${label}: a rejection names its defect`);
}

/** The one text block of a tool result, parsed back: what a client reads. */
function parseText(result: { content: { type: 'text'; text: string }[] }): unknown {
  const blocks = result.content;
  assert.equal(blocks.length, 1, 'a tool result carries one text block');
  const [block] = blocks;
  assert.equal(block.type, 'text');
  const parsed: unknown = JSON.parse(block.text);
  return parsed;
}

// ── taskStatus: sec-2's status table, row by row ───────────────────────────

/** One row of the table, asserted as its own test. */
function statusCase(label: string, runView: RunView, status: TaskStatus, statusMessage: string): void {
  test(`taskStatus maps ${label}`, () => {
    assert.deepEqual(taskStatus(runView), { status, statusMessage });
  });
}

statusCase(
  'a queued run behind a predecessor',
  view({ state: 'queued', lane: 'build', predecessor: PREDECESSOR }),
  'working',
  `queued in lane build behind ${PREDECESSOR}`,
);
statusCase('a queued run with no predecessor', view({ state: 'queued', lane: 'build' }), 'working', 'queued in lane build');
statusCase(
  'a cancelled queued run',
  view({ state: 'queued', lane: 'build', predecessor: PREDECESSOR, cancelled: true }),
  'working',
  'cancelling',
);
statusCase('a running run', view({ state: 'running' }), 'working', 'running');
statusCase('a cancelled running run', view({ state: 'running', cancelled: true }), 'working', 'cancelling');
statusCase(
  'a foreign run with a recorded pid',
  view({ state: 'foreign', foreignPid: 4242 }),
  'working',
  'owned by another quotient server (pid 4242)',
);
statusCase(
  'a foreign run with no recorded pid',
  view({ state: 'foreign' }),
  'working',
  'owned by another quotient server',
);
statusCase('a settled completed run', view({ state: 'settled', outcome: COMPLETED }), 'completed', 'completed');
statusCase(
  'a settled failed run',
  view({ state: 'settled', outcome: { state: 'failed', causes: ['exit'] } }),
  'completed',
  'failed',
);
statusCase('a settled run with no outcome', view({ state: 'settled', outcome: null }), 'completed', 'settled');
statusCase('a settled cancelled run', view({ state: 'settled', outcome: CANCELLED }), 'cancelled', 'cancelled');
statusCase(
  'a settled cancelled run with two causes',
  view({ state: 'settled', outcome: { state: 'cancelled', causes: ['cancelled', 'eof'] } }),
  'cancelled',
  'cancelled, eof',
);

const LOST = view({ state: 'lost' });
statusCase('a lost run', LOST, 'failed', `lost: inspect ${LOST.layout.dir}`);
statusCase(
  'a settled run with a stale cancel mark',
  view({ state: 'settled', outcome: COMPLETED, cancelled: true }),
  'completed',
  'completed',
);
const LOST_MARKED = view({ state: 'lost', cancelled: true });
statusCase('a lost run with a stale cancel mark', LOST_MARKED, 'failed', `lost: inspect ${LOST_MARKED.layout.dir}`);

// ── Run documents ──────────────────────────────────────────────────────────

test('runDocument is the Task fields plus quotient\'s extras, exactly', () => {
  const running = view();
  assert.equal(POLL_INTERVAL_MS, 2000);
  const doc = runDocument(running);
  assert.deepEqual(Object.keys(doc).sort(), [
    'artifacts',
    'createdAt',
    'key',
    'lane',
    'lastUpdatedAt',
    'pollIntervalMs',
    'session',
    'state',
    'status',
    'statusMessage',
    'taskId',
    'ttlMs',
  ]);
  assert.deepEqual(doc, {
    taskId: running.run,
    status: 'working',
    statusMessage: 'running',
    createdAt: running.createdAt,
    lastUpdatedAt: running.updatedAt,
    ttlMs: null,
    pollIntervalMs: POLL_INTERVAL_MS,
    state: 'running',
    lane: null,
    key: null,
    session: 'sess-1',
    artifacts: { dir: running.layout.dir },
  });
});

test('runDocument takes its extras from the view', () => {
  const queued = view({ state: 'queued', lane: 'build', key: 'step-2', session: '9c0f', predecessor: PREDECESSOR });
  const doc = runDocument(queued);
  assert.deepEqual(
    { taskId: doc.taskId, state: doc.state, lane: doc.lane, key: doc.key, session: doc.session },
    { taskId: queued.run, state: 'queued', lane: 'build', key: 'step-2', session: '9c0f' },
  );
  assert.deepEqual(doc.artifacts, { dir: queued.layout.dir });
  assert.deepEqual(handleDocument(queued), { schema: 'pi-run-handle/1', ...doc });
});

test('handleDocument validates for a view in every state', () => {
  const views: RunView[] = [
    view({ state: 'queued', lane: 'build' }),
    view({ state: 'running' }),
    view({ state: 'foreign', foreignPid: 4242 }),
    view({ state: 'settled', outcome: COMPLETED }),
    view({ state: 'lost' }),
  ];
  assert.deepEqual(
    views.map((runView) => runView.state),
    ['queued', 'running', 'foreign', 'settled', 'lost'],
  );
  for (const runView of views) {
    const doc = handleDocument(runView);
    assert.deepEqual(doc, { schema: 'pi-run-handle/1', ...runDocument(runView) });
    assertAccepts(validateHandle, doc, `a handle in state ${runView.state}`);
  }
});

test('validateHandle rejects a malformed handle', () => {
  const valid = handleDocument(view({ state: 'settled', outcome: COMPLETED }));
  assertAccepts(validateHandle, valid, 'the valid handle');
  const lostWorking = withField(handleDocument(view({ state: 'lost' })), 'status', 'working');

  assertRejects(validateHandle, withField(valid, 'schema', 'pi-run-handle/2'), 'wrong schema');
  assertRejects(validateHandle, withoutField(valid, 'taskId'), 'no taskId');
  assertRejects(validateHandle, withField(valid, 'taskId', 'not-a-run'), 'a taskId outside the grammar');
  assertRejects(validateHandle, withField(valid, 'status', 'pending'), 'a status outside the vocabulary');
  assertRejects(validateHandle, lostWorking, 'a lost run reported working');
  assertRejects(validateHandle, withField(valid, 'status', 'working'), 'a settled run reported working');
  assertRejects(validateHandle, withField(valid, 'statusMessage', 42), 'a statusMessage that is not a string');
  assertRejects(validateHandle, withField(valid, 'ttlMs', 30000), 'a ttlMs that is not null');
  assertRejects(validateHandle, withField(valid, 'pollIntervalMs', 0), 'a pollIntervalMs of 0');
  assertRejects(validateHandle, withField(valid, 'pollIntervalMs', 1.5), 'a pollIntervalMs that is not an integer');
  assertRejects(validateHandle, withField(valid, 'state', 'unreadable'), 'a state outside ViewState');
  assertRejects(validateHandle, withField(valid, 'lane', 7), 'a lane that is not a string');
  assertRejects(validateHandle, withField(valid, 'session', 7), 'a session that is not a string');
  assertRejects(validateHandle, withField(valid, 'artifacts', {}), 'artifacts with no dir');
  assertRejects(validateHandle, null, 'a null document');
  assertRejects(validateHandle, 'pi-run-handle/1', 'a document that is not an object');
});

// ── Wait documents: sec-2's pi-agent-wait/1 ────────────────────────────────

/** A run document as a wait entry: the result arm hangs off it (sec-2). */
function waitEntry(runView: RunView, arm: { statusOnly: boolean; result: AgentResult | null }): Record<string, unknown> {
  return { ...runDocument(runView), status_only: arm.statusOnly, result: arm.result };
}

/** A wait document as sec-2 defines it: its builder is PHASE-06's, so tests hand-build. */
function waitDocument(
  runs: unknown[],
  lists: { unknown?: string[]; unreadable?: string[] } = {},
): Record<string, unknown> {
  return {
    schema: 'pi-agent-wait/1',
    until: 'all',
    timed_out: false,
    truncated: false,
    runs,
    unknown: lists.unknown ?? [],
    unreadable: lists.unreadable ?? [],
  };
}

test('validateWait accepts the documents documents.ts emits', () => {
  const settled = view({ state: 'settled', lane: 'build', outcome: COMPLETED });
  const refused = view({ state: 'settled', outcome: { state: 'refused', causes: ['refused'] } });
  const unknown = runName('t');
  const doc = waitDocument(
    [
      waitEntry(settled, { statusOnly: false, result: completedResult(settled.layout, 'sess-1') }),
      waitEntry(view({ state: 'running' }), { statusOnly: true, result: null }),
      waitEntry(settled, { statusOnly: true, result: null }),
      waitEntry(refused, { statusOnly: false, result: refusedResult('server-error', 'nothing ran') }),
    ],
    { unknown: [unknown], unreadable: [] },
  );
  assertAccepts(validateWait, doc, 'a wait over every entry arm');
  assert.deepEqual(doc.unknown, [unknown]);
  assert.deepEqual(doc.unreadable, []);
});

test('validateWait accepts sec-2\'s example wait document', () => {
  const settled = view({ state: 'settled', lane: 'build', outcome: COMPLETED });
  const queued = view({ state: 'queued', lane: 'build', predecessor: settled.run });
  const doc = {
    schema: 'pi-agent-wait/1',
    until: 'all',
    timed_out: false,
    truncated: false,
    runs: [
      waitEntry(settled, { statusOnly: false, result: completedResult(settled.layout, 'sess-1') }),
      waitEntry(queued, { statusOnly: true, result: null }),
    ],
    unknown: ['run-20261024T080000000Z-1-aaaaaaaaaaaa'],
    unreadable: [],
  };
  const [, queuedEntry] = doc.runs;
  assert.equal(queuedEntry.statusMessage, `queued in lane build behind ${settled.run}`);
  assert.equal(queuedEntry.status, 'working');
  assertAccepts(validateWait, doc, 'sec-2 example');
});

test('validateWait rejects a malformed wait document', () => {
  const settled = view({ state: 'settled', outcome: COMPLETED });
  const running = view({ state: 'running' });
  const settledEntry = waitEntry(settled, { statusOnly: false, result: completedResult(settled.layout, 'sess-1') });
  const base = waitDocument([settledEntry, waitEntry(running, { statusOnly: true, result: null })], {
    unknown: [runName('t')],
  });
  const runsOf = (runs: unknown[]): Record<string, unknown> => withField(base, 'runs', runs);

  assertAccepts(validateWait, base, 'the base document');
  assertRejects(validateWait, withoutField(base, 'unknown'), 'no unknown list');
  assertRejects(validateWait, withoutField(base, 'unreadable'), 'no unreadable list');
  assertRejects(validateWait, withField(base, 'unknown', ['nope']), 'an unknown id outside the grammar');
  assertRejects(validateWait, withField(base, 'unreadable', ['nope']), 'an unreadable id outside the grammar');
  assertRejects(validateWait, withField(base, 'until', 'some'), 'until "some"');
  assertRejects(validateWait, withField(base, 'timed_out', 'no'), 'a timed_out that is not a boolean');
  assertRejects(validateWait, withoutField(base, 'truncated'), 'no truncated flag');
  assertRejects(validateWait, withField(base, 'runs', {}), 'runs that are not a list');
  assertRejects(validateWait, withField(base, 'schema', 'pi-agent-wait/2'), 'wrong schema');
  assertRejects(validateWait, runsOf([withField(settledEntry, 'status_only', true)]), 'a result with status_only true');
  assertRejects(validateWait, runsOf([withField(settledEntry, 'result', null)]), 'status_only false with no result');
  assertRejects(
    validateWait,
    runsOf([waitEntry(running, { statusOnly: false, result: completedResult(running.layout, 'sess-1') })]),
    'a result on a non-settled entry',
  );
  assertRejects(
    validateWait,
    runsOf([withField(settledEntry, 'result', { schema: 'pi-agent-result/2' })]),
    'a result that is not pi-agent-result/2',
  );
  assertRejects(validateWait, runsOf([withField(settledEntry, 'taskId', 'nope')]), 'an entry failing the run-document rules');
});

test('validateWait holds a settled entry to its own result\'s status', () => {
  const completedView = view({ state: 'settled', outcome: COMPLETED });
  const answer = completedResult(completedView.layout, 'sess-1');
  const cancelledView = view({ state: 'settled', outcome: { state: 'cancelled', causes: ['cancelled', 'eof'] } });
  const cancellation = failedResult('cancelled', ['cancelled', 'eof'], 'sess-1', EMPTY_STATUS, ARTIFACTS);
  const agreeing = waitEntry(cancelledView, { statusOnly: false, result: cancellation });

  assertAccepts(validateWait, waitDocument([agreeing]), 'a cancelled entry carrying its cancellation');
  assertRejects(
    validateWait,
    waitDocument([withField(waitEntry(completedView, { statusOnly: false, result: answer }), 'status', 'cancelled')]),
    'a completed result reported cancelled',
  );
  assertRejects(
    validateWait,
    waitDocument([waitEntry(completedView, { statusOnly: false, result: cancellation })]),
    'a cancellation reported completed',
  );
  assertRejects(
    validateWait,
    waitDocument([withField(agreeing, 'statusMessage', 'cancelled')]),
    'a cancellation whose message is not its causes',
  );
});

// ── Ack documents: sec-2's pi-agent-ack/1 ──────────────────────────────────

test('validateAck accepts the ack documents documents.ts emits', () => {
  const entries: AckEntry[] = [
    { taskId: runName('t'), acknowledged: true },
    { taskId: runName('t'), acknowledged: false, reason: 'not-settled' },
    { taskId: runName('t'), acknowledged: false, reason: 'unknown' },
  ];
  const doc = ackDocument(entries);
  assert.deepEqual(doc, { schema: 'pi-agent-ack/1', runs: entries });
  assertAccepts(validateAck, doc, 'one verdict per reason');
  assertAccepts(validateAck, ackDocument([]), 'an empty runs list');
});

test('validateAck rejects a malformed ack document', () => {
  const id = runName('t');
  const doc = (runs: unknown[]): Record<string, unknown> => ({ schema: 'pi-agent-ack/1', runs });

  assertRejects(validateAck, doc([{ taskId: id, acknowledged: true, reason: 'unknown' }]), 'a reason on an acknowledged run');
  assertRejects(validateAck, doc([{ taskId: id, acknowledged: false }]), 'a rejection with no reason');
  assertRejects(validateAck, doc([{ taskId: id, acknowledged: false, reason: 'nope' }]), 'a reason outside the vocabulary');
  assertRejects(validateAck, doc([{ acknowledged: true }]), 'no taskId');
  assertRejects(validateAck, doc([{ taskId: '', acknowledged: true }]), 'an empty taskId');
  assertRejects(validateAck, doc(['not an entry']), 'a runs entry that is not an object');
  assertRejects(validateAck, withField(doc([]), 'runs', {}), 'runs that are not a list');
  assertRejects(validateAck, withField(doc([]), 'schema', 'pi-agent-ack/2'), 'wrong schema');
});

// ── Envelopes ──────────────────────────────────────────────────────────────

test('envelopeResult is an error only when the call was refused', () => {
  const doc = runDocument(view({ state: 'queued', lane: 'build' }));

  const answered = envelopeResult(doc, false);
  assert.equal(answered.isError, false);
  assert.deepEqual(parseText(answered), doc);

  const lostEntry = waitEntry(view({ state: 'lost' }), { statusOnly: true, result: null });
  const carriesAFailedRun = envelopeResult(waitDocument([lostEntry]), false);
  assert.equal(carriesAFailedRun.isError, false, 'a failed run inside a document is not a refused call');
  assert.deepEqual(parseText(carriesAFailedRun), waitDocument([lostEntry]));

  const refusedCall = envelopeResult(doc, true);
  assert.equal(refusedCall.isError, true);
  assert.deepEqual(parseText(refusedCall), doc);
});

test('toolResult keeps today\'s isError rule', () => {
  const settled = view({ state: 'settled', outcome: COMPLETED });
  const answered = completedResult(settled.layout, 'sess-1');
  const refused = refusedResult('request-invalid', 'the request was not understood');

  assert.equal(toolResult(answered).isError, false);
  assert.deepEqual(parseText(toolResult(answered)), answered);
  assert.equal(toolResult(refused).isError, true);
  assert.deepEqual(parseText(toolResult(refused)), refused);
});
