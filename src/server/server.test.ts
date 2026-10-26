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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { resolveLocations } from '../config.ts';
import { loadHelp, renderContext, sectionText, type Section } from '../help/help.ts';
import { isRecord } from '../json.ts';
import { packageVersion } from '../root.ts';
import {
  toolResult,
  type AckDocument,
  type HandleDocument,
  type ToolResult,
  type WaitDocument,
  type WaitEntry,
} from './documents.ts';
import { layoutFor } from './evidence.ts';
import { refusedResult, type AgentResult } from './result.ts';
import { abortNamed, PROTOCOL_VERSION, runCall, serve, type CallHost, type InFlightCall } from './server.ts';
import { TOOLS } from './tools.ts';
import {
  ackLine,
  admissionContext,
  attempts,
  auditKinds,
  callLine,
  cancelLine,
  closeServer,
  converse,
  envelopeDocument,
  executableAt,
  hasStarted,
  isAlive,
  launchOrder,
  refusalDocument,
  release,
  sleeperPid,
  sleeperRig,
  startLine,
  waitForReply,
  waitLine,
  waitStarted,
  jsonLines,
  line,
  markerPids,
  newRig,
  onlyRunDir,
  patchPolicy,
  pause,
  plantProjectForm,
  profileDocument,
  readText,
  resultDocument,
  resultJson,
  rigApprovalsPath,
  rigForm,
  runDirs,
  runIn,
  runOf,
  SETTLED,
  serveRig,
  serverCommand,
  spawnRecord,
  validPolicy,
  waitForPath,
  waitForReplies,
  waitForResult,
  workspace,
  writeApprovals,
  writeProfiles,
  xdgHelpLayer,
  xdgProfileLayer, type Env, type LiveServer, type Rig, type RigForm 
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

/** Sec-2's tool table, in the order tools/list lists it. */
const TOOL_NAMES = ['pi_agent', 'pi_agent_start', 'pi_agent_wait', 'pi_agent_ack', 'pi_agent_cancel'] as const;

/** Each tool's annotations, exactly sec-2's: only wait is read-only. */
const ANNOTATIONS: Record<(typeof TOOL_NAMES)[number], Record<string, boolean>> = {
  pi_agent: { readOnlyHint: false, openWorldHint: true },
  pi_agent_start: { readOnlyHint: false, openWorldHint: true },
  pi_agent_wait: { readOnlyHint: true },
  pi_agent_ack: { readOnlyHint: false, idempotentHint: true },
  pi_agent_cancel: { readOnlyHint: false, idempotentHint: true },
};

/** The tools a tools/list reply lists. */
function listedTools(reply: unknown): Record<string, unknown>[] {
  const tools = field(field(reply, 'result'), 'tools');
  if (!Array.isArray(tools)) {assert.fail(`tools/list answers a list: ${JSON.stringify(reply)}`);}
  return tools.filter(isRecord);
}

/** The help section text RIG's server renders for SECTION: the same snapshot
 *  and render context the server builds at start-up. */
function renderedSection(rig: Rig, section: Section): string {
  const { startup, locations, launchDir } = admissionContext(rig);
  return sectionText(startup.help, section, renderContext(locations, [...startup.profiles.profiles.values()], launchDir));
}

test('tools/list lists the five tools in sec-2 order, each with its help section, its schema and its annotations', async (t) => {
  const rig = newRig(t);
  const { replies } = await converse([line({ id: 4, method: 'tools/list' })], rig.env, { launchDir: rig.launchDir });
  const tools = listedTools(replies[0]);
  assert.deepEqual(tools.map((tool) => tool.name), [...TOOL_NAMES]);
  TOOL_NAMES.forEach((name, index) => {
    const tool = tools[index];
    assert.deepEqual(Object.keys(tool), ['name', 'description', 'inputSchema', 'annotations'], name);
    assert.equal(tool.description, renderedSection(rig, TOOLS[name].section), `${name}'s description is its help section`);
    assert.ok(typeof tool.description === 'string' && tool.description.length > 0, name);
    assert.deepEqual(tool.inputSchema, TOOLS[name].inputSchema, name);
    assert.deepEqual(tool.annotations, ANNOTATIONS[name], `${name}'s annotations are exactly sec-2's`);
  });
  assert.equal(new Set(tools.map((tool) => tool.description)).size, tools.length, 'no two tools share a description');

  // The schemas listed are the declared ones (above); pi_agent's keeps today's
  // shape and gains lane and needs_success, and start's adds key to the same set.
  const agent = TOOLS.pi_agent.inputSchema;
  assert.deepEqual(agent.required, ['prompt', 'profile']);
  assert.equal(agent.additionalProperties, false);
  assert.equal(agent.properties.ceilings.additionalProperties, false);
  assert.deepEqual(Object.keys(agent.properties.ceilings.properties), ['requests', 'context_tokens', 'cost_usd', 'wall_clock_s']);
  assert.equal(agent.properties.transcript_budget_bytes.type, 'integer');
  assert.equal(agent.properties.tools.items.type, 'string');
  const fields = Object.keys(agent.properties);
  assert.ok(fields.includes('lane') && fields.includes('needs_success'), fields.join(', '));
  assert.equal(fields.includes('key'), false, 'key is start\'s alone');
  assert.deepEqual(
    Object.keys(TOOLS.pi_agent_start.inputSchema.properties).filter((name) => name !== 'key'),
    fields,
    'start shares pi_agent\'s property set and adds key',
  );
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

/** The shutdown path's evidence: the stub is gone, its run audited its
 *  publication, an abort with cause eof and the group SIGKILL's exit, and the
 *  run settled into its `result.json` (design sec-6, Client EOF). */
function assertShutDown(rig: Rig, pid: number): void {
  assert.equal(isAlive(pid), false, 'the run was aborted, not left behind');
  const records = jsonLines(join(onlyRunDir(rig.runDir), 'audit.jsonl'));
  assert.deepEqual(
    records.map((record) => record.record),
    ['admitted', 'spawn', 'abort', 'exit'],
  );
  assert.equal(records[2].cause, 'eof');
  assert.equal(records[3].signal, 'SIGKILL');
  const settled = resultJson(rig.runDir, basename(onlyRunDir(rig.runDir)));
  assert.ok(settled !== null, 'the aborted run settled into its result.json');
  assert.equal(settled.state, 'incomplete', JSON.stringify(settled));
  assert.deepEqual(settled.causes, ['eof']);
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

test('an input destroyed without an error takes the same shutdown path as EOF', async (t) => {
  const rig = newRig(t, { read: STUBBORN });
  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(64, { prompt: 'work', profile: 'read', cwd: rig.root }));
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');
  const [pid] = markerPids(rig);

  server.fail();
  await server.done;

  assert.deepEqual(server.replies(), [], 'no end or error event fired, and still nothing is written');
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

/** The ids of the replies written, in order. */
function replyIds(written: string[]): unknown[] {
  return written.map((raw): unknown => JSON.parse(raw)).map((reply) => (isRecord(reply) ? reply.id : null));
}

test('the shutdown signal stops dispatch at once: the rest of a chunk already read gets no reply', async (t) => {
  const rig = newRig(t);
  const controller = new AbortController();
  const written: string[] = [];
  // The signal fires while the first line of the chunk is being answered.
  const output = new Writable({
    write(chunk, _encoding, done): void {
      written.push(String(chunk));
      controller.abort();
      done();
    },
  });
  const input = new PassThrough();
  input.write([67, 68, 69].map((id) => `${line({ id, method: 'ping' })}\n`).join(''));
  await serve(input, output, rig.env, sink([]), { launchDir: rig.launchDir, signal: controller.signal });

  assert.deepEqual(replyIds(written), [67], 'nothing after the trigger');
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

// ── Blocking pi_agent through the registry (SL-004 PHASE-07) ─────────────
//
// A blocking call is start plus wait: admission, then the registry publishes the
// run (its `admitted` record first) and the call answers the document the commit
// wrote to `result.json`. A `notifications/cancelled` leaves its request silenced
// for good, with the outcome in `result.json`; EOF writes no reply, and every run
// still settles (design sec-3, sec-6).

/** A stub that appends its pid, ignores SIGTERM and sleeps: several can run at
 *  once, and only the ladder's group SIGKILL ends one. */
const STUBBORN_EACH = ['printf \'%s\\n\' $$ >> "@MARKER@/pids"', "trap '' TERM", 'sleep 60'].join('\n');

/** The pids of COUNT stubs, once each has reported itself. */
async function waitForPids(rig: Rig, count: number): Promise<number[]> {
  const deadline = Date.now() + 10000;
  while (markerPids(rig, 'pids').length < count) {
    if (Date.now() > deadline) {throw new Error(`timed out waiting for ${String(count)} launchers`);}
    await pause(5);
  }
  return markerPids(rig, 'pids');
}

/** The settled document of a run, or a failed expectation when it left none. */
function settledDocument(rig: Rig, run: string): Record<string, unknown> {
  const settled = resultJson(rig.runDir, run);
  if (settled === null) {assert.fail(`${run} left no result.json`);}
  return settled;
}

test('a blocking pi_agent run opens its audit with the admitted record and answers the document its result.json holds', async (t) => {
  const rig = newRig(t);
  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(80, { prompt: 'work', profile: 'read', cwd: rig.root }));
  const [reply] = await waitForReplies(server, 1);
  await closeServer(server);

  const run = basename(onlyRunDir(rig.runDir));
  assert.deepEqual(auditKinds(layoutFor(rig.runDir, run)), ['admitted', 'spawn', 'exit']);
  const [admitted] = jsonLines(layoutFor(rig.runDir, run).audit);
  assert.equal(admitted.origin, 'blocking', 'the run came through the blocking door');
  assert.deepEqual(settledDocument(rig, run), payload(reply).doc, 'the call answers the document the commit wrote');
});

test('notifications/cancelled leaves a blocking call silenced: no reply for its id, a later ping still answers, and result.json reads cancelled', async (t) => {
  const rig = newRig(t, { read: STUBBORN });
  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(81, { prompt: 'work', profile: 'read', cwd: rig.root }));
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');
  const [pid] = markerPids(rig);
  const run = basename(onlyRunDir(rig.runDir));

  server.write(line({ method: 'notifications/cancelled', params: { requestId: 81 } }));
  const settled = await waitForResult(rig.runDir, run);
  // Read after the run settled, so its answer follows anything the cancelled call
  // could have written; closing then awaits every call, so the check is final.
  server.write(line({ id: 82, method: 'ping' }));
  await waitForReplies(server, 1);
  await closeServer(server);

  assert.deepEqual(server.replies().map((reply): unknown => reply.id), [82], 'the cancelled request got no reply, ever');
  assert.equal(settled.state, 'cancelled', JSON.stringify(settled));
  assert.equal(settled.termination, 'cancelled');
  assert.deepEqual(settled.causes, ['cancelled']);
  assert.equal(isAlive(pid), false, 'the cancelled run left no child behind');
});

test('a reply already written before its notifications/cancelled stands: exactly one reply, unchanged, and no error', async (t) => {
  const rig = newRig(t);
  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(83, { prompt: 'work', profile: 'read', cwd: rig.root }));
  const [answered] = await waitForReplies(server, 1);

  // The notification names a request that has already been answered.
  server.write(line({ method: 'notifications/cancelled', params: { requestId: 83 } }));
  server.write(line({ id: 84, method: 'ping' }));
  await waitForReplies(server, 2);
  await closeServer(server);

  const replies = server.replies();
  assert.deepEqual(replies.map((reply): unknown => reply.id), [83, 84]);
  assert.deepEqual(replies[0], answered, 'the reply stands as it was written');
  assert.ok(!replies.some((reply) => reply.error !== undefined), 'a late cancellation is never a JSON-RPC error');
  const run = basename(onlyRunDir(rig.runDir));
  assert.deepEqual(settledDocument(rig, run), payload(answered).doc, 'the settled outcome is the one answered');
});

test('EOF writes no replies, settles every in-flight run into its result.json and leaves no child behind', async (t) => {
  const rig = newRig(t, { read: STUBBORN_EACH });
  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(85, { prompt: 'first', profile: 'read', cwd: rig.root, session: 'eof-one' }));
  server.write(callLine(86, { prompt: 'second', profile: 'read', cwd: rig.root, session: 'eof-two' }));
  const pids = await waitForPids(rig, 2);

  await closeServer(server);

  assert.deepEqual(server.replies(), [], 'no reply is written once the client is gone');
  for (const id of [85, 86]) {
    const settled = settledDocument(rig, runOf(rig.runDir, id));
    assert.equal(settled.state, 'incomplete', JSON.stringify(settled));
    assert.deepEqual(settled.causes, ['eof']);
  }
  for (const pid of pids) {assert.equal(isAlive(pid), false, 'no child outlives serve');}
});

// ── The call driver: one reply gate (SL-004 PHASE-07 C3) ─────────────────
//
// `runCall` owns one in-flight call: registration, its handler, the one reply
// gate (`!closed && !silenced`) and deregistration. No PHASE-07 handler can throw
// after publication through `serve`, so the gate's catch arm is driven here
// directly, with handlers the test controls.

/** A writable that keeps every chunk written to it. */
function sink(into: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, done): void {
      into.push(String(chunk));
      done();
    },
  });
}

/** A host with no call in flight, and the replies written to its output. */
function callHost(): { host: CallHost; replies: () => Record<string, unknown>[] } {
  const out: string[] = [];
  const host: CallHost = { output: sink(out), diagnostics: sink([]), closed: false, inFlight: new Map() };
  const replies = (): Record<string, unknown>[] =>
    out
      .join('')
      .split('\n')
      .filter((raw) => raw.length > 0)
      .map((raw): unknown => JSON.parse(raw))
      .filter(isRecord);
  return { host, replies };
}

/** What a handler saw at the moment its call was aborted. */
type AbortSeen = { reason?: unknown; silenced?: boolean };

/** A handler that runs until its call is aborted and then ENDS: by throwing, or by
 *  answering a refusal. It records the abort's reason and whether its call was
 *  already silenced when the abort arrived. */
function untilAborted(
  ends: 'throws' | 'answers',
  seen: AbortSeen,
  call: () => InFlightCall | undefined,
): (signal: AbortSignal) => Promise<ToolResult> {
  return (signal) =>
    new Promise<ToolResult>((resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          seen.reason = signal.reason;
          seen.silenced = call()?.silenced;
          if (ends === 'throws') {reject(new Error('the handler failed after its abort'));}
          else {resolve(toolResult(refusedResult('server-error', 'answered after its abort')));}
        },
        { once: true },
      );
    });
}

test('a handler that throws after its call was silenced writes no reply: abortNamed silences, then aborts with cancelled', async () => {
  const { host, replies } = callHost();
  const seen: AbortSeen = {};
  const holder: { call?: InFlightCall } = {};
  const call = runCall(host, 91, untilAborted('throws', seen, () => holder.call));
  holder.call = call;

  abortNamed({ requestId: 91 }, host);
  await call.done;

  assert.deepEqual(replies(), [], 'a silenced call answers nothing, even from its catch arm');
  assert.equal(call.silenced, true);
  assert.equal(seen.silenced, true, 'the call was silenced before it was aborted');
  assert.equal(seen.reason, 'cancelled');
});

test('control: the same throwing handler aborted without a cancellation answers one server-error refusal that claims nothing about what ran', async () => {
  const { host, replies } = callHost();
  const call = runCall(host, 92, untilAborted('throws', {}, () => undefined));

  call.controller.abort();
  await call.done;

  const written = replies();
  assert.equal(written.length, 1, 'an unsilenced call answers exactly once');
  assert.equal(written[0].id, 92);
  const doc: unknown = resultDocument(written[0]);
  assert.equal(field(doc, 'state'), 'refused');
  const refusal = refusalOf(doc);
  assert.equal(refusal.reason, 'server-error');
  assert.match(refusal.detail, /the server failed while handling this call: the handler failed after its abort/);
  assert.doesNotMatch(refusal.detail, /before this call could run|nothing ran/);
  assert.equal(call.silenced, false);
});

test('a handler answering a value writes exactly one reply before runCall returns, and none on a closed host', async () => {
  const answer = (): ToolResult => toolResult(refusedResult('request-invalid', 'answered at once'));

  const open = callHost();
  const answered = runCall(open.host, 93, answer);
  assert.deepEqual(open.replies().map((reply): unknown => reply.id), [93], 'the reply is written before runCall returns');
  await answered.done;
  assert.equal(open.replies().length, 1, 'and only once');

  const closed = callHost();
  closed.host.closed = true;
  await runCall(closed.host, 94, answer).done;
  assert.deepEqual(closed.replies(), [], 'nothing is written down a closed channel');
});

test('two calls under one id are both silenced by one notification, whether they throw or answer', async () => {
  const { host, replies } = callHost();
  const throwing = runCall(host, 95, untilAborted('throws', {}, () => undefined));
  const answering = runCall(host, 95, untilAborted('answers', {}, () => undefined));

  abortNamed({ requestId: 95 }, host);
  await Promise.all([throwing.done, answering.done]);

  assert.deepEqual(replies(), [], 'neither namesake answers');
  assert.equal(throwing.silenced, true);
  assert.equal(answering.silenced, true);
});

test('a call is in the in-flight index while it runs and gone from it once done', async () => {
  const { host } = callHost();
  const release: { answer?: () => void } = {};
  const pending = new Promise<ToolResult>((resolve) => {
    release.answer = (): void => { resolve(toolResult(refusedResult('request-invalid', 'answered late'))); };
  });
  const call = runCall(host, 96, () => pending);
  assert.equal(host.inFlight.size, 1, 'registered before its handler settles');

  release.answer?.();
  await call.done;
  assert.equal(host.inFlight.size, 0, 'deregistered once done');
});

// ── Start, wait, ack, cancel and lanes (SL-004 PHASE-08) ─────────────────
//
// Driven through the real server with the sleeper form: each run is named by its
// prompt, launches visibly (a marker) and ends only when the test releases it, so
// overlap, lane order and cancel races are asserted from markers, never timing.
// Every handle, wait and ack document is read through `envelopeDocument`, which
// holds it to its validator.

/** Fast gate ticks and a short ladder: no case waits on a default interval. */
const SERVE = { graceMs: 200, gateIdleMs: 20 };

/** A well-formed id that names no run. */
const UNKNOWN_RUN = 'run-20261024T080000000Z-1-aaaaaaaaaaaa';

/** A sleeper's arguments: its prompt is its name. */
const sleeper = (rig: Rig, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  prompt: name,
  profile: 'read',
  cwd: rig.root,
  ...extra,
});

/** Start one run and read the handle start answered. */
async function startOf(server: LiveServer, id: number, args: Record<string, unknown>): Promise<HandleDocument> {
  server.write(startLine(id, args));
  return envelopeDocument(await waitForReply(server, id), 'pi-run-handle/1');
}

/** One wait, and the pi-agent-wait/1 document it answered. */
async function waitOf(server: LiveServer, id: number, args: Record<string, unknown>): Promise<WaitDocument> {
  server.write(waitLine(id, args));
  return envelopeDocument(await waitForReply(server, id), 'pi-agent-wait/1');
}

/** One cancel, and the pi-agent-wait/1 document it answered. */
async function cancelOf(server: LiveServer, id: number, runs: string[]): Promise<WaitDocument> {
  server.write(cancelLine(id, { runs }));
  return envelopeDocument(await waitForReply(server, id), 'pi-agent-wait/1');
}

/** One ack, and the pi-agent-ack/1 document it answered. */
async function ackOf(server: LiveServer, id: number, runs: string[]): Promise<AckDocument> {
  server.write(ackLine(id, { runs }));
  return envelopeDocument(await waitForReply(server, id), 'pi-agent-ack/1');
}

/** The entry a wait document holds for RUN. */
function entryOf(waited: WaitDocument, run: string): WaitEntry {
  return waited.runs.find((entry) => entry.taskId === run) ?? assert.fail(`no entry for ${run} in ${JSON.stringify(waited)}`);
}

/** The result a wait document carries for RUN. */
function resultOf(waited: WaitDocument, run: string): AgentResult {
  return entryOf(waited, run).result ?? assert.fail(`no result for ${run} in ${JSON.stringify(waited)}`);
}

/** The ids a selector-less listing reports: every unacknowledged started run. */
async function listed(server: LiveServer, id: number): Promise<string[]> {
  const listing = await waitOf(server, id, { timeout_s: 0, status_only: true });
  return listing.runs.map((entry) => entry.taskId);
}

/** RUN's first audit record of KIND, as written. */
function auditRecord(rig: Rig, run: string, kind: string): unknown {
  return jsonLines(layoutFor(rig.runDir, run).audit).find((record) => field(record, 'record') === kind);
}

test('start answers a pi-run-handle/1 at once, and a wait on its id answers pi-agent-wait/1 with the settled run and its result', async (t) => {
  const rig = sleeperRig(t);
  const server = serveRig(rig, SERVE);
  const handle = await startOf(server, 1, sleeper(rig, 'a'));
  assert.equal(handle.state, 'running', 'an unlaned run launches at once');
  assert.equal(handle.status, 'working');
  assert.equal(handle.lane, null);
  assert.equal(handle.key, null);
  assert.ok(existsSync(handle.artifacts.dir), 'the run is published before start answers');
  assert.equal(field(auditRecord(rig, handle.taskId, 'admitted'), 'origin'), 'start', 'the run came through the start door');

  await waitStarted(rig, 'a');
  release(rig, 'a');
  const waited = await waitOf(server, 2, { runs: [handle.taskId], timeout_s: 8 });
  await closeServer(server);

  assert.equal(waited.until, 'all');
  assert.equal(waited.timed_out, false);
  assert.deepEqual(waited.unknown, []);
  assert.equal(waited.runs.length, 1);
  const entry = entryOf(waited, handle.taskId);
  assert.equal(entry.state, 'settled');
  assert.equal(entry.status, 'completed');
  assert.equal(entry.status_only, false);
  assert.equal(entry.result?.state, 'completed', JSON.stringify(entry.result));
  assert.deepEqual(entry.result, resultJson(rig.runDir, handle.taskId), 'the entry carries the committed result');
});

test('two write runs started under different roots overlap: both launch before either is released, and one wait returns both', async (t) => {
  const rig = sleeperRig(t);
  const second = join(rig.dir, 'second-root');
  mkdirSync(second);
  patchPolicy(rig, 'roots', [rig.root, second]);
  const server = serveRig(rig, SERVE);
  const a = await startOf(server, 1, { prompt: 'a', profile: 'write', cwd: rig.root });
  const b = await startOf(server, 2, { prompt: 'b', profile: 'write', cwd: second });

  await waitStarted(rig, 'a');
  await waitStarted(rig, 'b');
  release(rig, 'a');
  release(rig, 'b');
  const waited = await waitOf(server, 3, { runs: [a.taskId, b.taskId], timeout_s: 8 });
  await closeServer(server);

  assert.equal(waited.timed_out, false);
  assert.deepEqual(waited.runs.map((entry) => entry.taskId), [a.taskId, b.taskId]);
  for (const run of [a.taskId, b.taskId]) {assert.equal(resultOf(waited, run).state, 'completed', run);}
});

test('three starts in one lane launch one at a time in start order, while an unlaned run started after them launches at once', async (t) => {
  const rig = sleeperRig(t);
  const server = serveRig(rig, SERVE);
  const a = await startOf(server, 1, sleeper(rig, 'a', { lane: 'build' }));
  const b = await startOf(server, 2, sleeper(rig, 'b', { lane: 'build' }));
  const c = await startOf(server, 3, sleeper(rig, 'c', { lane: 'build' }));
  assert.equal(a.state, 'running', 'an idle lane launches its first run');
  assert.equal(a.lane, 'build');
  assert.equal(b.state, 'queued');
  assert.equal(b.statusMessage, `queued in lane build behind ${a.taskId}`);
  assert.equal(c.statusMessage, `queued in lane build behind ${b.taskId}`);
  const d = await startOf(server, 4, sleeper(rig, 'd'));
  assert.equal(d.state, 'running', 'a busy lane holds back no unlaned run');

  await waitStarted(rig, 'a');
  await waitStarted(rig, 'd');
  assert.equal(hasStarted(rig, 'b'), false, 'b waits for a');
  release(rig, 'a');
  await waitStarted(rig, 'b');
  assert.notEqual(resultJson(rig.runDir, a.taskId), null, 'b launched only once a had settled');
  assert.equal(hasStarted(rig, 'c'), false, 'c waits for b');
  release(rig, 'b');
  await waitStarted(rig, 'c');
  assert.notEqual(resultJson(rig.runDir, b.taskId), null, 'c launched only once b had settled');
  release(rig, 'c');
  release(rig, 'd');
  const waited = await waitOf(server, 5, { lanes: ['build'], runs: [d.taskId], timeout_s: 8 });
  await closeServer(server);

  assert.equal(waited.timed_out, false);
  assert.deepEqual(waited.runs.map((entry) => entry.taskId), [d.taskId, a.taskId, b.taskId, c.taskId], 'named runs first, then the lane in start order');
  for (const entry of waited.runs) {assert.equal(entry.result?.state, 'completed', entry.taskId);}
  const order = launchOrder(rig);
  assert.deepEqual(order.filter((name) => name !== 'd'), ['a', 'b', 'c'], 'the lane launched in start order');
  assert.ok(order.indexOf('d') < order.indexOf('b'), 'the unlaned run overlapped the busy lane');
});

test('needs_success through the server: a laned run whose predecessor failed settles refused lane-predecessor-failed, never launched', async (t) => {
  const rig = sleeperRig(t);
  const server = serveRig(rig, SERVE);
  const a = await startOf(server, 1, sleeper(rig, 'a', { lane: 'build' }));
  const b = await startOf(server, 2, sleeper(rig, 'b', { lane: 'build', needs_success: true }));
  assert.equal(b.state, 'queued');

  await waitStarted(rig, 'a');
  release(rig, 'a', 'fail');
  const waited = await waitOf(server, 3, { runs: [a.taskId, b.taskId], timeout_s: 8 });
  await closeServer(server);

  assert.notEqual(resultOf(waited, a.taskId).state, 'completed', 'the predecessor failed');
  assert.equal(entryOf(waited, b.taskId).state, 'settled');
  const refused = resultOf(waited, b.taskId);
  assert.equal(refused.state, 'refused');
  assert.equal(refused.refusal?.reason, 'lane-predecessor-failed');
  assert.ok(refused.refusal.detail.includes(a.taskId), refused.refusal.detail);
  assert.equal(hasStarted(rig, 'b'), false, 'b never launched');
});

test('cancel: a queued laned run settles cancelled without launching and the lane moves on past it; a running one settles cancelled', async (t) => {
  const rig = sleeperRig(t);
  const server = serveRig(rig, SERVE);
  const a = await startOf(server, 1, sleeper(rig, 'a', { lane: 'build' }));
  const b = await startOf(server, 2, sleeper(rig, 'b', { lane: 'build' }));
  const c = await startOf(server, 3, sleeper(rig, 'c', { lane: 'build' }));
  assert.equal(a.state, 'running');
  await waitStarted(rig, 'a');

  const queued = await cancelOf(server, 4, [b.taskId]);
  assert.equal(queued.until, 'all');
  assert.equal(queued.timed_out, false);
  assert.equal(entryOf(queued, b.taskId).state, 'settled');
  assert.equal(entryOf(queued, b.taskId).status, 'cancelled');
  assert.equal(resultOf(queued, b.taskId).state, 'cancelled');
  const kinds = auditKinds(layoutFor(rig.runDir, b.taskId));
  assert.ok(kinds.includes('cancelled'), kinds.join(', '));
  assert.equal(kinds.includes('spawn'), false, 'the queued run never spawned');

  release(rig, 'a');
  await waitStarted(rig, 'c');
  assert.deepEqual(launchOrder(rig), ['a', 'c'], 'the lane skipped the cancelled run');

  const pid = sleeperPid(rig, 'c');
  const running = await cancelOf(server, 5, [c.taskId]);
  await closeServer(server);
  assert.equal(resultOf(running, c.taskId).state, 'cancelled');
  assert.equal(isAlive(pid), false, 'the cancelled run left no child behind');
  assert.equal(hasStarted(rig, 'b'), false);
});

test('start refuses exactly as pi_agent does for the same bad request: same refusal, isError, pi-agent-result/2', async (t) => {
  const rig = newRig(t);
  const requests: { name: string; args: Record<string, unknown>; reason?: string }[] = [
    { name: 'unknown profile', args: { prompt: 'x', profile: 'nope', cwd: rig.root } },
    { name: 'root outside roots', args: { prompt: 'x', profile: 'read', cwd: rig.dir } },
    { name: 'malformed lane', args: { prompt: 'x', profile: 'read', cwd: rig.root, lane: '-bad lane-' }, reason: 'request-invalid' },
    {
      name: 'needs_success without lane',
      args: { prompt: 'x', profile: 'read', cwd: rig.root, needs_success: true },
      reason: 'request-invalid',
    },
  ];
  for (const { name, args, reason } of requests) {
    const { replies } = await converse([callLine(1, args), startLine(2, args)], rig.env, { launchDir: rig.launchDir });
    const blocking = refusalDocument(replies.find((reply) => reply.id === 1) ?? assert.fail(name));
    const started = refusalDocument(replies.find((reply) => reply.id === 2) ?? assert.fail(name));
    assert.equal(started.schema, 'pi-agent-result/2', name);
    assert.deepEqual(started.refusal, blocking.refusal, name);
    if (reason !== undefined) {assert.equal(started.refusal.reason, reason, name);}
  }
  assert.deepEqual(runDirs(rig.runDir), [], 'no refusal published a run');
});

test('a key replays: the same key and arguments answer the same run, different arguments refuse request-invalid', async (t) => {
  const rig = sleeperRig(t);
  const server = serveRig(rig, SERVE);
  const first = await startOf(server, 1, sleeper(rig, 'k', { key: 'step-1' }));
  assert.equal(first.key, 'step-1');
  const again = await startOf(server, 2, sleeper(rig, 'k', { key: 'step-1' }));
  assert.equal(again.taskId, first.taskId, 'the replay answers the run the key already names');
  assert.equal(runDirs(rig.runDir).length, 1, 'and admits nothing new');

  server.write(startLine(3, sleeper(rig, 'other', { key: 'step-1' })));
  assert.equal(refusalDocument(await waitForReply(server, 3)).refusal.reason, 'request-invalid');
  assert.equal(runDirs(rig.runDir).length, 1);

  release(rig, 'k');
  await closeServer(server);
  assert.deepEqual(launchOrder(rig), ['k'], 'neither the replay nor the clash launched anything');
});

test('ack: settled → acknowledged, running → not-settled, unknown id → unknown; a malformed id refuses whole; acked runs leave the listing', async (t) => {
  const rig = sleeperRig(t);
  const server = serveRig(rig, SERVE);
  const a = await startOf(server, 1, sleeper(rig, 'a'));
  const b = await startOf(server, 2, sleeper(rig, 'b'));
  release(rig, 'a');
  await waitOf(server, 3, { runs: [a.taskId], timeout_s: 8 });

  server.write(ackLine(4, { runs: [a.taskId, '../escape'] }));
  assert.equal(refusalDocument(await waitForReply(server, 4)).refusal.reason, 'request-invalid');
  assert.deepEqual(await listed(server, 5), [a.taskId, b.taskId], 'a malformed request applied no acknowledgement');
  assert.deepEqual(await listed(server, 50), [a.taskId, b.taskId], 'a wait acknowledges nothing: the listing reads the same twice');

  const acked = await ackOf(server, 6, [a.taskId, b.taskId, UNKNOWN_RUN]);
  assert.deepEqual(acked.runs, [
    { taskId: a.taskId, acknowledged: true },
    { taskId: b.taskId, acknowledged: false, reason: 'not-settled' },
    { taskId: UNKNOWN_RUN, acknowledged: false, reason: 'unknown' },
  ]);
  assert.deepEqual(await listed(server, 7), [b.taskId], 'the selector-less wait excludes the acknowledged run');
  assert.deepEqual((await ackOf(server, 8, [a.taskId])).runs, [{ taskId: a.taskId, acknowledged: true }], 'ack is idempotent');
  const named = await waitOf(server, 9, { runs: [a.taskId], timeout_s: 0 });
  assert.equal(resultOf(named, a.taskId).state, 'completed', 'a named wait still reports an acknowledged run');

  release(rig, 'b');
  await closeServer(server);
});

test('wait with timeout_s 0 over a running run answers at once, timed out, with the run status-only', async (t) => {
  const rig = sleeperRig(t);
  const server = serveRig(rig, SERVE);
  const a = await startOf(server, 1, sleeper(rig, 'a'));
  await waitStarted(rig, 'a');
  const waited = await waitOf(server, 2, { runs: [a.taskId], timeout_s: 0 });
  release(rig, 'a');
  await closeServer(server);

  assert.equal(waited.timed_out, true);
  const entry = entryOf(waited, a.taskId);
  assert.equal(entry.state, 'running');
  assert.equal(entry.status, 'working');
  assert.equal(entry.status_only, true);
  assert.equal(entry.result, null);
});

test('notifications/cancelled naming a wait ends it with no reply, and its run keeps running to settlement', async (t) => {
  const rig = sleeperRig(t);
  const server = serveRig(rig, SERVE);
  const a = await startOf(server, 1, sleeper(rig, 'a'));
  await waitStarted(rig, 'a');
  const pid = sleeperPid(rig, 'a');

  server.write(waitLine(2, { runs: [a.taskId], timeout_s: 8 }));
  server.write(line({ method: 'notifications/cancelled', params: { requestId: 2 } }));
  server.write(line({ id: 3, method: 'ping' }));
  await waitForReply(server, 3);
  assert.equal(isAlive(pid), true, 'cancelling the wait left its run running');
  assert.equal(resultJson(rig.runDir, a.taskId), null);

  release(rig, 'a');
  const settled = await waitForResult(rig.runDir, a.taskId);
  // Read after the run settled: an uncancelled wait would have answered first.
  server.write(line({ id: 4, method: 'ping' }));
  await waitForReply(server, 4);
  await closeServer(server);

  assert.equal(settled.state, 'completed', JSON.stringify(settled));
  assert.deepEqual(server.replies().map((reply): unknown => reply.id), [1, 3, 4], 'the cancelled wait got no reply, ever');
});

test('EOF ends a wait on a run another server owns at once, without sitting out its timeout', async (t) => {
  const rig = newRig(t);
  // The fixture's owner is on another host, so this server reads the run foreign:
  // nothing in this process will ever settle it.
  const foreign = runIn(rig.runDir, {});
  const server = serveRig(rig, SERVE);
  server.write(waitLine(1, { runs: [foreign.run], timeout_s: 30 }));
  server.write(line({ id: 2, method: 'ping' }));
  await waitForReply(server, 2);

  const started = Date.now();
  await closeServer(server);
  assert.ok(Date.now() - started < 5000, `serve returned ${String(Date.now() - started)} ms after EOF`);
  assert.deepEqual(server.replies().map((reply): unknown => reply.id), [2], 'the wait wrote no reply down the closed channel');
});

test('re-admission: a queued run launches under maxima lowered while it waited, and the head admitted before keeps its own', async (t) => {
  const rig = sleeperRig(t);
  const server = serveRig(rig, SERVE);
  const a = await startOf(server, 1, sleeper(rig, 'a', { lane: 'build' }));
  const b = await startOf(server, 2, sleeper(rig, 'b', { lane: 'build' }));
  await waitStarted(rig, 'a');
  // The sleeper's one request costs 0.01: under the lowered maximum, only a
  // run judged by the current policy crosses it.
  patchPolicy(rig, 'maxima', { requests: 20, context_tokens: 100000, cost_usd: 0.005, wall_clock_s: 600 });

  release(rig, 'a');
  await waitStarted(rig, 'b');
  release(rig, 'b');
  const waited = await waitOf(server, 3, { runs: [a.taskId, b.taskId], timeout_s: 8 });
  await closeServer(server);

  assert.equal(resultOf(waited, a.taskId).state, 'completed', 'the head runs under what it was admitted with');
  assert.equal(resultOf(waited, b.taskId).state, 'ceiling_exceeded', JSON.stringify(resultOf(waited, b.taskId)));
  const abort = auditRecord(rig, b.taskId, 'abort');
  assert.equal(field(abort, 'unit'), 'cost_usd');
  assert.equal(field(abort, 'limit'), 0.005, 'the ceiling is the current maximum, not the admitted one');
});

test('re-admission: a queued run\'s wall clock counts from its launch, not from its start', async (t) => {
  const rig = sleeperRig(t);
  const server = serveRig(rig, SERVE);
  const a = await startOf(server, 1, sleeper(rig, 'a', { lane: 'build' }));
  const b = await startOf(server, 2, sleeper(rig, 'b', { lane: 'build', ceilings: { wall_clock_s: 0.5 } }));
  // The control: the same clock, held past it once launched, must end the run —
  // so b's completion shows where the clock starts, not that it is ignored.
  const c = await startOf(server, 3, sleeper(rig, 'c', { lane: 'build', ceilings: { wall_clock_s: 0.5 } }));
  await waitStarted(rig, 'a');
  // Durations, not ordering: the head outlives the queued run's whole wall clock,
  // then the queued run runs for ten gate ticks. Counted from start, the gate
  // would end it at its first tick.
  await pause(800);
  release(rig, 'a');
  await waitStarted(rig, 'b');
  await pause(200);
  release(rig, 'b');
  // c is never released: only its wall clock can end it.
  const waited = await waitOf(server, 4, { runs: [a.taskId, b.taskId, c.taskId], timeout_s: 8 });
  await closeServer(server);

  assert.equal(resultOf(waited, b.taskId).state, 'completed', JSON.stringify(resultOf(waited, b.taskId)));
  assert.equal(resultOf(waited, c.taskId).state, 'timeout', JSON.stringify(resultOf(waited, c.taskId)));
  assert.equal(field(auditRecord(rig, c.taskId, 'abort'), 'unit'), 'wall_clock_s');
});

test('re-admission: a queued run refuses at launch once the policy is disabled, recorded and never launched', async (t) => {
  const rig = sleeperRig(t);
  const server = serveRig(rig, SERVE);
  const a = await startOf(server, 1, sleeper(rig, 'a', { lane: 'build' }));
  const b = await startOf(server, 2, sleeper(rig, 'b', { lane: 'build' }));
  await waitStarted(rig, 'a');

  // The switch also ends the head at its next gate tick, which is what lets b reach launch.
  patchPolicy(rig, 'enabled', false);
  const waited = await waitOf(server, 3, { runs: [a.taskId, b.taskId], timeout_s: 8 });
  await closeServer(server);

  assert.equal(entryOf(waited, b.taskId).state, 'settled');
  const refused = resultOf(waited, b.taskId);
  assert.equal(refused.state, 'refused', JSON.stringify(refused));
  assert.equal(refused.refusal?.reason, 'disabled');
  assert.deepEqual(resultJson(rig.runDir, b.taskId), refused, 'the refusal is the run\'s result.json');
  const ledger = attempts(rig.runDir).map((attempt) => [field(attempt, 'call_id'), field(attempt, 'reason')]);
  assert.ok(ledger.some(([callId, reason]) => callId === 2 && reason === 'disabled'), JSON.stringify(ledger));
  const kinds = auditKinds(layoutFor(rig.runDir, b.taskId));
  assert.ok(kinds.includes('refused'), kinds.join(', '));
  assert.equal(kinds.includes('spawn'), false);
  assert.equal(hasStarted(rig, 'b'), false, 'b never launched');
});

test('a start-up-refused server: pi_agent (malformed too), start and unknown tools answer profile-invalid; wait, ack and cancel serve', async (t) => {
  const rig = newRig(t);
  const layer = plantLegacy(rig, 'profiles');
  const { replies } = await converse(
    [
      line({ id: 1, method: 'tools/list' }),
      line({ id: 2, method: 'tools/call', params: { name: 'pi_agent', arguments: 7 } }),
      startLine(3, { prompt: 'hi', profile: 'read', cwd: rig.root }),
      line({ id: 4, method: 'tools/call', params: { name: 'pi_other', arguments: {} } }),
      waitLine(5, { timeout_s: 0 }),
      ackLine(6, { runs: [UNKNOWN_RUN] }),
      cancelLine(7, { runs: [UNKNOWN_RUN] }),
    ],
    rig.env,
    { launchDir: rig.launchDir },
  );
  const replyTo = (id: number): Record<string, unknown> => replies.find((reply) => reply.id === id) ?? assert.fail(`no reply ${String(id)}`);

  for (const id of [2, 3, 4]) {
    const { refusal } = refusalDocument(replyTo(id));
    assert.equal(refusal.reason, 'profile-invalid', `call ${String(id)}`);
    assert.ok(refusal.detail.includes(layer), refusal.detail);
  }
  const waited = envelopeDocument(replyTo(5), 'pi-agent-wait/1');
  assert.deepEqual(waited.runs, []);
  assert.equal(waited.timed_out, false);
  assert.deepEqual(envelopeDocument(replyTo(6), 'pi-agent-ack/1').runs, [
    { taskId: UNKNOWN_RUN, acknowledged: false, reason: 'unknown' },
  ]);
  assert.deepEqual(envelopeDocument(replyTo(7), 'pi-agent-wait/1').unknown, [UNKNOWN_RUN]);

  const tools = listedTools(replyTo(1));
  const described = (name: string): string => String(tools.find((tool) => tool.name === name)?.description);
  for (const refusing of ['pi_agent', 'pi_agent_start']) {
    assert.ok(described(refusing).includes(layer), described(refusing));
    assert.match(described(refusing), /pi_agent_start/, 'the refusal names start among the refusing tools');
  }
  const builtin = loadHelp([]);
  if (!builtin.ok) {assert.fail(builtin.detail);}
  const context = renderContext(resolveLocations(rig.env), [], rig.launchDir);
  for (const serving of ['pi_agent_wait', 'pi_agent_ack', 'pi_agent_cancel'] as const) {
    assert.equal(described(serving), sectionText(builtin.snapshot, TOOLS[serving].section, context), `${serving} keeps its own section`);
  }
});

// M4 (PHASE-08 C14), a lane head settling between the client-gone trigger and
// `registry.close()` launching no successor, is not driven here: through `serve`
// the only head that settles after the trigger deterministically is one the EOF
// itself aborts, and `close()` drops the queued tail in the same sweep, so the
// case would pass without `closing()`. The window between the trigger and
// `close()` has no hook a test can hold open. `runs.test.ts` covers it ("after
// closing() a head that settles launches no successor").

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
  // not a ledger line: its publication, `spawn` before the launch and `exit`
  // with no code.
  const auditPath = join(onlyRunDir(runDir), 'audit.jsonl');
  const audit = jsonLines(auditPath);
  assert.deepEqual(audit.map((line): unknown => line.record), ['admitted', 'spawn', 'exit']);
  const spawned = spawnRecord(auditPath);
  assert.match(String(spawned.policy_digest), /^[0-9a-f]{64}$/);
  assert.match(String(spawned.profile_digest), /^[0-9a-f]{64}$/);
  assert.equal(spawned.profile_source, join(xdgProfileLayer(dir), 'read.md'), 'the winning document is audited');
  assert.equal(audit[2].code, null);
  assert.equal(audit[2].spawn_failed, true);
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

test('nested approvals: the deepest approval containing the call governs it', async (t) => {
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

test('an approval whose root is no longer in roots still governs it', async (t) => {
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

test('a profile the slot cannot deliver refuses profile-invalid: the extensions check precedes the store', async (t) => {
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

test('a roots entry retargeted into or away from an approved project still runs its form, roots in both orders (RV-006 F-1)', async (t) => {
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

test('a legacy launch-dir .quotient/help layer fails start-up too, naming the help destination', async (t) => {
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
