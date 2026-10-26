// The stdio server: LF-framed JSON-RPC 2.0 in, one tool out.
//
// Shaped after `satan/satan-mcp.el`'s wire: `initialize` answers a protocol
// version, a tools capability and serverInfo; `notifications/initialized` is a
// no-op; `ping` answers `{pong: true}`; `tools/list` lists the tool; an unknown
// method answers -32601. One difference is the contract: a `tools/call` always
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
import { admit, type AdmissionContext, type Refused, type Startup, type StartupFailure } from './admission.ts';
import { POLL_INTERVAL_MS, toolResult, type ToolResult } from './documents.ts';
import { appendAttempt, type CallId } from './evidence.ts';
import { executeRun, type ExecuteDeps } from './execute.ts';
import { absent } from './paths.ts';
import { loadProfiles } from './profiles.ts';
import { refusedResult } from './result.ts';
import { createRegistry, type Launch, type Origin, type Registry } from './runs.ts';
import { readHostIdentity } from './session.ts';
import { DEFAULT_GRACE_MS } from './spawn.ts';
import { DEFAULT_IDLE_MS } from './gate.ts';
import { PI_AGENT_TOOL, readAgentRequest, type AgentRequest } from './tools.ts';

export const SERVER_NAME = 'quotient';
/** The revision `satan/satan-mcp.el` announces. */
export const PROTOCOL_VERSION = '2025-06-18';

type WireId = string | number | null;

/** One `tools/call` in flight: its own abort trigger, whether a cancellation
 *  silenced its reply, and the promise the reader waits on at stdin EOF so no
 *  child outlives the server. */
export type InFlightCall = { controller: AbortController; silenced: boolean; done: Promise<void> };

/** What a handler answers: a value is answered now, a promise when it settles. */
export type Answer = ToolResult | Promise<ToolResult>;

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
  /** How often a foreign or unreadable run is re-read while a call waits on it. */
  pollMs: number;
};

/** A request id as a map key: `1` and `"1"` name different calls. */
const callKey = (id: WireId): string => `${typeof id}:${String(id)}`;

/** Unwrap a `tools/call` params object down to the tool's own arguments. */
function readToolCall(params: unknown): { ok: true; request: AgentRequest } | { ok: false; detail: string } {
  if (!isRecord(params)) {return { ok: false, detail: 'params is not an object' };}
  if (params.name !== PI_AGENT_TOOL.name) {
    return { ok: false, detail: `name must be "${PI_AGENT_TOOL.name}"` };
  }
  if (!isRecord(params.arguments)) {return { ok: false, detail: 'arguments is not an object' };}
  return readAgentRequest(params.arguments);
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

/** The server's run task (design sec-3, Launch): the run, for a run that never
 *  waited on a lane. The registry releases the session once the run settles. */
function launchWith(deps: ExecuteDeps): Launch {
  return (record, admitted, _queued, onAudit) =>
    executeRun(admitted, record.layout, record.controller, onAudit, deps).then((result) => ({ result }));
}

/** Admission, then the registry's start: both synchronous, so the run is
 *  published, or refused, before the call's handler returns. A blocking call has
 *  no key, so nothing ever compares its digest. */
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
    lane: null,
    needsSuccess: false,
    key: null,
    argsDigest: '',
  });
}

/**
 * A blocking `pi_agent`: start plus wait in-process. The start-up profile
 * snapshot, the request's shape, then admission and publication; the answer is
 * the document the run's settlement wrote to `result.json`. A cancellation
 * becomes the registry's cancel; EOF is left to `registry.close()`.
 */
function agentRun(params: unknown, callId: CallId, signal: AbortSignal, context: Context): Answer {
  // A snapshot that did not load is a start-up-refused server, not a per-call
  // discovery: every call answers the reason and the path, whatever its shape.
  const { admission } = context;
  if ('ok' in admission) {return refused(context, callId, 'profile-invalid', startupFailure(admission));}

  const parsed = readToolCall(params);
  if (!parsed.ok) {return refused(context, callId, 'request-invalid', parsed.detail);}

  // Admission and publication recorded their own refusals where they decided
  // them: answering is all that is left, and a second append would double the
  // ledger line.
  const started = admitAndStart(context, admission, parsed.request, 'blocking', callId);
  if (!started.ok) {return toolResult(refusedResult(started.reason, started.detail));}

  const { run } = started.record;
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
export function runCall(host: CallHost, id: WireId, handler: (signal: AbortSignal) => Answer): InFlightCall {
  const call: InFlightCall = { controller: new AbortController(), silenced: false, done: Promise.resolve() };
  const key = callKey(id);
  // Registered before the handler runs, so a cancellation arriving in the same
  // tick finds it instead of racing the registration. A repeated id appends to
  // the list already under its key: both calls stay reachable by the id they
  // share, for the cancellation and for the EOF sweep alike.
  const already = host.inFlight.get(key);
  if (already === undefined) {host.inFlight.set(key, [call]);}
  else {already.push(call);}

  const answer = (result: ToolResult): void => {
    if (!host.closed && !call.silenced) {reply(host, { id, result });}
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

  switch (method) {
    case 'notifications/initialized':
      return;
    case 'notifications/cancelled':
      // DEC-103: a wire act with a defined outcome. The request id it names is
      // aborted through the one ladder and reports `cancelled`; an id naming no
      // in-flight call is ignored — never a protocol error, and never a guess.
      { abortNamed(message.params, context); return; }
  }

  if (!hasId) {return;} // a notification for a request method: nothing to answer

  switch (method) {
    case 'initialize':
      reply(context, {
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: packageVersion() },
          instructions: selfDescription(context, 'agent'),
        },
      });
      return;
    case 'ping':
      reply(context, { id, result: { pong: true } });
      return;
    case 'tools/list':
      reply(context, {
        id,
        result: { tools: [{ name: PI_AGENT_TOOL.name, description: selfDescription(context, 'tool'), inputSchema: PI_AGENT_TOOL.inputSchema }] },
      });
      return;
    case 'tools/call':
      // The one method that overlaps the reader (design sec-4: "a blocking result
      // never blocks cancellation"); everything else stays synchronous and in
      // order. The call is answered when it settles.
      runCall(context, id, (signal) => agentRun(message.params, id, signal, context));
      return;
    default:
      reply(context, { id, error: { code: -32601, message: `Method not found: ${method}` } });
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

/**
 * The `agent` section (the `initialize` instructions) or the `tool` section
 * (the tool description). The profile table pins capabilities from the policy
 * as read now. A start-up-refused server says so instead, naming the path, so
 * the orchestrator learns why every call refuses.
 */
function selfDescription(context: Context, section: Extract<Section, 'agent' | 'tool'>): string {
  if (!context.startup.ok) {
    return `quotient refused start-up: every pi_agent call answers profile-invalid. ${startupFailure(context.startup)}\n`;
  }
  const profiles = [...context.startup.profiles.profiles.values()];
  return sectionText(context.startup.help, section, renderContext(context.locations, profiles, context.launchDir));
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
  const launch = launchWith(runDeps(env, diagnostics, options, startup));
  return {
    output,
    diagnostics,
    env,
    startup,
    admission: startup.ok ? { startup, locations, launchDir, procDir, here: readHostIdentity(procDir) } : startup,
    registry: createRegistry({ launch, diagnostics }),
    launchDir,
    locations,
    procDir,
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
