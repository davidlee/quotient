// Tests for protocol.ts (SL-004 PHASE-09, VT-1): the era each request is served in,
// read from its own `_meta` (design sec-2, "Eras"), the tasks-extension check, the
// modern result decoration, server/discover's body, and the three task methods
// over fake TaskDeps (design sec-2, "Runs as tasks"; sec-7, `protocol.ts`).
//
// Everything here is pure: views are built by hand over a layout that is never
// made, result documents come from the real builders, and TaskDeps is a recording
// fake, so no filesystem and no registry is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_STATUS } from '../reduce/reduce.ts';
import { taskOf, toolResult } from './documents.ts';
import { layoutFor, runName } from './evidence.ts';
import {
  LEGACY_VERSION,
  LIST_CACHE,
  MODERN_VERSION,
  TASKS_EXTENSION,
  classifyEra,
  declaresTasks,
  discoverResult,
  modernResult,
  tasksCancel,
  tasksGet,
  tasksUpdate,
  type Era,
  type TaskDeps,
} from './protocol.ts';
import { failedResult, type AgentResult } from './result.ts';
import { ARTIFACTS, completedResult } from './test-rig.ts';
import type { Resolution, Resolved, RunView } from './views.ts';

// The wire keys, spelled out: the tests pin the protocol, not protocol.ts's names.
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';
const TASKS_KEY = 'io.modelcontextprotocol/tasks';

/** One temp root for every view's layout: a layout is named here, never read. */
const RUN_DIR = join(tmpdir(), 'quotient-protocol-never-made');

/** The predecessor every queued-behind view names; a well-formed handle. */
const PREDECESSOR = 'run-20261026T120259870Z-6-0b1c2d3e4f5a';

/** Request params whose `_meta` holds exactly FIELDS. */
function withMeta(fields: Record<string, unknown>): { _meta: Record<string, unknown> } {
  return { _meta: fields };
}

/** Modern params: the modern version and CAPABILITIES. */
function modernParams(capabilities: unknown = {}): { _meta: Record<string, unknown> } {
  return withMeta({ [VERSION_KEY]: MODERN_VERSION, [CAPABILITIES_KEY]: capabilities });
}

/** An object holding FIELDS only by inheritance: no own key at all. */
function inheriting(fields: Record<string, unknown>): unknown {
  const inherited: unknown = Object.create(fields);
  return inherited;
}

// ── The version constants ──────────────────────────────────────────────────

test('protocol.ts names the two revisions, the tasks extension and the list cache', () => {
  assert.equal(MODERN_VERSION, '2026-07-28');
  assert.equal(LEGACY_VERSION, '2025-06-18');
  assert.equal(TASKS_EXTENSION, TASKS_KEY);
  assert.deepEqual(LIST_CACHE, { ttlMs: 0, cacheScope: 'private' });
});

// ── classifyEra: sec-2's table, in its order ───────────────────────────────

/** One row of the era table, asserted as its own test. */
function eraCase(label: string, params: unknown, expected: Era): void {
  test(`classifyEra: ${label}`, () => {
    assert.deepEqual(classifyEra(params), expected);
  });
}

const LEGACY: Era = { era: 'legacy' };

eraCase('no params is legacy', undefined, LEGACY);
eraCase('null params is legacy', null, LEGACY);
eraCase('params that are a string are legacy', 'tools/list', LEGACY);
eraCase('params that are a number are legacy', 42, LEGACY);
eraCase('params that are an array are legacy', [withMeta({ [VERSION_KEY]: MODERN_VERSION })], LEGACY);
eraCase('params with no _meta are legacy', { name: 'pi_agent' }, LEGACY);
eraCase('a _meta that is a string is legacy', { _meta: MODERN_VERSION }, LEGACY);
eraCase('a null _meta is legacy', { _meta: null }, LEGACY);
eraCase('a _meta that is an array is legacy', { _meta: [MODERN_VERSION] }, LEGACY);
eraCase('a _meta without the version key is legacy', withMeta({ progressToken: 7 }), LEGACY);
eraCase('capabilities without a version are legacy', withMeta({ [CAPABILITIES_KEY]: {} }), LEGACY);
eraCase(
  'a version key only inherited by _meta is legacy',
  { _meta: inheriting({ [VERSION_KEY]: MODERN_VERSION, [CAPABILITIES_KEY]: {} }) },
  LEGACY,
);

const CAPABILITIES = { extensions: { [TASKS_KEY]: {} }, sampling: {} };
eraCase('the modern version with capabilities is modern, carrying them', modernParams(CAPABILITIES), {
  era: 'modern',
  capabilities: CAPABILITIES,
});
eraCase('the modern version with empty capabilities is modern', modernParams({}), {
  era: 'modern',
  capabilities: {},
});

/** The -32022 error naming REQUESTED (C1). */
function unsupported(requested: string): Era {
  return {
    error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested } },
  };
}

eraCase(
  'the legacy revision named in _meta is -32022',
  withMeta({ [VERSION_KEY]: LEGACY_VERSION, [CAPABILITIES_KEY]: {} }),
  unsupported('2025-06-18'),
);
eraCase(
  'an unknown version is -32022',
  withMeta({ [VERSION_KEY]: '2099-01-01', [CAPABILITIES_KEY]: {} }),
  unsupported('2099-01-01'),
);
eraCase(
  'an unknown version with no capabilities is -32022: the value before the capabilities',
  withMeta({ [VERSION_KEY]: '2099-01-01' }),
  unsupported('2099-01-01'),
);

const VERSION_NOT_A_STRING: Era = {
  error: { code: -32602, message: '_meta io.modelcontextprotocol/protocolVersion must be a string' },
};

eraCase('a numeric version is -32602', withMeta({ [VERSION_KEY]: 20260728, [CAPABILITIES_KEY]: {} }), VERSION_NOT_A_STRING);
eraCase('a null version is -32602', withMeta({ [VERSION_KEY]: null, [CAPABILITIES_KEY]: {} }), VERSION_NOT_A_STRING);
eraCase(
  'an object version is -32602',
  withMeta({ [VERSION_KEY]: { version: MODERN_VERSION }, [CAPABILITIES_KEY]: {} }),
  VERSION_NOT_A_STRING,
);
eraCase(
  'a numeric version with no capabilities is -32602 for the version: its type first',
  withMeta({ [VERSION_KEY]: 20260728 }),
  VERSION_NOT_A_STRING,
);

const CAPABILITIES_NOT_AN_OBJECT: Era = {
  error: { code: -32602, message: '_meta io.modelcontextprotocol/clientCapabilities must be an object' },
};

eraCase('the modern version with no capabilities is -32602', withMeta({ [VERSION_KEY]: MODERN_VERSION }), CAPABILITIES_NOT_AN_OBJECT);
eraCase('the modern version with null capabilities is -32602', modernParams(null), CAPABILITIES_NOT_AN_OBJECT);
eraCase('the modern version with array capabilities is -32602', modernParams([]), CAPABILITIES_NOT_AN_OBJECT);
eraCase('the modern version with string capabilities is -32602', modernParams('tasks'), CAPABILITIES_NOT_AN_OBJECT);

// ── declaresTasks ──────────────────────────────────────────────────────────

/** A modern era holding CAPABILITIES. */
function modern(capabilities: Record<string, unknown>): Era {
  return { era: 'modern', capabilities };
}

test('declaresTasks: a modern era whose extensions hold the tasks key declares tasks', () => {
  assert.equal(declaresTasks(modern({ extensions: { [TASKS_KEY]: {} } })), true);
  assert.equal(declaresTasks(modern({ extensions: { other: {}, [TASKS_KEY]: { version: 1 } } })), true);
  assert.equal(declaresTasks(modern({ extensions: { [TASKS_KEY]: null } })), true, 'any value under the key');
});

test('declaresTasks: every other era declares nothing', () => {
  const eras: [string, Era][] = [
    ['legacy', LEGACY],
    ['modern without extensions', modern({})],
    ['extensions that are a string', modern({ extensions: TASKS_KEY })],
    ['extensions that are an array', modern({ extensions: [TASKS_KEY] })],
    ['null extensions', modern({ extensions: null })],
    ['extensions without the key', modern({ extensions: { other: {} } })],
    ['the key beside extensions, not inside', modern({ [TASKS_KEY]: {} })],
    ['the key only inherited', modern({ extensions: inheriting({ [TASKS_KEY]: {} }) })],
    ['a -32022 error', unsupported('2099-01-01')],
    ['a -32602 error', CAPABILITIES_NOT_AN_OBJECT],
  ];
  for (const [label, era] of eras) {
    assert.equal(declaresTasks(era), false, label);
  }
});

// ── modernResult, discoverResult ───────────────────────────────────────────

test('modernResult adds resultType and keeps every member', () => {
  const result = { content: [{ type: 'text', text: '{}' }], isError: false, nested: { a: 1 } };
  const copy = structuredClone(result);
  assert.deepEqual(modernResult(result, 'complete'), { ...copy, resultType: 'complete' });
  assert.deepEqual(modernResult(result, 'task'), { ...copy, resultType: 'task' });
  assert.deepEqual(modernResult({}, 'complete'), { resultType: 'complete' });
  assert.deepEqual(result, copy, 'the result handed in is left as it was');
});

test('discoverResult is sec-2\'s server/discover body, serverInfo from its argument', () => {
  assert.deepEqual(discoverResult('the agent help section', { name: 'quotient', version: '1.2.3' }), {
    resultType: 'complete',
    supportedVersions: ['2026-07-28'],
    capabilities: { tools: {}, extensions: { [TASKS_KEY]: {} } },
    instructions: 'the agent help section',
    _meta: { [SERVER_INFO_KEY]: { name: 'quotient', version: '1.2.3' } },
    ttlMs: 0,
    cacheScope: 'private',
  });
  const other = discoverResult('other text', { name: 'q2', version: '9.9.9' });
  assert.deepEqual(other, {
    resultType: 'complete',
    supportedVersions: ['2026-07-28'],
    capabilities: { tools: {}, extensions: { [TASKS_KEY]: {} } },
    instructions: 'other text',
    _meta: { [SERVER_INFO_KEY]: { name: 'q2', version: '9.9.9' } },
    ttlMs: 0,
    cacheScope: 'private',
  });
});

// ── Fakes for the task methods ─────────────────────────────────────────────

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

/** A resolution with no result document: any state but a readable settled one. */
function unsettled(overrides: Partial<RunView>): Resolved {
  return { view: view(overrides), result: null };
}

/** A settled run carrying DOCUMENT, its view's outcome taken from it. */
function settled(document: AgentResult): Resolved {
  return {
    view: view({ state: 'settled', outcome: { state: document.state, causes: [...document.causes] } }),
    result: document,
  };
}

/** A recording TaskDeps: every resolve and cancel it was asked for, in order. */
type Probe = { deps: TaskDeps; resolved: string[]; cancelled: string[] };

/** TaskDeps that answer RESOLUTION for any id and record what they were asked. */
function probe(resolution: Resolution): Probe {
  const resolved: string[] = [];
  const cancelled: string[] = [];
  const deps: TaskDeps = {
    resolve: (run) => {
      resolved.push(run);
      return resolution;
    },
    cancel: (run) => {
      cancelled.push(run);
    },
  };
  return { deps, resolved, cancelled };
}

/** The id a test asks about: the view's run, or a fresh well-formed id. */
function idOf(resolution: Resolution): string {
  return resolution !== null && resolution !== 'unreadable' ? resolution.view.run : runName('t');
}

const EMPTY_ANSWER = { result: { resultType: 'complete' } };
const UNREADABLE_ERROR = { error: { code: -32603, message: 'the result could not be read; retry' } };

const COMPLETED_DOC = completedResult(layoutFor(RUN_DIR, PREDECESSOR), 'sess-1');
const FAILED_DOC = failedResult('exit', ['exit'], 'sess-1', EMPTY_STATUS, ARTIFACTS);
const CANCELLED_DOC = failedResult('cancelled', ['cancelled', 'eof'], 'sess-1', EMPTY_STATUS, ARTIFACTS);

// ── tasksGet: sec-2's status table, row by row ─────────────────────────────

/** One status row: the Task fields are taskOf(view), plus MEMBER, decorated. */
function getCase(label: string, resolved: Resolved, status: string, member: object = {}): void {
  test(`tasksGet: ${label}`, () => {
    const { deps, resolved: asked, cancelled } = probe(resolved);
    const answer = tasksGet({ taskId: resolved.view.run }, deps);
    assert.deepEqual(answer, { result: { ...taskOf(resolved.view), ...member, resultType: 'complete' } });
    assert.equal(taskOf(resolved.view).status, status);
    assert.deepEqual(asked, [resolved.view.run]);
    assert.deepEqual(cancelled, [], 'tasks/get never cancels');
  });
}

getCase('a queued run', unsettled({ state: 'queued' }), 'working');
getCase(
  'a run queued in a lane behind a predecessor',
  unsettled({ state: 'queued', lane: 'build', predecessor: PREDECESSOR }),
  'working',
);
getCase('a queued run marked for cancellation', unsettled({ state: 'queued', lane: 'build', cancelled: true }), 'working');
getCase('a running run', unsettled({ state: 'running' }), 'working');
getCase('a running run marked for cancellation', unsettled({ state: 'running', cancelled: true }), 'working');
getCase('a foreign run', unsettled({ state: 'foreign', foreignPid: 4242 }), 'working');
getCase('a settled completed run carries its blocking result', settled(COMPLETED_DOC), 'completed', {
  result: { ...toolResult(COMPLETED_DOC), resultType: 'complete' },
});
getCase('a settled failed run is completed, its result an error', settled(FAILED_DOC), 'completed', {
  result: { ...toolResult(FAILED_DOC), resultType: 'complete' },
});
getCase('a settled cancelled run carries no result member', settled(CANCELLED_DOC), 'cancelled');

const LOST = unsettled({ state: 'lost' });
getCase('a lost run carries the error member naming its directory', LOST, 'failed', {
  error: {
    code: -32603,
    message: 'run lost: no result was recorded; inspect the evidence directory',
    data: { dir: LOST.view.layout.dir },
  },
});

test('tasksGet: the fixtures are the result states the rows name', () => {
  assert.equal(toolResult(COMPLETED_DOC).isError, false);
  assert.equal(toolResult(FAILED_DOC).isError, true);
  assert.equal(CANCELLED_DOC.state, 'cancelled');
});

test('tasksGet: the result is the modern blocking pi_agent answer for the same document', () => {
  const resolved = settled(FAILED_DOC);
  assert.deepEqual(tasksGet({ taskId: resolved.view.run }, probe(resolved).deps), {
    result: { ...taskOf(resolved.view), result: modernResult(toolResult(FAILED_DOC), 'complete'), resultType: 'complete' },
  });
});

test('tasksGet: -32603 for a settled run whose document could not be read, whatever its status', () => {
  const unreadable: Resolved[] = [
    { view: settled(COMPLETED_DOC).view, result: null },
    { view: settled(CANCELLED_DOC).view, result: null },
  ];
  for (const resolved of unreadable) {
    assert.deepEqual(tasksGet({ taskId: resolved.view.run }, probe(resolved).deps), UNREADABLE_ERROR);
  }
});

test('tasksGet: -32603 for an unreadable resolution', () => {
  assert.deepEqual(tasksGet({ taskId: runName('t') }, probe('unreadable').deps), UNREADABLE_ERROR);
});

// ── tasksCancel, tasksUpdate ───────────────────────────────────────────────

const CANCELLABLE: [string, Resolution][] = [
  ['a queued run', unsettled({ state: 'queued', lane: 'build', predecessor: PREDECESSOR })],
  ['a running run', unsettled({ state: 'running' })],
];

const UNCANCELLABLE: [string, Resolution][] = [
  ['a foreign run', unsettled({ state: 'foreign', foreignPid: 4242 })],
  ['a settled completed run', settled(COMPLETED_DOC)],
  ['a settled cancelled run', settled(CANCELLED_DOC)],
  ['a settled run whose document could not be read', { view: settled(COMPLETED_DOC).view, result: null }],
  ['a lost run', unsettled({ state: 'lost' })],
  ['an unreadable resolution', 'unreadable'],
];

test('tasksCancel: a queued or running run is cancelled once, and the answer is empty', () => {
  for (const [label, resolution] of CANCELLABLE) {
    const { deps, resolved, cancelled } = probe(resolution);
    const id = idOf(resolution);
    assert.deepEqual(tasksCancel({ taskId: id }, deps), EMPTY_ANSWER, label);
    assert.deepEqual(resolved, [id], label);
    assert.deepEqual(cancelled, [id], label);
  }
});

test('tasksCancel: a foreign, terminal or unreadable run is left alone, and the answer is empty', () => {
  for (const [label, resolution] of UNCANCELLABLE) {
    const { deps, cancelled } = probe(resolution);
    assert.deepEqual(tasksCancel({ taskId: idOf(resolution) }, deps), EMPTY_ANSWER, label);
    assert.deepEqual(cancelled, [], label);
  }
});

test('tasksUpdate: the answer is empty and nothing is cancelled, whatever the run', () => {
  for (const [label, resolution] of [...CANCELLABLE, ...UNCANCELLABLE]) {
    const { deps, resolved, cancelled } = probe(resolution);
    const id = idOf(resolution);
    assert.deepEqual(tasksUpdate({ taskId: id, inputResponses: { q: 'a' } }, deps), EMPTY_ANSWER, label);
    assert.deepEqual(resolved, [id], label);
    assert.deepEqual(cancelled, [], label);
  }
});

// ── All three: malformed and unknown task ids ──────────────────────────────

const TASK_METHODS: [string, typeof tasksGet][] = [
  ['tasksGet', tasksGet],
  ['tasksCancel', tasksCancel],
  ['tasksUpdate', tasksUpdate],
];

const MALFORMED: [string, unknown][] = [
  ['no params', undefined],
  ['null params', null],
  ['params that are a string', 'run-x'],
  ['params that are an array', [PREDECESSOR]],
  ['no taskId', {}],
  ['a numeric taskId', { taskId: 42 }],
  ['a null taskId', { taskId: null }],
  ['an empty taskId', { taskId: '' }],
  ['a taskId naming a path', { taskId: '../x' }],
  ['a taskId outside the run-name grammar', { taskId: 'run-x' }],
];

test('every task method answers -32602 for a malformed taskId, and resolves nothing', () => {
  for (const [method, call] of TASK_METHODS) {
    for (const [label, params] of MALFORMED) {
      const { deps, resolved, cancelled } = probe(unsettled({ state: 'running' }));
      assert.deepEqual(
        call(params, deps),
        { error: { code: -32602, message: 'taskId must be a run id' } },
        `${method}: ${label}`,
      );
      assert.deepEqual(resolved, [], `${method}: ${label} resolves nothing`);
      assert.deepEqual(cancelled, [], `${method}: ${label} cancels nothing`);
    }
  }
});

test('every task method answers -32602 for a taskId no evidence names', () => {
  for (const [method, call] of TASK_METHODS) {
    const id = runName('t');
    const { deps, resolved, cancelled } = probe(null);
    assert.deepEqual(call({ taskId: id }, deps), { error: { code: -32602, message: `unknown task: ${id}` } }, method);
    assert.deepEqual(resolved, [id], method);
    assert.deepEqual(cancelled, [], method);
  }
});
