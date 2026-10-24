// Tests for the stdio wire (design sec-1, sec-2; the satan-mcp precedent) and
// for the pi-agent-result/2 payload every tools/call answers with.
//
// In-process: `serve(input, output, env)` takes streams, so the protocol is
// driven without a child. Real subprocess tests prove the bin starts, answers
// `initialize`, exits 0 on stdin EOF, and shuts down on SIGTERM.
//
// Hermetic: every test mints its own temp tree; the ambient environment is
// never read and nothing is spawned except the server and the rig's stubs.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packageVersion } from '../root.ts';
import { PROTOCOL_VERSION, PI_AGENT_TOOL } from './server.ts';
import {
  attempts,
  callLine,
  converse,
  executableAt,
  isAlive,
  jsonLines,
  line,
  markerPids,
  newRig,
  onlyRunDir,
  patchPolicy,
  plantProjectForm,
  profileDocument,
  readText,
  rigApprovalsPath,
  rigForm,
  runDirs,
  SETTLED,
  serveRig,
  serverCommand,
  spawnRecord,
  validPolicy,
  waitForPath,
  workspace,
  writeApprovals,
  writeProfiles,
  xdgHelpLayer,
  xdgProfileLayer, type Env, type Rig, type RigForm 
} from './test-rig.ts';

const moduleDir = new URL('.', import.meta.url).pathname;

/** The pi-agent-result/2 document inside a tool result, plus its isError flag. */
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

test('initialize answers protocolVersion, a tools capability and serverInfo: quotient at the package version', async () => {
  const { replies } = await converse([line({ id: 1, method: 'initialize' })], workspace().env);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].jsonrpc, '2.0');
  assert.equal(replies[0].id, 1);
  assert.equal(replies[0].result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(PROTOCOL_VERSION, '2025-06-18');
  assert.deepEqual(replies[0].result.capabilities, { tools: {} });
  assert.deepEqual(replies[0].result.serverInfo, { name: 'quotient', version: packageVersion() });
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
  assert.deepEqual(Object.keys(tools[0]), ['name', 'description', 'inputSchema']);
  assert.deepEqual(tools[0].inputSchema, PI_AGENT_TOOL.inputSchema);
  assert.deepEqual(tools[0].inputSchema.required, ['prompt', 'profile']);
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  assert.equal(tools[0].inputSchema.properties.ceilings.additionalProperties, false);
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties.ceilings.properties), [
    'requests', 'context_tokens', 'cost_usd', 'wall_clock_s',
  ]);
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
  const { replies } = await converse([], workspace().env, { chunks: [chunk] });
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
  assert.match(stderr, /^quotient: unparsable/m);
});

test('the server process starts, answers initialize and exits 0 on stdin EOF', () => {
  const { env, dir } = workspace();
  const child = spawnSync(...serverCommand, {
    cwd: dir,
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

// ── Shutdown: EOF, the AbortSignal and the process's signals (DEC-118) ──────

/** A stub that reports its pid, ignores SIGTERM and sleeps: only the group
 *  SIGKILL at the end of the ladder ends it. */
const STUBBORN = ['printf \'%s\\n\' $$ > "@MARKER@/pid"', "trap '' TERM", 'sleep 60'].join('\n');

/** The shutdown path's evidence: the stub is gone, and its run audited an abort
 *  with cause eof followed by the group SIGKILL's exit. */
function assertShutDown(rig: Rig, pid: number): void {
  assert.equal(isAlive(pid), false, 'the run was aborted, not left behind');
  const records = jsonLines(join(onlyRunDir(rig.runDir), 'audit.jsonl'));
  assert.deepEqual(
    records.map((record) => record.record),
    ['spawn', 'abort', 'exit'],
  );
  assert.equal(records[1].cause, 'eof');
  assert.equal(records[2].signal, 'SIGKILL');
}

test('the AbortSignal runs the stdin-EOF shutdown path: abort in flight with cause eof, await the ladder, return', async (t) => {
  const rig = newRig(t, { read: STUBBORN });
  const shutdown = new AbortController();
  const server = serveRig(rig, { graceMs: 200, signal: shutdown.signal });
  server.write(callLine(61, { prompt: 'work', profile: 'read', cwd: rig.root }));
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');
  const [pid] = markerPids(rig);

  // The input stays open: only the signal ends the server.
  shutdown.abort();
  await server.done;

  assert.deepEqual(server.replies(), [], 'no result is written once shutdown begins');
  assertShutDown(rig, pid);
});

test('a failed input stream takes the same shutdown path as EOF', async (t) => {
  const rig = newRig(t, { read: STUBBORN });
  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(62, { prompt: 'work', profile: 'read', cwd: rig.root }));
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');
  const [pid] = markerPids(rig);

  server.fail(new Error('EPIPE'));
  await server.done;

  assert.deepEqual(server.replies(), []);
  assert.match(server.stderr(), /^quotient: the input failed: EPIPE$/m);
  assertShutDown(rig, pid);
});

test('a signal aborted before serve starts admits nothing', async (t) => {
  const rig = newRig(t, { read: STUBBORN });
  const server = serveRig(rig, { signal: AbortSignal.abort() });
  server.write(callLine(63, { prompt: 'work', profile: 'read', cwd: rig.root }));
  await server.done;

  assert.deepEqual(server.replies(), []);
  assert.deepEqual(readdirSync(rig.markerDir), [], 'no launcher ran');
});

test('SIGTERM to the server process shuts down through the same path and exits 0', async (t) => {
  const rig = newRig(t, { read: STUBBORN });
  const server = spawn(...serverCommand, { cwd: rig.launchDir, env: rig.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr: string[] = [];
  server.stderr.on('data', (chunk: Buffer) => stderr.push(String(chunk)));
  const exited = new Promise<number | null>((resolve) => server.once('exit', (code) => { resolve(code); }));
  t.after(() => server.kill('SIGKILL'));

  server.stdin.write(`${callLine(64, { prompt: 'work', profile: 'read', cwd: rig.root })}\n`);
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');
  const [pid] = markerPids(rig);

  server.kill('SIGTERM');
  assert.equal(await exited, 0, stderr.join(''));
  assertShutDown(rig, pid);
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
    { params: callTool({ prompt: 'hi', profile: 'read', ceilings: { tokens: 20 } }), field: /ceilings\.context_tokens/ },
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
    assert.equal(doc.schema, 'pi-agent-result/2');
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
  const lines = attempts(runDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'request-invalid');
  assert.equal(lines[0].call_id, 42);
});

test('with every QUOTIENT_* unset, request-boundary and admission refusals both land in attempts.jsonl under the XDG run dir', async () => {
  const base = mkdtempSync(join(tmpdir(), 'quotient-xdg-'));
  const env: Env = { XDG_CONFIG_HOME: join(base, 'config'), XDG_STATE_HOME: join(base, 'state') };
  mkdirSync(join(base, 'config', 'quotient'), { recursive: true });
  writeFileSync(join(base, 'config', 'quotient', 'policy.json'), '{ not json');

  await call(callTool({ prompt: 'hi', profile: 'read', speed: 'fast' }), env);
  await call(callTool({ prompt: 'hi', profile: 'read' }), env);

  const lines = attempts(join(base, 'state', 'quotient', 'runs'));
  assert.deepEqual(lines.map((l) => l.reason), ['request-invalid', 'policy-invalid']);
});

// ── The run seam (EX-2: a failure is `failed`, never a JSON-RPC error) ─────

// PHASE-06 replaced the placeholder with the run: this call passes steps 1-8 and
// reaches a launch form that does not exist, so the spawn itself fails — a
// process failure after the run directory was allocated, not a refusal. Its
// evidence is the run's audit; the refusal ledger stays empty (design sec-6).
test('a launch form that cannot be executed reports failed with termination spawn, with the run audit beside it', async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'pi-mcp-server-root-')), 'root');
  mkdirSync(root, { recursive: true });
  const { runDir, env, dir } = workspace(validPolicy({ roots: [root] }));
  const { doc, isError, reply } = await call(
    callTool({ prompt: 'review this', profile: 'read', cwd: root }),
    env,
  );
  assert.equal(reply.error, undefined);
  assert.equal(isError, true);
  assert.equal(doc.schema, 'pi-agent-result/2');
  assert.equal(doc.state, 'failed');
  assert.equal(doc.termination, 'spawn');
  assert.deepEqual(doc.causes, ['spawn']);
  // PHASE-04: step 7 precedes the seam, so an admitted call carries the session it
  // minted (sec-5: `session` is always present).
  assert.match(String(doc.session), /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/);
  assert.equal(doc.result, null);
  assert.equal(doc.final, false);
  assert.deepEqual(doc.refusal, null);
  // The run directory exists — step 8 passed — so the outcome is the run's audit,
  // not a ledger line: `spawn` before the launch and `exit` with no code.
  const audit = jsonLines(join(onlyRunDir(runDir), 'audit.jsonl'));
  assert.deepEqual(audit.map((line) => line.record), ['spawn', 'exit']);
  assert.match(String(audit[0].policy_digest), /^[0-9a-f]{64}$/);
  assert.match(String(audit[0].profile_digest), /^[0-9a-f]{64}$/);
  assert.equal(audit[0].profile_source, join(xdgProfileLayer(dir), 'read.md'), 'the winning document is audited');
  assert.equal(audit[1].code, null);
  assert.equal(audit[1].spawn_failed, true);
  assert.equal(attempts(runDir).length, 0);
});

// ── The launch directory is not a layer (SL-002 PHASE-01, ISS-001) ─────────

/** A form that records that it ran, then settles and exits 0. */
const MARKED = ['printf \'%s\\n\' $$ > "@MARKER@/pid"', SETTLED, 'exit 0'].join('\n');

// The normal case: an MCP client launched inside the project it works on, with
// that project also the policy's root. It was refused `view-overlaps-protected`
// because the launch dir supplied profile and help layers that step 8 protected.
// The layers are XDG-only, so there is nothing in the root to overlap.
test('a write call rooted at the launch directory is admitted (ISS-001)', async (t) => {
  const rig = newRig(t, { write: MARKED });
  const server = serveRig(rig, { launchDir: rig.root });
  server.write(callLine(71, { prompt: 'work', profile: 'write', cwd: rig.root }));
  // The write form runs only past step 8: the root that contains the launch dir
  // is admitted, and no refusal named the child view.
  await waitForPath(join(rig.markerDir, 'pid'), 'the write form');
  server.end();
  await server.done;
  for (const reply of server.replies()) {
    const { doc } = payload(reply);
    assert.equal(field(doc, 'refusal'), null, `the call was admitted, not refused: ${JSON.stringify(reply)}`);
  }
});

// ── The admitted form (SL-002 PHASE-04, design sec-2 step 5) ───────────────

/** A form that appends NAME to the rig's marker file, records its own `$0` and
 *  argv, then settles: which form ran, and what it was handed, is then readable. */
const marks = (name: string): string =>
  `printf '${name}\\n' >> "@MARKER@/forms"\nprintf '%s\\n' "$0" > "@MARKER@/argv0"\nprintf '%s\\n' "$@" > "@MARKER@/argv"\n${SETTLED}\nexit 0`;

/** Every form that ran in RIG, in order, by the name its marker records. */
function formsRun(rig: Rig): string[] {
  const text = readText(join(rig.markerDir, 'forms')).trim();
  return text.length === 0 ? [] : text.split('\n');
}

/** One tools/call against RIG: the answer `payload` reads, as it reads it. */
type RigReply = ReturnType<typeof payload>;

/** One tools/call against RIG. */
async function rigCall(
  rig: Rig,
  args: Record<string, unknown> = { prompt: 'work', profile: 'write', cwd: rig.root },
): Promise<RigReply> {
  const { replies } = await converse([callLine(7, args)], rig.env, { launchDir: rig.launchDir });
  assert.equal(replies.length, 1);
  return payload(replies[0]);
}

/** The run's `spawn` record: what was launched, and from where. */
const spawnOf = (rig: Rig): Record<string, unknown> => spawnRecord(join(onlyRunDir(rig.runDir), 'audit.jsonl'));

/** A refusal as an operator reads it: its reason and the detail that says why. */
function refusalOf(doc: unknown): { reason: string; detail: string } {
  const refusal = field(doc, 'refusal');
  return { reason: String(field(refusal, 'reason')), detail: String(field(refusal, 'detail')) };
}

/** A call step 5 must refuse before the spawn: its refusal, and the proof that
 *  nothing ran — no marker, no run directory. */
async function refusedFormCall(
  rig: Rig,
  args: Record<string, unknown> = { prompt: 'work', profile: 'write', cwd: rig.root },
): Promise<{ reason: string; detail: string }> {
  const { doc } = await rigCall(rig, args);
  assert.deepEqual(formsRun(rig), [], 'no form ran');
  assert.deepEqual(runDirs(rig.runDir), [], 'no run directory was allocated');
  return refusalOf(doc);
}

/** Plant and approve RIG's project form at its roots entry: the identity the
 *  store records, and the link the project publishes. */
function approveProjectForm(rig: Rig, body: string = marks('approved')): { form: RigForm; link: string } {
  const form = rigForm(rig, 'approved', body);
  const link = plantProjectForm(rig, form);
  writeApprovals(rig, [{ form }]);
  return { form, link };
}

test('with no project link and no approvals store the machine form runs, and the record names the policy', async (t) => {
  const rig = newRig(t, { write: marks('machine') });
  const { doc } = await rigCall(rig);
  assert.equal(field(doc, 'refusal'), null, 'the call was admitted, not refused');
  assert.deepEqual(formsRun(rig), ['machine']);
  const spawn = spawnOf(rig);
  assert.equal(spawn.form_source, 'policy');
  assert.equal(spawn.form, rig.writeLauncher);
  assert.equal(Object.hasOwn(spawn, 'form_root'), false, 'a machine form has no approved root');
  assert.equal(Object.hasOwn(spawn, 'form_sha256'), false, 'a machine form has no approved identity');
});

/** A write profile that names an `mcp__*` tool: step 5 refuses it unless the
 *  slot declares `builtin:mcp`, and the argv must then carry it. The *inherited*
 *  list itself is only observable on the selected form, so `forms.test.ts`
 *  asserts it; at the wire the extension's effect is the `-e` pair. */
const MCP_PROFILE = profileDocument({ filesystem: 'write', tools: 'read, bash, mcp__files__read' });

test('an approved project form runs its real path, and the slot extension reaches the launcher', async (t) => {
  const rig = newRig(t, { write: marks('machine') });
  patchPolicy(rig, 'forms', { read: rig.readLauncher, write: { path: rig.writeLauncher, extensions: ['builtin:mcp'] } });
  patchPolicy(rig, 'profiles', { read: 'read', write: 'write', 'write-mcp': 'write' });
  writeProfiles(rig.profilesDir, { 'write-mcp': MCP_PROFILE });
  const { form, link } = approveProjectForm(rig);
  const { doc } = await rigCall(rig, { prompt: 'work', profile: 'write-mcp', cwd: rig.root });
  assert.equal(field(doc, 'refusal'), null, 'the call was admitted, not refused');
  assert.deepEqual(formsRun(rig), ['approved']);
  const spawn = spawnOf(rig);
  assert.equal(spawn.form_source, 'project');
  assert.equal(spawn.form_root, rig.root);
  assert.equal(spawn.form_sha256, form.sha256);
  assert.equal(spawn.form, form.path, 'the spawn execs the real path');
  assert.notEqual(spawn.form, link, 'never the project link');
  const argv = readText(join(rig.markerDir, 'argv')).trim().split('\n');
  assert.equal(argv[argv.indexOf('-e') + 1], 'builtin:mcp', 'the extension pair reaches the launcher');
});

test('a usable project link with no approval refuses form-unapproved and names the approval command', async (t) => {
  const rig = newRig(t, { write: marks('machine') });
  const form = rigForm(rig, 'approved', marks('approved'));
  const link = plantProjectForm(rig, form);
  const failure = await refusedFormCall(rig);
  assert.equal(failure.reason, 'form-unapproved');
  for (const named of [link, form.path, form.sha256]) {
    assert.ok(failure.detail.includes(named), `${named} in ${failure.detail}`);
  }
  assert.ok(
    failure.detail.includes(`quotient allow ${rig.root} write=${form.path}@${form.sha256}`),
    failure.detail,
  );
});

// ── Identity: a rebuilt, repointed or deleted form (VT-2) ─────────────────

test('an approved form whose bytes changed refuses form-unapproved, naming both identities', async (t) => {
  const rig = newRig(t, { write: marks('machine') });
  const { form, link } = approveProjectForm(rig);
  const rebuilt = executableAt(form.path, marks('rebuilt'));
  assert.notEqual(rebuilt.sha256, form.sha256, 'the rebuild must change the bytes');
  const failure = await refusedFormCall(rig);
  assert.equal(failure.reason, 'form-unapproved');
  for (const named of [link, form.sha256, rebuilt.sha256]) {
    assert.ok(failure.detail.includes(named), `${named} in ${failure.detail}`);
  }
  assert.ok(
    failure.detail.includes(`quotient allow ${rig.root} write=${form.path}@${rebuilt.sha256}`),
    failure.detail,
  );
});

test('an approved form repointed to another executable refuses form-unapproved, naming both paths', async (t) => {
  const rig = newRig(t, { write: marks('machine') });
  const { form, link } = approveProjectForm(rig);
  const other = rigForm(rig, 'other', marks('other'));
  unlinkSync(link);
  symlinkSync(other.path, link);
  const failure = await refusedFormCall(rig);
  assert.equal(failure.reason, 'form-unapproved');
  for (const named of [form.path, other.path]) {
    assert.ok(failure.detail.includes(named), `${named} in ${failure.detail}`);
  }
});

test('an approved form whose link was deleted refuses form-invalid, never the machine form', async (t) => {
  const rig = newRig(t, { write: marks('machine') });
  const { link } = approveProjectForm(rig);
  unlinkSync(link);
  const failure = await refusedFormCall(rig);
  assert.equal(failure.reason, 'form-invalid');
  assert.ok(failure.detail.includes(`quotient revoke ${rig.root}`), failure.detail);
  assert.match(failure.detail, /restore it/);
});

// ── The governed rows: nesting, stale roots, unusable links, slots (VT-3) ──

/** A rig with an approval at its roots entry and a second at `deep`: the nesting
 *  the deepest-governs rule is read against. */
function nestedApprovals(t: TestContext): { rig: Rig; outer: RigForm; deep: RigForm; deepRoot: string } {
  const rig = newRig(t, { write: marks('machine') });
  const deepRoot = join(rig.root, 'deep');
  mkdirSync(deepRoot);
  const outer = rigForm(rig, 'outer', marks('outer'));
  const deep = rigForm(rig, 'deep', marks('deep'));
  plantProjectForm(rig, outer);
  plantProjectForm(rig, deep, { base: deepRoot });
  writeApprovals(rig, [{ form: outer }, { root: deepRoot, form: deep }]);
  return { rig, outer, deep, deepRoot };
}

test('the deepest approval containing the call governs it', async (t) => {
  const { rig, deep, deepRoot } = nestedApprovals(t);
  await rigCall(rig, { prompt: 'work', profile: 'write', cwd: deepRoot });
  assert.deepEqual(formsRun(rig), ['deep']);
  const spawn = spawnOf(rig);
  assert.equal(spawn.form_root, deepRoot);
  assert.equal(spawn.form_sha256, deep.sha256);
});

test('a shallower approval governs calls outside the deeper root', async (t) => {
  const { rig, outer } = nestedApprovals(t);
  await rigCall(rig);
  assert.deepEqual(formsRun(rig), ['outer']);
  const spawn = spawnOf(rig);
  assert.equal(spawn.form_root, rig.root);
  assert.equal(spawn.form_sha256, outer.sha256);
});

test('an approval whose root is no longer a roots entry still governs it', async (t) => {
  const rig = newRig(t, { write: marks('machine') });
  const stale = join(rig.root, 'stale');
  mkdirSync(stale);
  const form = rigForm(rig, 'approved', marks('approved'));
  plantProjectForm(rig, form, { base: stale });
  writeApprovals(rig, [{ root: stale, form }]);
  await rigCall(rig, { prompt: 'work', profile: 'write', cwd: stale });
  assert.deepEqual(formsRun(rig), ['approved'], 'no silent revert to the machine form');
  assert.equal(spawnOf(rig).form_root, stale);
});

test('a link resolving inside a roots entry, an exposure path or the session home refuses form-invalid', async (t) => {
  for (const where of ['a roots entry', 'an exposure path', 'the session home'] as const) {
    const rig = newRig(t, { write: marks('machine') });
    if (where === 'an exposure path') {patchPolicy(rig, 'exposure', [join(rig.dir, 'exposure')]);}
    const writablePath = { 'a roots entry': rig.root, 'an exposure path': join(rig.dir, 'exposure'), 'the session home': rig.sessionHome }[where];
    plantProjectForm(rig, executableAt(join(writablePath, 'form.sh'), marks('inside')));
    const failure = await refusedFormCall(rig);
    assert.equal(failure.reason, 'form-invalid', where);
    assert.match(failure.detail, /inside the writable path/, where);
  }
});

test('a link that is not executable, dangles, or sits under a file refuses form-invalid', async (t) => {
  const planters: { name: string; plant: (rig: Rig) => void }[] = [
    {
      name: 'not executable',
      plant: (rig): void => {
        const form = rigForm(rig, 'plain', marks('plain'));
        chmodSync(form.path, 0o644);
        plantProjectForm(rig, form);
      },
    },
    {
      name: 'dangling',
      plant: (rig): void => {
        const dir = join(rig.root, '.quotient', 'forms');
        mkdirSync(dir, { recursive: true });
        symlinkSync(join(rig.dir, 'gone.sh'), join(dir, 'write'));
      },
    },
    {
      name: 'under a file',
      plant: (rig): void => {writeFileSync(join(rig.root, '.quotient'), 'not a directory\n');},
    },
  ];
  for (const { name, plant } of planters) {
    const rig = newRig(t, { write: marks('machine') });
    plant(rig);
    const failure = await refusedFormCall(rig);
    assert.equal(failure.reason, 'form-invalid', name);
  }
});

test('a project link at an unconfined machine slot refuses form-invalid (rule 4)', async (t) => {
  const rig = newRig(t, { write: marks('machine') });
  patchPolicy(rig, 'forms', { read: rig.readLauncher, write: { unconfined: join(rig.dir, 'bin', 'pi') } });
  plantProjectForm(rig, rigForm(rig, 'approved', marks('approved')));
  const failure = await refusedFormCall(rig);
  assert.equal(failure.reason, 'form-invalid');
  assert.match(failure.detail, /only a confined machine slot/);
});

test('a project link with no machine slot refuses wrapper-unavailable, as today', async (t) => {
  const rig = newRig(t, { write: marks('machine') });
  patchPolicy(rig, 'forms', { read: rig.readLauncher });
  plantProjectForm(rig, rigForm(rig, 'approved', marks('approved')));
  const failure = await refusedFormCall(rig);
  assert.equal(failure.reason, 'wrapper-unavailable');
});

/** Write a store the reader rejects, at the rig's store path. */
function corruptStore(rig: Rig): string {
  const path = rigApprovalsPath(rig);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `{"schema":"quotient-approvals/1"}\n`);
  return path;
}

test('a malformed approvals store refuses form-unapproved and names the store, even with no link', async (t) => {
  const rig = newRig(t, { write: marks('machine') });
  const store = corruptStore(rig);
  const failure = await refusedFormCall(rig);
  assert.equal(failure.reason, 'form-unapproved');
  assert.ok(failure.detail.includes(store), failure.detail);
  assert.match(failure.detail, /malformed/);
});

test('a profile the slot cannot deliver refuses profile-invalid before the store is read', async (t) => {
  const rig = newRig(t, { write: marks('machine') });
  patchPolicy(rig, 'profiles', { read: 'read', write: 'write', 'write-mcp': 'write' });
  writeProfiles(rig.profilesDir, { 'write-mcp': MCP_PROFILE });
  corruptStore(rig);
  const failure = await refusedFormCall(rig, { prompt: 'work', profile: 'write-mcp', cwd: rig.root });
  assert.equal(failure.reason, 'profile-invalid');
  assert.match(failure.detail, /passes no "-e builtin:mcp"/);
});

// ── The real path at admission: retarget and repoint (VT-1, VT-4) ─────────

/** The RV-006 F-1 tree: `work` holds the approved project `work/A` and a
 *  `current` alias a delegate can retarget, inside or away from `A`. */
function aliasedRig(
  t: TestContext,
  options: { alias: 'into the approval' | 'away from the approval'; roots: 'entry first' | 'alias first' },
): { rig: Rig; approvedRoot: string; form: RigForm } {
  const rig = newRig(t, { write: marks('machine') });
  const work = join(rig.dir, 'work');
  const approvedRoot = join(work, 'A');
  mkdirSync(join(approvedRoot, 'sub'), { recursive: true });
  mkdirSync(join(work, 'other'));
  const current = join(work, 'current');
  symlinkSync(options.alias === 'into the approval' ? join(approvedRoot, 'sub') : join(work, 'other'), current);
  patchPolicy(rig, 'roots', options.roots === 'entry first' ? [work, current] : [current, work]);
  const form = rigForm(rig, 'approved', marks('approved'));
  plantProjectForm(rig, form, { base: approvedRoot });
  writeApprovals(rig, [{ root: approvedRoot, form }]);
  return { rig, approvedRoot, form };
}

test('a roots entry retargeted into or away from an approved project still runs its form (RV-006 F-1)', async (t) => {
  for (const roots of ['entry first', 'alias first'] as const) {
    for (const alias of ['into the approval', 'away from the approval'] as const) {
      const where = `roots ${roots}, alias ${alias}`;
      const { rig, approvedRoot, form } = aliasedRig(t, { alias, roots });
      // The call lands inside the approved project either way: through the alias
      // when it points there, by its real path when it does not.
      const cwd = alias === 'into the approval' ? join(rig.dir, 'work', 'current') : join(approvedRoot, 'sub');
      await rigCall(rig, { prompt: 'work', profile: 'write', cwd });
      assert.deepEqual(formsRun(rig), ['approved'], where);
      const spawn = spawnOf(rig);
      assert.equal(spawn.form_source, 'project', where);
      assert.equal(spawn.form_root, approvedRoot, where);
      assert.equal(spawn.form_sha256, form.sha256, where);
    }
  }
});

test('the spawn execs the resolved real path, and a later repoint changes neither record nor $0', async (t) => {
  const rig = newRig(t, { write: marks('machine') });
  const { form, link } = approveProjectForm(rig);
  await rigCall(rig);
  assert.deepEqual(formsRun(rig), ['approved']);
  assert.equal(spawnOf(rig).form, form.path);
  assert.notEqual(spawnOf(rig).form, link, 'never the link');
  assert.equal(readText(join(rig.markerDir, 'argv0')).trim(), form.path, 'the launcher was exec\'d by its real path');
  // Repointed after admission: the run that already happened is unaffected, and
  // its launcher's own `$0` — read from the marker it wrote — still names the
  // real path. (The record was written before the repoint and cannot move, so
  // re-reading it would prove nothing.)
  const other = rigForm(rig, 'other', marks('other'));
  unlinkSync(link);
  symlinkSync(other.path, link);
  assert.equal(readText(join(rig.markerDir, 'argv0')).trim(), form.path);
});

// ── Legacy launch-dir layers fail start-up (DEC-011) ─────────────────────

/** One field of a parsed JSON value; a test failure when it is not an object. */
function field(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) {assert.fail(`no ${name}: not an object (${JSON.stringify(value)})`);}
  return Reflect.get(value, name);
}

/** One element of a parsed JSON array; a test failure when it is not one. */
function element(value: unknown, index: number): unknown {
  if (!Array.isArray(value)) {assert.fail(`no element ${String(index)}: not an array`);}
  return value[index];
}

/** Plant one legacy launch-dir layer under the rig's launch dir; its path. */
function plantLegacy(rig: Rig, kind: 'profiles' | 'help'): string {
  const layer = join(rig.launchDir, '.quotient', kind);
  mkdirSync(layer, { recursive: true });
  if (kind === 'profiles') {writeFileSync(join(layer, 'probe.md'), '# a document from an older install\n');}
  return layer;
}

/** One start-up refusal: its stderr line, the two rendered descriptions, and
 *  the refusal every call inherits. */
async function startUpRefusal(rig: Rig): Promise<{
  instructions: string;
  description: string;
  refusal: { reason: string; detail: string };
  stderr: string;
}> {
  const { replies, stderr } = await converse(
    [
      line({ id: 1, method: 'initialize' }),
      line({ id: 2, method: 'tools/list' }),
      callLine(3, { prompt: 'hi', profile: 'read', cwd: rig.root }),
    ],
    rig.env,
    { launchDir: rig.launchDir },
  );
  assert.equal(replies.length, 3);
  const doc: unknown = payload(replies[2]).doc;
  assert.equal(field(doc, 'state'), 'refused');
  const refusal = field(doc, 'refusal');
  return {
    instructions: String(field(field(replies[0], 'result'), 'instructions')),
    description: String(field(element(field(field(replies[1], 'result'), 'tools'), 0), 'description')),
    refusal: { reason: String(field(refusal, 'reason')), detail: String(field(refusal, 'detail')) },
    stderr,
  };
}

test('a legacy launch-dir profile layer fails start-up, naming the path and the XDG destination (DEC-011)', async (t) => {
  const rig = newRig(t);
  const layer = plantLegacy(rig, 'profiles');
  const destination = xdgProfileLayer(rig.dir);
  const failure = await startUpRefusal(rig);

  // One stderr line, which is the whole start-up refusal (design sec-2).
  assert.deepEqual(
    failure.stderr.split('\n').filter((text) => text.length > 0),
    [
      `quotient: start-up did not complete: ${layer}: quotient no longer reads profiles from the launch directory; ` +
        `move these documents to ${destination}/ and restart`,
    ],
  );
  for (const text of [failure.instructions, failure.description]) {assert.ok(text.includes(layer), text);}
  assert.match(failure.instructions, /refused start-up/);
  assert.equal(failure.refusal.reason, 'profile-invalid');
  assert.ok(failure.refusal.detail.includes(layer), failure.refusal.detail);
  assert.match(failure.refusal.detail, /quotient no longer reads profiles from the launch directory/);
  assert.match(failure.refusal.detail, /and restart$/);
  assert.deepEqual(readdirSync(rig.markerDir), [], 'no launcher ran');
});

test('a legacy launch-dir help layer fails start-up too, naming the help destination', async (t) => {
  const rig = newRig(t);
  const layer = plantLegacy(rig, 'help');
  const failure = await startUpRefusal(rig);
  assert.match(
    failure.stderr,
    new RegExp(`start-up did not complete: ${layer}: quotient no longer reads help from the launch directory`),
  );
  assert.ok(failure.stderr.includes(`${xdgHelpLayer(rig.dir)}/ and restart`), failure.stderr);
  assert.equal(failure.refusal.reason, 'profile-invalid');
  assert.ok(failure.refusal.detail.includes(layer), failure.refusal.detail);
});

test('a legacy layer that is a dangling symlink is present, not absent: start-up still fails', async (t) => {
  const rig = newRig(t);
  mkdirSync(join(rig.launchDir, '.quotient'), { recursive: true });
  symlinkSync(join(tmpdir(), 'quotient-no-such-target'), join(rig.launchDir, '.quotient', 'profiles'));
  const failure = await startUpRefusal(rig);
  assert.match(failure.stderr, /no longer reads profiles from the launch directory/);
  assert.equal(failure.refusal.reason, 'profile-invalid');
});

test('a `.quotient/forms` entry alone is not a legacy layer: start-up completes', async (t) => {
  const rig = newRig(t);
  const forms = join(rig.launchDir, '.quotient', 'forms');
  mkdirSync(forms, { recursive: true });
  writeFileSync(join(forms, 'read'), '#!/bin/sh\nexit 0\n');
  const { replies, stderr } = await converse(
    [line({ id: 1, method: 'initialize' }), callLine(2, { prompt: 'hi', profile: 'read', cwd: rig.root })],
    rig.env,
    { launchDir: rig.launchDir },
  );
  assert.doesNotMatch(stderr, /start-up did not complete/);
  const instructions = String(field(field(replies[0], 'result'), 'instructions'));
  assert.doesNotMatch(instructions, /refused start-up/);
  assert.equal(payload(replies[1]).doc.refusal, null, 'the call ran: no start-up refusal');
});

test('a legacy layer that is a file is named as something to remove, not documents to move', async (t) => {
  const rig = newRig(t);
  mkdirSync(join(rig.launchDir, '.quotient'), { recursive: true });
  writeFileSync(join(rig.launchDir, '.quotient', 'profiles'), 'not a layer\n');
  const failure = await startUpRefusal(rig);
  assert.match(failure.refusal.detail, /that entry is not a layer directory: remove or replace it and restart$/);
  assert.doesNotMatch(failure.refusal.detail, /move these documents/);
});

test('both legacy layers present are named together, in the one start-up line', async (t) => {
  const rig = newRig(t);
  const profiles = plantLegacy(rig, 'profiles');
  const help = plantLegacy(rig, 'help');
  const failure = await startUpRefusal(rig);
  const lines = failure.stderr.split('\n').filter((text) => text.length > 0);
  assert.equal(lines.length, 1, 'one line, in C7\'s shape');
  assert.ok(lines[0].includes(`${profiles}, ${help}`), lines[0]);
  assert.match(lines[0], /no longer reads profiles from the launch directory; move these documents to .*; quotient no longer reads help/);
  assert.ok(failure.refusal.detail.includes(help));
});

// ── A policy refusal is a tool result too (EX-3, EX-5) ─────────────────────

test('a policy refusal reaches the caller as a tool result and the ledger', async () => {
  const { runDir, env } = workspace(validPolicy({ enabled: false }));
  const { doc, isError, reply } = await call(callTool({ prompt: 'hi', profile: 'read' }), env);
  assert.equal(reply.error, undefined);
  assert.equal(isError, true);
  assert.equal(doc.state, 'refused');
  assert.equal(doc.refusal.reason, 'disabled');
  const lines = attempts(runDir);
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
      if (forbidden.test(sourceLine)) {offenders.push(`${name}:${index + 1}: ${sourceLine.trim()}`);}
    });
  }
  assert.deepEqual(offenders, []);
});
