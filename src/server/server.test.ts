// Tests for the stdio wire (design sec-1, sec-2; the satan-mcp precedent) and
// for the pi-agent-result/1 payload every tools/call answers with.
//
// In-process: `serve(input, output, env)` takes streams, so the protocol is
// driven without a child. One real subprocess test proves `bin/pi-mcp` starts,
// answers `initialize`, and exits 0 on stdin EOF.
//
// Hermetic: every test mints its own temp tree; the ambient environment is
// never read and nothing is spawned except the shim itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, SERVER_NAME, PI_AGENT_TOOL, serve } from './server.ts';
import { attemptsPath } from './evidence.ts';

type Env = Record<string, string | undefined>;

const moduleDir = new URL('.', import.meta.url).pathname;
const repoRoot = new URL('../..', import.meta.url).pathname;

/** A policy with every declared field present, per the schema in EX-6. */
function validPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'per-call',
    roots: ['/work/one'],
    maxima: { requests: 20, tokens: 100000, cost_usd: 1.5, wall_clock_s: 600 },
    profiles: ['read', 'write'],
    forms: { read: '/nix/store/aaa/bin/pi-mcp-read', write: '/nix/store/aaa/bin/pi-mcp-write' },
    child_binds: ['/home/operator/.pi'],
    enabled: true,
    transcript_budget_bytes: 8192,
    ...overrides,
  };
}

type Workspace = { env: Env; policyPath: string; runDir: string };

function workspace(policy: unknown = validPolicy()): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-server-'));
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(policy, null, 2));
  const runDir = join(dir, 'run');
  return {
    env: {
      PI_MCP_POLICY: policyPath,
      PI_MCP_RUN_DIR: runDir,
      PI_MCP_SESSION_HOME: join(dir, 'sessions'),
    },
    policyPath,
    runDir,
  };
}

const line = (message: Record<string, unknown>): string => JSON.stringify({ jsonrpc: '2.0', ...message });

type Transcript = { replies: Record<string, any>[]; stderr: string };

/** Write LINES to a fresh `serve` and collect every reply it emits. */
async function converse(lines: string[], env: Env, chunks?: string[]): Promise<Transcript> {
  const out: string[] = [];
  const err: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      out.push(String(chunk));
      done();
    },
  });
  const diagnostics = new Writable({
    write(chunk, _encoding, done) {
      err.push(String(chunk));
      done();
    },
  });
  const input = chunks ? Readable.from(chunks) : Readable.from(lines.map((l) => `${l}\n`));
  await serve(input, output, env, diagnostics);
  const replies = out
    .join('')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, any>);
  return { replies, stderr: err.join('') };
}

function attemptLines(runDir: string): Record<string, unknown>[] {
  return readFileSync(attemptsPath(runDir), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The pi-agent-result/1 document inside a tool result, plus its isError flag. */
function payload(reply: Record<string, any>): { doc: Record<string, any>; isError: boolean } {
  assert.equal(reply.error, undefined, 'a call must never surface as a JSON-RPC error');
  assert.equal(reply.result.content.length, 1);
  assert.equal(reply.result.content[0].type, 'text');
  return { doc: JSON.parse(reply.result.content[0].text), isError: reply.result.isError };
}

/** Drive exactly one tools/call. */
async function call(
  params: unknown,
  env: Env = workspace().env,
): Promise<{ doc: Record<string, any>; isError: boolean; reply: Record<string, any> }> {
  const { replies } = await converse([line({ id: 42, method: 'tools/call', params })], env);
  assert.equal(replies.length, 1);
  return { ...payload(replies[0]), reply: replies[0] };
}

const callTool = (args: unknown): Record<string, unknown> => ({ name: 'pi_agent', arguments: args });

// ── The wire (EX-1) ────────────────────────────────────────────────────────

test('initialize answers protocolVersion, a tools capability and serverInfo', async () => {
  const { replies } = await converse([line({ id: 1, method: 'initialize' })], workspace().env);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].jsonrpc, '2.0');
  assert.equal(replies[0].id, 1);
  assert.equal(replies[0].result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(PROTOCOL_VERSION, '2025-06-18');
  assert.deepEqual(replies[0].result.capabilities, { tools: {} });
  assert.equal(replies[0].result.serverInfo.name, SERVER_NAME);
});

test('notifications/initialized is a no-op and ping is served, neither rejected as an unknown method', async () => {
  const { replies } = await converse(
    [line({ method: 'notifications/initialized' }), line({ id: 2, method: 'ping' })],
    workspace().env,
  );
  assert.equal(replies.length, 1, 'only ping answers; the notification is a no-op');
  assert.equal(replies[0].id, 2);
  assert.deepEqual(replies[0].result, { pong: true });
  assert.equal(replies[0].error, undefined);
});

test('notifications/cancelled is accepted as a no-op, not rejected as an unknown method', async () => {
  const { replies, stderr } = await converse(
    [
      line({ method: 'notifications/cancelled', params: { requestId: 99 } }),
      line({ id: 3, method: 'ping' }),
    ],
    workspace().env,
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 3);
  assert.equal(stderr, '');
});

test('tools/list exposes exactly one tool, pi_agent, with its declared inputSchema', async () => {
  const { replies } = await converse([line({ id: 4, method: 'tools/list' })], workspace().env);
  const tools = replies[0].result.tools as Record<string, any>[];
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'pi_agent');
  assert.deepEqual(tools[0], PI_AGENT_TOOL);
  assert.deepEqual(tools[0].inputSchema.required, ['prompt', 'profile']);
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  assert.equal(tools[0].inputSchema.properties.ceilings.additionalProperties, false);
  assert.equal(tools[0].inputSchema.properties.transcript_budget_bytes.type, 'integer');
  assert.equal(tools[0].inputSchema.properties.tools.items.type, 'string');
});

test('an unknown method answers -32601 with the request id', async () => {
  const { replies } = await converse([line({ id: 5, method: 'resources/list' })], workspace().env);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 5);
  assert.equal(replies[0].result, undefined);
  assert.equal(replies[0].error.code, -32601);
  assert.match(replies[0].error.message, /resources\/list/);
});

test('a notification naming an unknown method answers nothing: there is no id to answer', async () => {
  const { replies } = await converse([line({ method: 'resources/list' })], workspace().env);
  assert.deepEqual(replies, []);
});

test('LF framing: several records in one chunk and a CRLF record are all read', async () => {
  const chunk =
    `${line({ id: 6, method: 'ping' })}\n` +
    `${line({ id: 7, method: 'ping' })}\r\n` +
    `${line({ id: 8, method: 'ping' })}\n`;
  const { replies } = await converse([], workspace().env, [chunk]);
  assert.deepEqual(
    replies.map((r) => r.id),
    [6, 7, 8],
  );
});

test('an unparsable line produces no response, only a stderr note, and the loop survives it', async () => {
  const { replies, stderr } = await converse(
    ['{"jsonrpc":"2.0",', line({ id: 9, method: 'ping' })],
    workspace().env,
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 9);
  assert.match(stderr, /unparsable/);
});

test('bin/pi-mcp starts, answers initialize and exits 0 on stdin EOF', () => {
  const { env } = workspace();
  const child = spawnSync(join(repoRoot, 'bin', 'pi-mcp'), [], {
    input: `${line({ id: 1, method: 'initialize' })}\n`,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, any>);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
});

// ── A malformed request is a tool result, never a JSON-RPC error (EX-2) ─────

test('a malformed params object is refused request-invalid, naming the field', async () => {
  const cases: { params: unknown; field: RegExp }[] = [
    { params: 'not-an-object', field: /params/ },
    { params: { name: 'pi_agent', arguments: 7 }, field: /arguments/ },
    { params: callTool({ profile: 'read' }), field: /prompt/ },
    { params: callTool({ prompt: 'hi' }), field: /profile/ },
    { params: callTool({ prompt: 'hi', profile: 'read', speed: 'fast' }), field: /speed/ },
    { params: callTool({ prompt: 7, profile: 'read' }), field: /prompt/ },
    { params: callTool({ prompt: 'hi', profile: 'read', tools: 'bash' }), field: /tools/ },
    { params: callTool({ prompt: 'hi', profile: 'read', ceilings: { requests: '20' } }), field: /ceilings\.requests/ },
    {
      params: callTool({ prompt: 'hi', profile: 'read', transcript_budget_bytes: 1.5 }),
      field: /transcript_budget_bytes/,
    },
    { params: { name: 'pi_other', arguments: {} }, field: /name/ },
  ];
  for (const { params, field } of cases) {
    const { doc, isError, reply } = await call(params);
    assert.equal(reply.error, undefined);
    assert.equal(isError, true);
    assert.equal(doc.schema, 'pi-agent-result/1');
    assert.equal(doc.state, 'refused');
    assert.equal(doc.termination, 'refused');
    assert.deepEqual(doc.causes, ['refused']);
    assert.equal(doc.session, null);
    assert.equal(doc.status, null);
    assert.equal(doc.artifacts, null);
    assert.equal(doc.result, null);
    assert.equal(doc.refusal.reason, 'request-invalid');
    assert.match(doc.refusal.detail, field);
  }
});

test('a request-invalid refusal reaches attempts.jsonl with the call id', async () => {
  const { runDir, env } = workspace();
  await call(callTool({ prompt: 'hi', profile: 'read', speed: 'fast' }), env);
  const lines = attemptLines(runDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'request-invalid');
  assert.equal(lines[0].call_id, 42);
});

// ── The admitted-but-unbuilt seam (EX-2: a failure is `failed`) ─────────────

// PHASE-03 moved the seam past steps 3-6, so this call now needs a root that
// exists and is allowlisted; nothing else about the call changed.
test('a call past steps 3-6 reports the spawn seam as failed, with isError', async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'pi-mcp-server-root-')), 'root');
  mkdirSync(root, { recursive: true });
  const { runDir, env } = workspace(validPolicy({ roots: [root] }));
  const { doc, isError, reply } = await call(
    callTool({ prompt: 'review this', profile: 'read', cwd: root }),
    env,
  );
  assert.equal(reply.error, undefined);
  assert.equal(isError, true);
  assert.equal(doc.schema, 'pi-agent-result/1');
  assert.equal(doc.state, 'failed');
  assert.equal(doc.termination, 'spawn');
  assert.deepEqual(doc.causes, ['spawn']);
  // PHASE-04: step 7 precedes the seam, so an admitted call carries the session it
  // minted (sec-5: `session` is always present).
  assert.match(String(doc.session), /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/);
  assert.equal(doc.status, null);
  assert.equal(doc.artifacts, null);
  assert.equal(doc.result, null);
  assert.deepEqual(doc.refusal, null);
  assert.match(doc.transcript, /not built|no run/i);

  const lines = attemptLines(runDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'spawn');
  assert.match(String(lines[0].policy_digest), /^[0-9a-f]{64}$/);
});

// ── A policy refusal is a tool result too (EX-3, EX-5) ─────────────────────

test('a policy refusal reaches the caller as a tool result and the ledger', async () => {
  const { runDir, env } = workspace(validPolicy({ enabled: false }));
  const { doc, isError, reply } = await call(callTool({ prompt: 'hi', profile: 'read' }), env);
  assert.equal(reply.error, undefined);
  assert.equal(isError, true);
  assert.equal(doc.state, 'refused');
  assert.equal(doc.refusal.reason, 'disabled');
  const lines = attemptLines(runDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'disabled');
});

// ── Jaw policy belongs to the flake (EX-7) ─────────────────────────────────

test('no member of pi/mcp outside its tests authors a jail flag (design sec-3, SPEC-001 REQ-009)', () => {
  // The tokens the server must never author: --ro-bind, --bind, --tmpfs, bwrap.
  // Jail policy is the flake's; a flag in this module would be a second story.
  const forbidden = /(--ro-bind|--bind|--tmpfs|\bbwrap\b)/;
  const sources = readdirSync(moduleDir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  assert.ok(sources.includes('server.ts'), 'the scan must see the server module');
  const offenders: string[] = [];
  for (const name of sources) {
    const text = readFileSync(join(moduleDir, name), 'utf8');
    text.split('\n').forEach((sourceLine, index) => {
      if (forbidden.test(sourceLine)) offenders.push(`${name}:${index + 1}: ${sourceLine.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
