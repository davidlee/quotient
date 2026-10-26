// The stdio server: LF-framed JSON-RPC 2.0 in, five tools out.
//
// Each request is classified into an era by its own `_meta` (protocol.ts). The
// legacy era is shaped after `satan/satan-mcp.el`'s wire: `initialize` answers a
// protocol version, a tools capability and serverInfo; `notifications/initialized`
// is a no-op; `ping` answers `{pong: true}`; `tools/list` lists the tools. The
// modern era (2026-07-28) has no handshake: `server/discover`, `tools/list`,
// `tools/call` and the `tasks/*` methods, every result carrying `resultType`. An
// unknown method answers -32601 in either. One difference is the contract: a `tools/call` always
// answers a tool result (`content` + `isError`) carrying a `pi-agent-result/2`
// document — a refusal is a successful call that ran nothing, never a JSON-RPC
// error (design sec-5).
//
// Framing follows pi's json.md: split on LF, strip an optional preceding CR,
// never `readline` (it also splits on Unicode separators). The reader is
// incremental and ends at stdin EOF — no timer, no poll, no child.
import { StringDecoder } from 'node:string_decoder';
import { lstatSync, statSync } from 'node:fs';
import { addAbortSignal, type Readable, type Writable } from 'node:stream';
import { legacyLayers, resolveLocations, usable, type Locations } from '../config.ts';
import { loadHelp, renderContext, sectionText, type Section } from '../help/help.ts';
import { packageVersion } from '../root.ts';
import { isRecord } from '../json.ts';
import { admit, readmit, type AdmissionContext, type Refused, type Startup, type StartupFailure } from './admission.ts';
import { ackDocument, envelopeResult, handleDocument, POLL_INTERVAL_MS, taskOf, toolResult, type Task, type ToolResult } from './documents.ts';
import { appendAttempt, type CallId } from './evidence.ts';
import { executeRun, type ExecuteDeps } from './execute.ts';
import { absent } from './paths.ts';
import { readPolicy, type Maxima } from './policy.ts';
import { loadProfiles } from './profiles.ts';
import {
  classifyEra,
  declaresTasks,
  discoverResult,
  LEGACY_VERSION,
  LIST_CACHE,
  modernResult,
  tasksCancel,
  tasksGet,
  tasksUpdate,
  type TaskDeps,
} from './protocol.ts';
import { refusedResult } from './result.ts';
import { createRegistry, matchKey, type Launch, type Origin, type Registry, type RunRecord } from './runs.ts';
import { readHostIdentity, type HostIdentity } from './session.ts';
import { DEFAULT_GRACE_MS } from './spawn.ts';
import { DEFAULT_IDLE_MS } from './gate.ts';
import { argsDigest, readAgentRequest, readRunIds, readWaitRequest, TOOLS, type AgentRequest, type ToolName } from './tools.ts';
import { viewOf, resolveRun, type Resolution } from './views.ts';
import { awaitTargets, resolveTargets, waitBudgetBytes, waitEnvelope, waitTimeoutMs } from './waiting.ts';

export const SERVER_NAME = 'quotient';

type WireId = string | number | null;

/** One `tools/call` in flight: its own abort trigger, whether a cancellation
 *  silenced its reply, and the promise the reader waits on at stdin EOF so no
 *  child outlives the server. */
export type InFlightCall = { controller: AbortController; silenced: boolean; done: Promise<void> };

/** A `pi_agent` answered as a task: the run's Task, as it stands at creation. */
type CreatedTask = { task: Task };

/** What a handler answers: a value is answered now, a promise when it settles. */
export type Answered = ToolResult | CreatedTask;
export type Answer = Answered | Promise<Answered>;

/** How an answer goes on the wire, by the call's era. */
type Present = (answered: Answered) => object;

/** The legacy era: a tool result as it is (a legacy call never declares tasks). */
const asIs: Present = (answered) => answered;

/** The modern era: every result says what it is. */
const asModern: Present = (answered) =>
  'task' in answered ? modernResult(answered.task, 'task') : modernResult(answered, 'complete');

/** What the call driver needs of the server: where replies go, and the calls in flight. */
export type CallHost = {
  output: Writable;
  diagnostics: Writable;
  /** `tools/call` is the only method that overlaps the reader (design sec-4); a
   *  cancellation names one of these by its request id. The id is the client's to
   *  repeat, so one key holds every call running under it: the invariant is that
   *  every running call is in this index, and a second call with an id already in
   *  flight joins the list rather than displacing its namesake. */
  inFlight: Map<string, InFlightCall[]>;
  /** The client is gone (EOF, a failed input or the signal): nothing is started
   *  and no reply is written down the closed channel (DEC-103). */
  closed: boolean;
};

type Context = CallHost & {
  env: Record<string, string | undefined>;
  /** The start-up snapshots, or the failure that put the server in the start-up-refused state. */
  startup: Startup;
  /** What admission reads of the server, or the start-up failure that refuses
   *  every call: there is no admission without a start-up snapshot. */
  admission: AdmissionContext | StartupFailure;
  /** Every run this server owns, from publication to settlement. */
  registry: Registry;
  /** What an absent `cwd` resolves to, through the same allowlist as any root. */
  launchDir: string;
  /** Where the policy, evidence and sessions are: resolved once, from the
   *  environment, which is fixed for the process lifetime. */
  locations: Locations;
  /** The pid table the server reads: `/proc` in production, a fixture in a
   *  test. Session liveness and ownership are read from it. */
  procDir: string;
  /** This host's identity, read once at start-up: whose runs are this host's. */
  here: HostIdentity;
  /** How often a foreign or unreadable run is re-read while a call waits on it. */
  pollMs: number;
};

/** One `tools/call` as its handler sees it: the call's id, its abort signal, and
 *  whether its request may be answered with a task. */
type CallContext = { callId: CallId; signal: AbortSignal; tasks: boolean };

type Handler = (args: unknown, call: CallContext, context: Context) => Answer;

/** The tools that only read and settle runs already published: a start-up-refused
 *  server still serves them over the runs on disk. */
const SERVES_WITHOUT_STARTUP: readonly ToolName[] = ['pi_agent_wait', 'pi_agent_ack', 'pi_agent_cancel'];

/** A request id as a map key: `1` and `"1"` name different calls. */
const callKey = (id: WireId): string => `${typeof id}:${String(id)}`;

const isToolName = (name: unknown): name is ToolName => typeof name === 'string' && Object.hasOwn(TOOLS, name);

/** Unwrap a `tools/call` params object into the tool it names and its arguments,
 *  which the tool's own reader checks. */
function readToolName(params: unknown): { ok: true; name: ToolName; args: unknown } | { ok: false; detail: string } {
  if (!isRecord(params)) {return { ok: false, detail: 'params is not an object' };}
  if (!isToolName(params.name)) {return { ok: false, detail: `name must be one of ${Object.keys(TOOLS).join(', ')}` };}
  return { ok: true, name: params.name, args: params.arguments };
}

// ── The call: the request, admission, the run ───────────────────────────────
//
// Admission decides that this call MAY run and hands back the values the run
// consumes; the registry publishes the run and settles it, and the run itself
// (the gate, the spawn, the ladder and the result) is `execute.ts`. Only those
// two refusals that precede admission are answered here: the start-up snapshot
// and the request's own shape. Everything from the policy to step 8 is
// `admission.ts`, which records its refusals as it decides.

/** Record a refusal at the request boundary: the ledger's other writer. */
function refused(context: Context, callId: CallId, reason: string, detail: string): ToolResult {
  appendAttempt(usable(context.locations.runDir), { callId, reason, detail });
  return toolResult(refusedResult(reason, detail));
}

/** A start-up-refused server's answer to a call it cannot serve: the reason and
 *  the path, whatever the call's shape. */
const startupRefused = (context: Context, callId: CallId, failure: StartupFailure): ToolResult =>
  refused(context, callId, 'profile-invalid', startupFailure(failure));

/**
 * The server's run task (design sec-3, Launch): a run that waited on a lane is
 * re-admitted against the policy as it reads now, then run. A start-up-refused
 * server admits nothing, so it never launches.
 */
function launchWith(deps: ExecuteDeps, admission: AdmissionContext | StartupFailure): Launch {
  return (record, admitted, queued, onAudit) => {
    const current = queued && !('ok' in admission) ? readmit(admitted, admission) : { ok: true as const, admitted };
    if (!current.ok) {return Promise.resolve({ refused: current });}
    return executeRun(current.admitted, record.layout, record.controller, onAudit, deps).then((result) => ({ result }));
  };
}

/** Admission, then the registry's start: both synchronous, so the run is
 *  published, or refused, before the call's handler returns. */
function admitAndStart(
  context: Context,
  admission: AdmissionContext,
  request: AgentRequest,
  origin: Origin,
  callId: CallId,
): ReturnType<Registry['start']> | Refused {
  const verdict = admit(request, admission, callId);
  if (!verdict.ok) {return verdict;}
  return context.registry.start({
    admitted: verdict.admitted,
    origin,
    lane: request.lane ?? null,
    needsSuccess: request.needs_success ?? false,
    key: request.key ?? null,
    argsDigest: argsDigest(request, context.launchDir),
  });
}

/** A handler that starts runs: none can on a start-up-refused server, which
 *  answers before the request is read. */
const admitting = (
  handler: (args: unknown, call: CallContext, context: Context, admission: AdmissionContext) => Answer,
): Handler => (args, call, context) => {
  const { admission } = context;
  return 'ok' in admission ? startupRefused(context, call.callId, admission) : handler(args, call, context, admission);
};

/**
 * `pi_agent`: the request's shape, then admission and publication. A request that
 * declares tasks is answered with the run's Task at once, before the next input
 * line is read, so no cancellation can name it before its answer is out; it is
 * followed with `tasks/*`. Otherwise it blocks — start plus wait in-process: the
 * answer is the document the run's settlement wrote to `result.json`, a
 * cancellation becomes the registry's cancel, and EOF is left to `registry.close()`.
 */
function agentRun(args: unknown, call: CallContext, context: Context, admission: AdmissionContext): Answer {
  const parsed = readAgentRequest(args);
  if (!parsed.ok) {return refused(context, call.callId, 'request-invalid', parsed.detail);}

  // Admission and publication recorded their own refusals where they decided
  // them: answering is all that is left, and a second append would double the
  // ledger line.
  const started = admitAndStart(context, admission, parsed.request, call.tasks ? 'task' : 'blocking', call.callId);
  if (!started.ok) {return toolResult(refusedResult(started.reason, started.detail));}
  if (call.tasks) {return { task: taskOf(viewOf(started.record)) };}

  const { run } = started.record;
  const { signal } = call;
  signal.addEventListener(
    'abort',
    () => {
      if (signal.reason !== 'cancelled') {return;}
      context.registry.cancel([run]).catch((error: unknown) => {
        context.diagnostics.write(`quotient: cancelling ${run} failed: ${messageOf(error)}\n`);
      });
    },
    { once: true },
  );
  return started.document.then(toolResult);
}

/** A run's `pi-run-handle/1`, as it stands now. */
const handleOf = (record: RunRecord): ToolResult => envelopeResult(handleDocument(viewOf(record)), false);

/**
 * `pi_agent_start`: a key already held answers its run as it is now, without
 * admitting anything; otherwise admission and publication, answered with the
 * handle before the next input line is read.
 */
function startRun(args: unknown, call: CallContext, context: Context, admission: AdmissionContext): Answer {
  const parsed = readAgentRequest(args, { key: true });
  if (!parsed.ok) {return refused(context, call.callId, 'request-invalid', parsed.detail);}
  const { request } = parsed;

  if (request.key !== undefined) {
    const held = matchKey(context.registry.findKey(request.key), argsDigest(request, context.launchDir));
    if (held !== null) {return 'reuse' in held ? handleOf(held.reuse) : refused(context, call.callId, held.reason, held.detail);}
  }
  const started = admitAndStart(context, admission, request, 'start', call.callId);
  return started.ok ? handleOf(started.record) : toolResult(refusedResult(started.reason, started.detail));
}

/** What is run X, for this server: its registry, then the evidence on disk. With
 *  no usable run directory nothing was ever admitted, so nothing resolves. */
function resolverFor(context: Context): (run: string) => Resolution {
  const runDir = usable(context.locations.runDir);
  return (run) => (runDir === null ? null : resolveRun(context.registry, runDir, context.procDir, context.here, run));
}

/** What the task methods read and cancel: runs as this server resolves them, and
 *  the registry's cancel, which marks synchronously and is never awaited. */
function taskDeps(context: Context): TaskDeps {
  return {
    resolve: resolverFor(context),
    cancel: (run): void => {
      context.registry.cancel([run]).catch((error: unknown) => {
        context.diagnostics.write(`quotient: cancelling ${run} failed: ${messageOf(error)}\n`);
      });
    },
  };
}

/** The policy's maxima as they read now, or null when the policy cannot be read. */
function currentMaxima(context: Context): Maxima | null {
  const policyPath = usable(context.locations.policyPath);
  const read = policyPath === null ? null : readPolicy(policyPath);
  return read?.ok === true ? read.policy.maxima : null;
}

/** `pi_agent_wait`: the targets as the wait arrives, awaited until its condition,
 *  its timeout or its call's abort, then reported as they are. Changes nothing. */
function waitRuns(args: unknown, call: CallContext, context: Context): Answer {
  const parsed = readWaitRequest(args);
  if (!parsed.ok) {return refused(context, call.callId, 'request-invalid', parsed.detail);}
  const { request } = parsed;
  const resolve = resolverFor(context);
  const targets = resolveTargets(context.registry, request, resolve);
  const timeoutMs = waitTimeoutMs(request.timeout_s, currentMaxima(context));
  return awaitTargets(targets, request.until, timeoutMs, call.signal, resolve, context.pollMs).then(() =>
    envelopeResult(
      waitEnvelope(targets, resolve, { until: request.until, statusOnly: request.status_only, budgetBytes: waitBudgetBytes(request.budget_bytes) }),
      false,
    ),
  );
}

/** `pi_agent_ack`: every id validated before any acknowledgement applies. */
function ackRuns(args: unknown, call: CallContext, context: Context): Answer {
  const parsed = readRunIds(args);
  if (!parsed.ok) {return refused(context, call.callId, 'request-invalid', parsed.detail);}
  return envelopeResult(ackDocument(context.registry.ack(parsed.request.runs)), false);
}

/** `pi_agent_cancel`: every target marked before anything is awaited, then a
 *  wait over them all, each reported as it actually ended. */
function cancelRuns(args: unknown, call: CallContext, context: Context): Answer {
  const parsed = readRunIds(args);
  if (!parsed.ok) {return refused(context, call.callId, 'request-invalid', parsed.detail);}
  const { runs } = parsed.request;
  return context.registry.cancel(runs).then(() => {
    const resolve = resolverFor(context);
    const targets = resolveTargets(context.registry, { runs }, resolve);
    return envelopeResult(waitEnvelope(targets, resolve, { until: 'all', statusOnly: false, budgetBytes: waitBudgetBytes(undefined) }), false);
  });
}

const HANDLERS: Readonly<Record<ToolName, Handler>> = {
  pi_agent: admitting(agentRun),
  pi_agent_start: admitting(startRun),
  pi_agent_wait: waitRuns,
  pi_agent_ack: ackRuns,
  pi_agent_cancel: cancelRuns,
};

/** One `tools/call`, dispatched by name. A start-up-refused server answers every
 *  call it cannot serve — an unknown or malformed name included — before reading it. */
function callTool(params: unknown, call: CallContext, context: Context): Answer {
  const tool = readToolName(params);
  if (!tool.ok) {
    const { admission } = context;
    return 'ok' in admission ? startupRefused(context, call.callId, admission) : refused(context, call.callId, 'request-invalid', tool.detail);
  }
  return HANDLERS[tool.name](tool.args, call, context);
}

/** One line from a caught value. */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function reply(host: CallHost, message: Record<string, unknown>): void {
  host.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

/**
 * Drive one `tools/call`: register it, run HANDLER, answer it and deregister.
 * A handler that answers a value is replied to before this returns, so the reply
 * precedes the next input line. Every reply passes the one gate in `answer`: a
 * closed host or a silenced call writes nothing, whichever way the handler ended.
 */
export function runCall(host: CallHost, id: WireId, handler: (signal: AbortSignal) => Answer, present: Present = asIs): InFlightCall {
  const call: InFlightCall = { controller: new AbortController(), silenced: false, done: Promise.resolve() };
  const key = callKey(id);
  // Registered before the handler runs, so a cancellation arriving in the same
  // tick finds it instead of racing the registration. A repeated id appends to
  // the list already under its key: both calls stay reachable by the id they
  // share, for the cancellation and for the EOF sweep alike.
  const already = host.inFlight.get(key);
  if (already === undefined) {host.inFlight.set(key, [call]);}
  else {already.push(call);}

  const answer = (answered: Answered): void => {
    if (!host.closed && !call.silenced) {reply(host, { id, result: present(answered) });}
  };
  // The handler failed: it may have done so after its run was published, so the
  // refusal names the failure and claims nothing about what ran.
  const failed = (error: unknown): void => {
    const detail = messageOf(error);
    host.diagnostics.write(`quotient: call ${String(id)} failed: ${detail}\n`);
    answer(toolResult(refusedResult('server-error', `the server failed while handling this call: ${detail}`)));
  };
  // By identity, never by key: the list may hold a namesake that started after
  // this call did, and only this call's own entry may go.
  const deregister = (): void => {
    const running = host.inFlight.get(key);
    if (running === undefined) {return;}
    const at = running.indexOf(call);
    if (at >= 0) {running.splice(at, 1);}
    if (running.length === 0) {host.inFlight.delete(key);}
  };

  let answered: Answer;
  try {
    answered = handler(call.controller.signal);
  } catch (error) {
    failed(error);
    deregister();
    return call;
  }
  if (!(answered instanceof Promise)) {
    answer(answered);
    deregister();
    return call;
  }
  call.done = answered.then(answer, failed).finally(deregister);
  return call;
}

/** Dispatch one record. An unknown method with an id answers -32601; anything
 *  unparsable is dropped with a stderr note (there is no id to answer with). */
async function handleLine(line: string, context: Context): Promise<void> {
  if (line.trim().length === 0) {return;}

  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    context.diagnostics.write('quotient: unparsable JSON-RPC line dropped\n');
    return;
  }
  if (!isRecord(message)) {
    context.diagnostics.write('quotient: JSON-RPC message is not an object; dropped\n');
    return;
  }

  const method = typeof message.method === 'string' ? message.method : '(no method)';
  const hasId = Object.hasOwn(message, 'id');
  const id = hasId ? (message.id as WireId) : null;

  if (!hasId) {
    notification(method, message.params, context);
    return;
  }

  // Every message with an id is classified first, whatever its method.
  const era = classifyEra(message.params);
  if ('error' in era) {
    reply(context, { id, error: era.error });
    return;
  }
  const request: Request = { id, method, params: message.params };
  if (era.era === 'legacy') {legacyRequest(request, context);}
  else {modernRequest(request, declaresTasks(era), context);}
}

/** A notification: never answered, in either era. A request method sent as a
 *  notification has nothing to answer either. */
function notification(method: string, params: unknown, context: Context): void {
  // DEC-103: a wire act with a defined outcome. The request id it names is
  // aborted through the one ladder and reports `cancelled`; an id naming no
  // in-flight call is ignored — never a protocol error, and never a guess.
  if (method === 'notifications/cancelled') {abortNamed(params, context);}
}

/** One request with an id, past its era's classification. */
type Request = { id: WireId; method: string; params: unknown };

/** The tools as `tools/list` lists them, in either era. */
function toolList(context: Context): { tools: object[] } {
  return {
    tools: Object.entries(TOOLS).map(([name, tool]) => ({
      name,
      description: selfDescription(context, tool.section),
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  };
}

/** A `tools/call`: the one method that overlaps the reader (design sec-4: "a
 *  blocking result never blocks cancellation"); everything else stays synchronous
 *  and in order. The call is answered when it settles, as its era presents it. */
function toolCall({ id, params }: Request, tasks: boolean, present: Present, context: Context): void {
  runCall(context, id, (signal) => callTool(params, { callId: id, signal, tasks }, context), present);
}

const notFound = ({ id, method }: Request): Record<string, unknown> => ({
  id,
  error: { code: -32601, message: `Method not found: ${method}` },
});

/** The legacy era, as `satan/satan-mcp.el` speaks it. Tasks exist only in the
 *  modern era, so `tasks/*` are not found here. */
function legacyRequest(request: Request, context: Context): void {
  const { id } = request;
  switch (request.method) {
    case 'notifications/initialized':
    case 'notifications/cancelled':
      // A notification that carries an id is handled as one, as it always was.
      notification(request.method, request.params, context);
      return;
    case 'initialize':
      reply(context, {
        id,
        result: {
          protocolVersion: LEGACY_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: packageVersion() },
          instructions: selfDescription(context, 'agent'),
        },
      });
      return;
    case 'ping':
      reply(context, { id, result: { pong: true } });
      return;
    case 'server/discover':
      reply(context, { id, error: { code: -32602, message: 'server/discover needs a protocol version in _meta' } });
      return;
    case 'tools/list':
      reply(context, { id, result: toolList(context) });
      return;
    case 'tools/call':
      toolCall(request, false, asIs, context);
      return;
    default:
      reply(context, notFound(request));
  }
}

/** The modern era (2026-07-28): no handshake, so `initialize` and `ping` are not
 *  found; every result carries `resultType`. */
function modernRequest(request: Request, tasks: boolean, context: Context): void {
  const { id, params } = request;
  const answerTask = (answer: { result: object } | { error: object }): void => {
    reply(context, { id, ...answer });
  };
  switch (request.method) {
    case 'server/discover':
      reply(context, { id, result: discoverResult(selfDescription(context, 'agent'), { name: SERVER_NAME, version: packageVersion() }) });
      return;
    case 'tools/list':
      reply(context, { id, result: modernResult({ ...toolList(context), ...LIST_CACHE }, 'complete') });
      return;
    case 'tools/call':
      toolCall(request, tasks, asModern, context);
      return;
    case 'tasks/get':
      answerTask(tasksGet(params, taskDeps(context)));
      return;
    case 'tasks/cancel':
      answerTask(tasksCancel(params, taskDeps(context)));
      return;
    case 'tasks/update':
      answerTask(tasksUpdate(params, taskDeps(context)));
      return;
    default:
      reply(context, notFound(request));
  }
}

/**
 * The legacy launch-dir layers earlier versions read (DEC-011). One present —
 * anything but an absent entry, by the rule the layers themselves use — fails
 * start-up, so every call refuses `profile-invalid` and an operator learns what
 * stopped working and where the documents belong. Two present entries are named
 * together, in the one line C7 writes. Only a readable directory takes the
 * "move these documents" advice; a file, or an entry that cannot be read as a
 * directory, is named as something to remove. Pure apart from the checks.
 */
export function legacyLayerFailure(locations: Locations, launchDir: string): StartupFailure | null {
  const [profiles, help] = legacyLayers(launchDir);
  const layers = [
    { layer: profiles, kind: 'profiles', destinations: locations.profileLayers },
    { layer: help, kind: 'help', destinations: locations.helpLayers },
  ];
  const present = layers.flatMap(({ layer, kind, destinations }) => {
    const entry = legacyEntry(layer);
    return entry === 'absent' ? [] : [{ layer, advice: legacyAdvice(kind, destinations, entry) }];
  });
  if (present.length === 0) {return null;}
  return {
    ok: false,
    path: present.map(({ layer }) => layer).join(', '),
    detail: `${present.map(({ advice }) => advice).join('; ')} and restart`,
  };
}

/** How a legacy entry is present: only a readable directory takes the move advice. */
function legacyEntry(layer: string): 'absent' | 'directory' | 'other' {
  try {lstatSync(layer);} catch (error) {return absent(layer, error) ? 'absent' : 'other';}
  try {return statSync(layer).isDirectory() ? 'directory' : 'other';} catch {return 'other';}
}

/** The migration sentence for one present legacy layer, before "and restart". */
function legacyAdvice(kind: string, destinations: readonly string[], entry: 'directory' | 'other'): string {
  const introduction = `quotient no longer reads ${kind} from the launch directory`;
  if (entry === 'other') {return `${introduction}; that entry is not a layer directory: remove or replace it`;}
  const to = destinations.at(0) ?? `$XDG_CONFIG_HOME/quotient/${kind}`;
  return `${introduction}; move these documents to ${to}/`;
}

function loadStartup(locations: Locations, launchDir: string): Startup {
  const legacy = legacyLayerFailure(locations, launchDir);
  if (legacy !== null) {return legacy;}
  const profiles = loadProfiles(locations.profileLayers);
  if (!profiles.ok) {return profiles;}
  const help = loadHelp(locations.helpLayers);
  if (!help.ok) {return help;}
  return { ok: true, profiles: profiles.snapshot, help: help.snapshot };
}

const startupFailure = (failed: { path: string; detail: string }): string =>
  `start-up did not complete: ${failed.path}: ${failed.detail}`;

/** The sections a start-up-refused server still describes from its built-in help:
 *  those of the tools it still serves. */
const SERVING_SECTIONS: ReadonlySet<Section> = new Set(SERVES_WITHOUT_STARTUP.map((name) => TOOLS[name].section));

/**
 * The `agent` section (the `initialize` instructions) or a tool's section (its
 * description). The profile table pins capabilities from the policy as read now.
 * A start-up-refused server says so instead, naming the path, so the orchestrator
 * learns why its starts refuse; the tools it still serves keep their built-in
 * section, read without the operator's layers, since those may be what failed.
 */
function selfDescription(context: Context, section: Section): string {
  const { startup } = context;
  if (startup.ok) {
    const profiles = [...startup.profiles.profiles.values()];
    return sectionText(startup.help, section, renderContext(context.locations, profiles, context.launchDir));
  }
  const refusal = `quotient refused start-up: pi_agent and pi_agent_start answer profile-invalid; ${SERVES_WITHOUT_STARTUP.join(', ')} still serve the runs on disk. ${startupFailure(startup)}\n`;
  const builtin = SERVING_SECTIONS.has(section) ? loadHelp([]) : null;
  return builtin?.ok === true ? sectionText(builtin.snapshot, section, renderContext(context.locations, [], context.launchDir)) : refusal;
}

/** What a caller may override; production takes every default. */
export type ServeOptions = {
  /** The server's launch directory, which an absent `cwd` resolves to. */
  launchDir?: string;
  /** SIGTERM-to-SIGKILL grace; `DEFAULT_GRACE_MS` (design sec-4's 2 s) unless a
   *  test asks for less. */
  graceMs?: number;
  /** The gate's idle poll; `DEFAULT_IDLE_MS` (design sec-4's "about a second")
   *  unless a test asks for less — no case may wait a second for a tick. */
  gateIdleMs?: number;
  /** Shutdown: ends the input as EOF would. `src/cli.ts` aborts it on SIGTERM
   *  and SIGINT (DEC-118). */
  signal?: AbortSignal;
  /** The pid table session ownership and liveness are read from; `/proc` unless
   *  a test stages owners that are alive, dead or unreadable. */
  procDir?: string;
  /** How often a foreign or unreadable run is re-read while a call waits on it;
   *  `POLL_INTERVAL_MS` unless a test asks for less. */
  pollMs?: number;
};

/**
 * DEC-103's cancellation trigger: silence exactly the calls the notification
 * names, then abort them. A silenced call never replies, whatever its handler
 * does next; a reply already written stands. An unknown `requestId`, a missing
 * one or a malformed params object aborts nothing and is not an error.
 */
export function abortNamed(params: unknown, host: CallHost): void {
  if (!isRecord(params)) {return;}
  const requestId = params.requestId;
  if (typeof requestId !== 'string' && typeof requestId !== 'number') {return;}
  // Every call running under the id, not just the most recent one: two calls may
  // share a wire id, and a cancellation names the id.
  for (const call of host.inFlight.get(callKey(requestId)) ?? []) {
    call.silenced = true;
    call.controller.abort('cancelled');
  }
}

/**
 * The input's chunks until EOF, a failed input or SIGNAL: each ends the sequence
 * the same way, so `serve` has one exit. The signal destroys the input, which
 * the iterator reports as an AbortError. Only the input's own errors are caught
 * here; an error from the consumer's loop body is not the input's and propagates.
 */
async function* inputChunks(input: Readable, diagnostics: Writable, signal?: AbortSignal): AsyncGenerator {
  if (signal) {addAbortSignal(signal, input);}
  try {
    for await (const chunk of input) {yield chunk;}
  } catch (error) {
    // A failed input is the client gone, as EOF is; the signal's AbortError is
    // the operator's shutdown and needs no note.
    if (!signal?.aborted) {diagnostics.write(`quotient: the input failed: ${(error as Error).message}\n`);}
  }
}

/** What every run reads of the server: the options' timings and the start-up
 *  digests. A start-up-refused server admits nothing, so it never launches and
 *  its empty digests are never read. */
function runDeps(
  env: Record<string, string | undefined>,
  diagnostics: Writable,
  options: ServeOptions,
  startup: Startup,
): ExecuteDeps {
  return {
    env,
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
    gateIdleMs: options.gateIdleMs ?? DEFAULT_IDLE_MS,
    diagnostics,
    profileDigest: startup.ok ? startup.profiles.digest : '',
    helpDigest: startup.ok ? startup.help.digest : '',
  };
}

/** The server's context: the start-up snapshot read once, the locations, this
 *  host's identity and the registry whose launch runs with the options' timings. */
function serverContext(
  output: Writable,
  env: Record<string, string | undefined>,
  diagnostics: Writable,
  options: ServeOptions,
): Context {
  const launchDir = options.launchDir ?? process.cwd();
  const locations = resolveLocations(env);
  const startup = loadStartup(locations, launchDir);
  const procDir = options.procDir ?? '/proc';
  // One line, naming the path: the server refuses from here on, and an operator
  // needs to know which file to fix.
  if (!startup.ok) {diagnostics.write(`quotient: ${startupFailure(startup)}\n`);}
  const here = readHostIdentity(procDir);
  const admission = startup.ok ? { startup, locations, launchDir, procDir, here } : startup;
  const launch = launchWith(runDeps(env, diagnostics, options, startup), admission);
  return {
    output,
    diagnostics,
    env,
    startup,
    admission,
    registry: createRegistry({ launch, diagnostics }),
    launchDir,
    locations,
    procDir,
    here,
    pollMs: options.pollMs ?? POLL_INTERVAL_MS,
    inFlight: new Map(),
    closed: false,
  };
}

/** Call CLOSING the moment the client is gone: SIGNAL aborts (at once if it
 *  already has), or the input ends or fails. It may be called more than once. */
function onClientGone(input: Readable, signal: AbortSignal | undefined, closing: () => void): void {
  if (signal?.aborted === true) {closing();}
  signal?.addEventListener('abort', closing, { once: true });
  input.once('end', closing);
  input.once('error', closing);
}

/** Dispatch every complete record in BUFFERED, in order, and answer what is left:
 *  a fragment still waiting for its LF. Once the client is gone no record is
 *  dispatched, even one already read: it would admit a run or write a reply
 *  nobody reads (design sec-6). */
async function dispatchLines(buffered: string, context: Context): Promise<string> {
  let pending = buffered;
  let newline = pending.indexOf('\n');
  while (newline >= 0 && !context.closed) {
    let record = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (record.endsWith('\r')) {record = record.slice(0, -1);}
    await handleLine(record, context);
    newline = pending.indexOf('\n');
  }
  return pending;
}

/**
 * Serve one client over `input`/`output` until stdin EOF, a failed input or
 * `options.signal`. Takes its streams, its
 * environment and its two deployment locations, so the protocol is driven
 * in-process by the tests; `src/cli.ts` wires the process's own.
 *
 * The profile and help layers are read once, here, before the first line: one
 * snapshot each for the process lifetime, so an edit on disk is inert until a
 * restart.
 */
export async function serve(
  input: Readable,
  output: Writable,
  env: Record<string, string | undefined>,
  diagnostics: Writable = process.stderr,
  options: ServeOptions = {},
): Promise<void> {
  const context = serverContext(output, env, diagnostics, options);
  // DEC-103's second trigger, observed the moment it happens: nothing is started
  // and nothing is written from here, even while the reader drains a last chunk.
  const closing = (): void => {
    context.closed = true;
    context.registry.closing();
  };
  onClientGone(input, options.signal, closing);
  const decoder = new StringDecoder('utf8');
  let pending = '';

  for await (const chunk of inputChunks(input, diagnostics, options.signal)) {
    pending = await dispatchLines(pending + (typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer)), context);
  }
  // EOF, a failed input or the signal ends the loop. A trailing fragment without
  // LF is not a record: JSONL framing terminates every record with one.
  //
  // All three are DEC-103's second trigger, a different act from a cancellation:
  // the client is gone. The triggers above have already closed the server; an
  // input destroyed without an error ends the loop with none of them, so close
  // again. Then abort every in-flight call, let the registry abort, settle and
  // await every run through the same ladder, and wait for the calls — no reply is
  // written down the closed channel, and no child outlives the server.
  closing();
  const inFlight = [...context.inFlight.values()].flat();
  for (const call of inFlight) {call.controller.abort('eof');}
  await context.registry.close();
  await Promise.all(inFlight.map((call) => call.done));
}
