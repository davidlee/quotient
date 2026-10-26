// Tests for the tool vocabulary (design sec-2 "The tool table", "New argument
// grammar"; sec-7 `tools.ts`): the five tools' declarations, the readers that
// own every argument grammar, and the digest a key replay compares.
//
// Pure: no rig, no wire. A reader's refusal is the `request-invalid` detail the
// caller is told, so each case asserts the field it names, not the whole line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRecord } from '../json.ts';
import { runName } from './evidence.ts';
import { TOOLS, argsDigest, readAgentRequest, readRunIds, readWaitRequest, type AgentRequest, type ToolName } from './tools.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────

/** What every reader answers. */
type Read<T> = { ok: true; request: T } | { ok: false; detail: string };

/** The detail a refused read names; an accepted read is a failed expectation. */
function detailOf<T>(read: Read<T>): string {
  if (read.ok) {assert.fail(`expected a refusal, got ${JSON.stringify(read.request)}`);}
  return read.detail;
}

/** The request an accepted read holds; a refusal is a failed expectation. */
function requestOf<T>(read: Read<T>): T {
  if (!read.ok) {assert.fail(`expected the read to pass, got: ${read.detail}`);}
  return read.request;
}

/** Ids as the server mints them, so a well-formed id is a real one. */
const RUN = runName('c-1');
const OTHER_RUN = runName('c-2');

/** The smallest request either agent tool accepts. */
const BASE = { prompt: 'work', profile: 'read' };

/** Values no reader takes as its arguments object. */
const NOT_OBJECTS: unknown[] = [null, undefined, [], 'args', 7];

/** What a test reads of one input schema. */
type SchemaFields = { properties: string[]; required: unknown; additionalProperties: unknown };

/** The fields of NAME's input SCHEMA, as the wire declares them. */
function fieldsOf(name: string, schema: unknown): SchemaFields {
  if (!isRecord(schema) || !isRecord(schema.properties)) {assert.fail(`${name}: the input schema has no properties object`);}
  return {
    properties: Object.keys(schema.properties).sort(),
    required: schema.required,
    additionalProperties: schema.additionalProperties,
  };
}

const schemaOf = (name: ToolName): SchemaFields => fieldsOf(name, TOOLS[name].inputSchema);

/** Today's `pi_agent` arguments: what every agent tool keeps. */
const AGENT_FIELDS = ['prompt', 'profile', 'cwd', 'session', 'tools', 'ceilings', 'transcript_budget_bytes'];

// ── The tool table ────────────────────────────────────────────────────────

test('TOOLS: exactly the five tools, in the design\'s order', () => {
  assert.deepEqual(Object.keys(TOOLS), ['pi_agent', 'pi_agent_start', 'pi_agent_wait', 'pi_agent_ack', 'pi_agent_cancel']);
});

test('TOOLS: each tool carries exactly the design\'s annotations, and no destructiveHint', () => {
  const annotations = Object.fromEntries(Object.entries(TOOLS).map(([name, tool]) => [name, tool.annotations]));
  assert.deepEqual(annotations, {
    pi_agent: { readOnlyHint: false, openWorldHint: true },
    pi_agent_start: { readOnlyHint: false, openWorldHint: true },
    pi_agent_wait: { readOnlyHint: true },
    pi_agent_ack: { readOnlyHint: false, idempotentHint: true },
    pi_agent_cancel: { readOnlyHint: false, idempotentHint: true },
  });
});

test('TOOLS: only pi_agent_wait is readOnlyHint, so a client prompts for every other tool', () => {
  const readOnly = Object.entries(TOOLS).filter(([, tool]) => tool.annotations.readOnlyHint === true).map(([name]) => name);
  assert.deepEqual(readOnly, ['pi_agent_wait']);
  for (const [name, tool] of Object.entries(TOOLS)) {
    assert.equal(Object.hasOwn(tool.annotations, 'destructiveHint'), false, `${name} leaves destructiveHint at its default`);
  }
});

test('TOOLS: each tool\'s description is its own help section', () => {
  const sections = Object.fromEntries(Object.entries(TOOLS).map(([name, tool]) => [name, tool.section]));
  assert.deepEqual(sections, {
    pi_agent: 'tool',
    pi_agent_start: 'tool-start',
    pi_agent_wait: 'tool-wait',
    pi_agent_ack: 'tool-ack',
    pi_agent_cancel: 'tool-cancel',
  });
});

test('TOOLS: every schema refuses fields it does not declare', () => {
  for (const [name, tool] of Object.entries(TOOLS)) {
    assert.equal(fieldsOf(name, tool.inputSchema).additionalProperties, false, name);
  }
});

test('TOOLS: pi_agent declares lane and needs_success but no key; pi_agent_start adds key', () => {
  const agent = schemaOf('pi_agent');
  assert.deepEqual(agent.properties, [...AGENT_FIELDS, 'lane', 'needs_success'].sort());
  assert.deepEqual(agent.required, ['prompt', 'profile']);
  const start = schemaOf('pi_agent_start');
  assert.deepEqual(start.properties, [...AGENT_FIELDS, 'lane', 'needs_success', 'key'].sort());
  assert.deepEqual(start.required, ['prompt', 'profile']);
});

test('TOOLS: pi_agent_wait declares its own set; ack and cancel require runs and nothing else', () => {
  assert.deepEqual(schemaOf('pi_agent_wait').properties, ['budget_bytes', 'lanes', 'runs', 'status_only', 'timeout_s', 'until']);
  for (const name of ['pi_agent_ack', 'pi_agent_cancel'] as const) {
    const schema = schemaOf(name);
    assert.deepEqual(schema.properties, ['runs'], name);
    assert.deepEqual(schema.required, ['runs'], name);
  }
});

// ── readAgentRequest: lane, needs_success, key ────────────────────────────

test('readAgentRequest: arguments that are not an object are refused', () => {
  for (const args of NOT_OBJECTS) {
    assert.equal(detailOf(readAgentRequest(args)), 'arguments is not an object', JSON.stringify(args));
  }
});

test('readAgentRequest: each malformed lane is refused, naming lane', () => {
  for (const lane of ['', 'a'.repeat(65), '.build', 'build.', 'a/b', 7]) {
    assert.match(detailOf(readAgentRequest({ ...BASE, lane })), /lane/, JSON.stringify(lane));
  }
});

test('readAgentRequest: a lane in the session grammar is accepted', () => {
  for (const lane of ['build', 'a', 'a'.repeat(64), 'step_1.b-2']) {
    assert.equal(requestOf(readAgentRequest({ ...BASE, lane })).lane, lane);
  }
});

test('readAgentRequest: needs_success true needs a lane; false is accepted anywhere', () => {
  assert.match(detailOf(readAgentRequest({ ...BASE, needs_success: true })), /needs_success/);
  assert.equal(requestOf(readAgentRequest({ ...BASE, needs_success: false })).needs_success, false);
  const laned = requestOf(readAgentRequest({ ...BASE, lane: 'build', needs_success: true }));
  assert.equal(laned.needs_success, true);
  assert.equal(laned.lane, 'build');
});

test('readAgentRequest: a needs_success that is not a boolean is refused', () => {
  for (const needs of ['true', 1, null]) {
    assert.match(detailOf(readAgentRequest({ ...BASE, lane: 'build', needs_success: needs })), /needs_success/, JSON.stringify(needs));
  }
});

test('readAgentRequest: key is an unknown field unless the tool admits one', () => {
  assert.equal(detailOf(readAgentRequest({ ...BASE, key: 'k' })), 'unknown field: key');
  assert.equal(detailOf(readAgentRequest({ ...BASE, key: 'k' }, { key: false })), 'unknown field: key');
  assert.equal(requestOf(readAgentRequest({ ...BASE, key: 'k' }, { key: true })).key, 'k');
});

test('readAgentRequest: a key outside 1-128 printable ASCII characters is refused, naming key', () => {
  for (const key of ['', 'k'.repeat(129), 'a\nb', 'a\tb', 'clé', '\u007f', 42, null]) {
    assert.match(detailOf(readAgentRequest({ ...BASE, key }, { key: true })), /key/, JSON.stringify(key));
  }
});

test('readAgentRequest: a key of 128 printable characters, and every printable character, is accepted', () => {
  const printable = Array.from({ length: 0x7e - 0x20 + 1 }, (_, offset) => String.fromCodePoint(0x20 + offset)).join('');
  for (const key of ['k'.repeat(128), printable]) {
    assert.equal(requestOf(readAgentRequest({ ...BASE, key }, { key: true })).key, key);
  }
});

test('readAgentRequest: today\'s request still reads as it did, with none of the new fields', () => {
  const args = { ...BASE, cwd: '/w', session: 's-1', tools: ['read'], ceilings: { requests: 3 }, transcript_budget_bytes: 100 };
  assert.deepEqual(requestOf(readAgentRequest(args)), args);
});

// ── readWaitRequest ───────────────────────────────────────────────────────

test('readWaitRequest: an empty wait defaults until to all and status_only to false', () => {
  assert.deepEqual(requestOf(readWaitRequest({})), { until: 'all', status_only: false });
});

test('readWaitRequest: every field it declares is read as given', () => {
  const args = { runs: [RUN, OTHER_RUN], lanes: ['build'], until: 'any', timeout_s: 2.5, status_only: true, budget_bytes: 1024 };
  assert.deepEqual(requestOf(readWaitRequest(args)), args);
});

test('readWaitRequest: arguments that are not an object, or an unknown field, are refused', () => {
  for (const args of NOT_OBJECTS) {
    assert.equal(detailOf(readWaitRequest(args)), 'arguments is not an object', JSON.stringify(args));
  }
  assert.equal(detailOf(readWaitRequest({ runs: [RUN], key: 'k' })), 'unknown field: key');
});

test('readWaitRequest: runs that are not an array of well-formed ids are refused, naming runs', () => {
  for (const runs of [RUN, [7], ['..'], ['a/b'], [`${RUN}/..`], [RUN, 'run-x']]) {
    assert.match(detailOf(readWaitRequest({ runs })), /runs/, JSON.stringify(runs));
  }
});

test('readWaitRequest: lanes that are not an array of lane names are refused, naming lanes', () => {
  for (const lanes of ['build', [''], ['.build'], ['a/b'], ['a'.repeat(65)], [7]]) {
    assert.match(detailOf(readWaitRequest({ lanes })), /lanes/, JSON.stringify(lanes));
  }
});

test('readWaitRequest: until is all or any', () => {
  for (const until of ['some', 'ALL', 1, null]) {
    assert.match(detailOf(readWaitRequest({ until })), /until/, JSON.stringify(until));
  }
  assert.equal(requestOf(readWaitRequest({ until: 'any' })).until, 'any');
});

test('readWaitRequest: timeout_s is a non-negative finite number; 0 answers now', () => {
  for (const timeout of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5', null]) {
    assert.match(detailOf(readWaitRequest({ timeout_s: timeout })), /timeout_s/, String(timeout));
  }
  assert.equal(requestOf(readWaitRequest({ timeout_s: 0 })).timeout_s, 0);
});

test('readWaitRequest: status_only is a boolean', () => {
  for (const statusOnly of ['true', 1, null]) {
    assert.match(detailOf(readWaitRequest({ status_only: statusOnly })), /status_only/, JSON.stringify(statusOnly));
  }
});

test('readWaitRequest: budget_bytes is a positive integer', () => {
  for (const budget of [0, 1.5, -1, '10', Number.POSITIVE_INFINITY]) {
    assert.match(detailOf(readWaitRequest({ budget_bytes: budget })), /budget_bytes/, String(budget));
  }
  assert.equal(requestOf(readWaitRequest({ budget_bytes: 1 })).budget_bytes, 1);
});

// ── readRunIds (ack, cancel) ──────────────────────────────────────────────

test('readRunIds: runs is required and is an array of well-formed ids', () => {
  assert.deepEqual(requestOf(readRunIds({ runs: [RUN, OTHER_RUN] })), { runs: [RUN, OTHER_RUN] });
  assert.match(detailOf(readRunIds({})), /runs/);
  for (const runs of [RUN, null, [7], ['..'], ['a/b']]) {
    assert.match(detailOf(readRunIds({ runs })), /runs/, JSON.stringify(runs));
  }
});

test('readRunIds: arguments that are not an object, or an extra field, are refused', () => {
  for (const args of NOT_OBJECTS) {
    assert.equal(detailOf(readRunIds(args)), 'arguments is not an object', JSON.stringify(args));
  }
  assert.equal(detailOf(readRunIds({ runs: [RUN], lanes: ['build'] })), 'unknown field: lanes');
});

// ── argsDigest ────────────────────────────────────────────────────────────

const LAUNCH = '/abs/launch';

/** The digest of REQUEST under the fixture launch directory. */
const digest = (request: AgentRequest): string => argsDigest(request, LAUNCH);

test('argsDigest: a sha256, in hex', () => {
  assert.match(digest(BASE), /^[0-9a-f]{64}$/);
});

test('argsDigest: ignores key', () => {
  assert.equal(digest({ ...BASE, key: 'one' }), digest(BASE));
  assert.equal(digest({ ...BASE, key: 'one' }), digest({ ...BASE, key: 'two' }));
});

test('argsDigest: ignores field order, nested ceilings included', () => {
  const ordered: AgentRequest = { prompt: 'work', profile: 'read', ceilings: { requests: 3, cost_usd: 0.5 } };
  const reordered: AgentRequest = { ceilings: { cost_usd: 0.5, requests: 3 }, profile: 'read', prompt: 'work' };
  assert.equal(digest(ordered), digest(reordered));
});

test('argsDigest: an omitted cwd is the launch directory, and a relative one resolves against it', () => {
  const omitted = digest(BASE);
  assert.equal(digest({ ...BASE, cwd: LAUNCH }), omitted);
  assert.equal(digest({ ...BASE, cwd: '.' }), omitted);
  assert.equal(digest({ ...BASE, cwd: `${LAUNCH}/` }), omitted);
  assert.equal(digest({ ...BASE, cwd: 'sub' }), digest({ ...BASE, cwd: `${LAUNCH}/sub` }));
  assert.notEqual(argsDigest(BASE, '/abs/elsewhere'), omitted, 'the launch directory is part of the request');
});

test('argsDigest: empty ceilings are the same request as none', () => {
  assert.equal(argsDigest({ ...BASE, ceilings: {} }, LAUNCH), argsDigest(BASE, LAUNCH));
});

test('argsDigest: an absent needs_success is false', () => {
  const laned: AgentRequest = { ...BASE, lane: 'build' };
  assert.equal(digest({ ...laned, needs_success: false }), digest(laned));
  assert.notEqual(digest({ ...laned, needs_success: true }), digest(laned));
});

test('argsDigest: tools in another order or repeated are the same tool set', () => {
  assert.equal(digest({ ...BASE, tools: ['read', 'grep'] }), digest({ ...BASE, tools: ['grep', 'read', 'grep'] }));
});

test('argsDigest: a different request differs', () => {
  const base = digest(BASE);
  assert.notEqual(digest({ ...BASE, prompt: 'other work' }), base);
  assert.notEqual(digest({ ...BASE, lane: 'build' }), base);
  assert.notEqual(digest({ ...BASE, tools: ['read'] }), digest({ ...BASE, tools: ['grep'] }));
});
