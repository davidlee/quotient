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
import { admit, type AdmissionContext, type Startup, type StartupFailure } from './admission.ts';
import { toolResult, type ToolResult } from './documents.ts';
import { appendAttempt, runLayout, type CallId } from './evidence.ts';
import { executeRun } from './execute.ts';
import { absent } from './paths.ts';
import { loadProfiles } from './profiles.ts';
import { refusedResult } from './result.ts';
import { readHostIdentity, type HostIdentity } from './session.ts';
import { DEFAULT_GRACE_MS } from './spawn.ts';
import { DEFAULT_IDLE_MS } from './gate.ts';
import { PI_AGENT_TOOL, readAgentRequest, type AgentRequest } from './tools.ts';

export const SERVER_NAME = 'quotient';
/** The revision `satan/satan-mcp.el` announces. */
export const PROTOCOL_VERSION = '2025-06-18';

type WireId = string | number | null;

/** One `tools/call` in flight: its own abort trigger, and the promise the reader
 *  waits on at stdin EOF so no child outlives the server. */
type InFlightCall = { controller: AbortController; done: Promise<void> };

type Context = {
  output: Writable;
  diagnostics: Writable;
  env: Record<string, string | undefined>;
  /** The start-up snapshots, or the failure that put the server in the start-up-refused state. */
  startup: Startup;
  /** What an absent `cwd` resolves to, through the same allowlist as any root. */
  launchDir: string;
  /** Where the policy, evidence and sessions are: resolved once, from the
   *  environment, which is fixed for the process lifetime. */
  locations: Locations;
  /** The pid table the server reads: `/proc` in production, a fixture in a
   *  test. Session liveness and ownership are read from it. */
  procDir: string;
  /** This server's host identity, read once at start-up: where its pid means
   *  something (design sec-3 Start step 4). */
  here: HostIdentity;
  /** `tools/call` is the only method that overlaps the reader (design sec-4); a
   *  cancellation names one of these by its request id. The id is the client's to
   *  repeat, so one key holds every call running under it: the invariant is that
   *  every running call is in this index, and a second call with an id already in
   *  flight joins the list rather than displacing its namesake. */
  inFlight: Map<string, InFlightCall[]>;
  /** stdin reached EOF: the client is gone, so nothing is admitted and no result
   *  is written down the closed channel (DEC-103). */
  closed: boolean;
  /** SIGTERM-to-SIGKILL grace for the ladder; design sec-4's 2 s by default. */
  graceMs: number;
  /** The gate's idle poll; design sec-4's "about a second" by default. */
  gateIdleMs: number;
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
// consumes; the run itself (the gate, the spawn, the ladder and the result) is
// `execute.ts`. Only those two refusals that precede admission are answered
// here: the start-up snapshot and the request's own shape. Everything from the
// policy to step 8 is `admission.ts`, which records its refusals as it decides.

/** Nothing follows a run's audit timestamps yet: `executeRun` offers the hook
 *  for the run registry, which this server does not have. */
const noAudit = (): void => {
  /* nothing to follow */
};

/** Record a refusal at the request boundary: the ledger's other writer. */
function refused(context: Context, callId: CallId, reason: string, detail: string): ToolResult {
  appendAttempt(usable(context.locations.runDir), { callId, reason, detail });
  return toolResult(refusedResult(reason, detail));
}

/**
 * One `tools/call`: the start-up profile snapshot, the request's shape, then
 * admission (steps 1-8, recorded where each is decided), then the run. The
 * session lock is released last, after the ladder, the reap, the drain and the
 * run's final audit append (design sec-4, sec-6).
 */
async function callTool(
  params: unknown,
  id: WireId,
  context: Context,
  controller: AbortController,
): Promise<ToolResult> {
  // A snapshot that did not load is a start-up-refused server, not a per-call
  // discovery: every call answers the reason and the path, whatever its shape.
  if (!context.startup.ok) {return refused(context, id, 'profile-invalid', startupFailure(context.startup));}

  const parsed = readToolCall(params);
  if (!parsed.ok) {return refused(context, id, 'request-invalid', parsed.detail);}

  // What admission reads of the server: the start-up snapshot, the locations
  // resolved once, the launch directory, the pid table and this server's host
  // identity.
  const admission: AdmissionContext = {
    startup: context.startup,
    locations: context.locations,
    launchDir: context.launchDir,
    procDir: context.procDir,
    here: context.here,
  };
  // Admission recorded its own refusal where it decided it: answering it is all
  // that is left, and a second append would double the ledger line.
  const verdict = admit(parsed.request, admission, id);
  if (!verdict.ok) {return toolResult(refusedResult(verdict.reason, verdict.detail));}
  const admitted = verdict.admitted;

  // The run's evidence layout, allocated once and handed to the spawn: the spawn
  // would allocate the same five paths itself, and a throw before it returns must
  // still be able to name where the run's evidence lives.
  const layout = runLayout(admitted.runDir, id);
  try {
    return toolResult(
      await executeRun(admitted, layout, controller, noAudit, {
        env: context.env,
        graceMs: context.graceMs,
        gateIdleMs: context.gateIdleMs,
        diagnostics: context.diagnostics,
        profileDigest: context.startup.profiles.digest,
        helpDigest: context.startup.help.digest,
      }),
    );
  } finally {
    admitted.session.release();
  }
}


function reply(context: Context, message: Record<string, unknown>): void {
  context.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
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
    case 'tools/call': {
      // The one method that overlaps the reader (design sec-4: "a blocking result
      // never blocks cancellation"); everything else stays synchronous and in
      // order. The call is answered when it settles.
      const entry: InFlightCall = { controller: new AbortController(), done: Promise.resolve() };
      const key = callKey(id);
      // Registered before the call starts, so a cancellation arriving in the same
      // tick finds it instead of racing the registration. A repeated id appends to
      // the list already under its key: both calls stay reachable by the id they
      // share, for the cancellation and for the EOF sweep alike.
      const already = context.inFlight.get(key);
      if (already === undefined) {context.inFlight.set(key, [entry]);}
      else {already.push(entry);}
      entry.done = (async () => {
        try {
          const result = await callTool(message.params, id, context, entry.controller);
          if (!context.closed) {reply(context, { id, result });}
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          context.diagnostics.write(`quotient: call ${String(id)} failed while running: ${detail}\n`);
          if (!context.closed) {
            // Every step that precedes the run answers a refusal rather than
            // throwing, so this catch only sees a failure before the run was
            // established: nothing ran, so a refusal is the truth.
            reply(context, {
              id,
              result: toolResult(
                refusedResult('server-error', `the server failed before this call could run: ${detail}`),
              ),
            });
          }
        } finally {
          // By identity, never by key: the list may hold a namesake that started
          // after this call did, and only this call's own entry may go.
          const running = context.inFlight.get(key);
          if (running !== undefined) {
            const at = running.indexOf(entry);
            if (at >= 0) {running.splice(at, 1);}
            if (running.length === 0) {context.inFlight.delete(key);}
          }
        }
      })();
      return;
    }
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
};

/**
 * DEC-103's cancellation trigger: abort exactly the call the notification names
 * and let the call answer itself. An unknown `requestId`, a missing one or a
 * malformed params object aborts nothing and is not an error.
 */
function abortNamed(params: unknown, context: Context): void {
  if (!isRecord(params)) {return;}
  const requestId = params.requestId;
  if (typeof requestId !== 'string' && typeof requestId !== 'number') {return;}
  // Every call running under the id, not just the most recent one: two calls may
  // share a wire id, and a cancellation names the id.
  for (const call of context.inFlight.get(callKey(requestId)) ?? []) {call.controller.abort('cancelled');}
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
  const launchDir = options.launchDir ?? process.cwd();
  const locations = resolveLocations(env);
  const startup = loadStartup(locations, launchDir);
  // The pid table session ownership and liveness are read from: the process's own.
  const procDir = '/proc';
  const here = readHostIdentity(procDir);
  // One line, naming the path: the server refuses from here on, and an operator
  // needs to know which file to fix.
  if (!startup.ok) {diagnostics.write(`quotient: ${startupFailure(startup)}\n`);}
  const context: Context = {
    output,
    diagnostics,
    env,
    startup,
    launchDir,
    locations,
    procDir,
    here,
    inFlight: new Map(),
    closed: false,
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
    gateIdleMs: options.gateIdleMs ?? DEFAULT_IDLE_MS,
  };
  const decoder = new StringDecoder('utf8');
  let pending = '';

  for await (const chunk of inputChunks(input, diagnostics, options.signal)) {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      let record = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (record.endsWith('\r')) {record = record.slice(0, -1);}
      await handleLine(record, context);
      newline = pending.indexOf('\n');
    }
  }
  // EOF, a failed input or the signal ends the loop. A trailing fragment without
  // LF is not a record: JSONL framing terminates every record with one.
  //
  // All three are DEC-103's second trigger, a different act from a cancellation:
  // the client is gone. Stop admitting, abort every in-flight run through the same
  // ladder, wait for their cleanup and audit flush, and return — no result is
  // written down the closed channel, and no child outlives the server.
  context.closed = true;
  const inFlight = [...context.inFlight.values()].flat();
  for (const call of inFlight) {call.controller.abort('eof');}
  await Promise.all(inFlight.map((call) => call.done));
}
