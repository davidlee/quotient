// The stdio server: LF-framed JSON-RPC 2.0 in, one tool out.
//
// Shaped after `satan/satan-mcp.el`'s wire: `initialize` answers a protocol
// version, a tools capability and serverInfo; `notifications/initialized` is a
// no-op; `ping` answers `{pong: true}`; `tools/list` lists the tool; an unknown
// method answers -32601. One difference is the contract: a `tools/call` always
// answers a tool result (`content` + `isError`) carrying a `pi-agent-result/1`
// document — a refusal is a successful call that ran nothing, never a JSON-RPC
// error (design sec-5).
//
// Framing follows pi's json.md: split on LF, strip an optional preceding CR,
// never `readline` (it also splits on Unicode separators). The reader is
// incremental and ends at stdin EOF — no timer, no poll, no child.
import { StringDecoder } from 'node:string_decoder';
import { writeFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { reduce } from '../reduce/reduce.ts';
import type { Reduced } from '../reduce/reduce.ts';
import { createLatch, failedResult, refusedResult, resultFor } from './result.ts';
import type { AgentResult } from './result.ts';
import { admitCall, clampCeilings, selectForm, transcriptBudget } from './policy.ts';
import { resolveLocations, usable } from '../config.ts';
import type { Locations } from '../config.ts';
import { checkProfileExtensions, effectiveTools, loadProfiles, resolveProfile, resolveRoot } from './profiles.ts';
import type { SnapshotLoad } from './profiles.ts';
import { acquireSession } from './session.ts';
import { checkChildView } from './childview.ts';
import { attemptsPath, appendAttempt, runLayout, writeAttemptProbe } from './evidence.ts';
import type { CallId, RunLayout } from './evidence.ts';
import { runChild, DEFAULT_GRACE_MS } from './spawn.ts';
import { createGate, DEFAULT_IDLE_MS } from './gate.ts';
import { packageVersion } from '../root.ts';

export const SERVER_NAME = 'quotient';
/** The revision `satan/satan-mcp.el` announces. */
export const PROTOCOL_VERSION = '2025-06-18';

/**
 * The tracked profile directory, resolved from this module's own URL: never the
 * environment, never the call's cwd, so a delegate cannot choose the authority
 * it is checked against (design sec-2 step 3).
 */
export const DEFAULT_PROFILES_DIR = fileURLToPath(new URL('./profiles/', import.meta.url));

/** The one tool this server exposes, with its declared input schema. */
export const PI_AGENT_TOOL = {
  name: 'pi_agent',
  description:
    'Run one one-shot pi agent under the operator policy and answer with its reduced transcript, status and verdict.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The prompt the agent receives on stdin.' },
      profile: {
        type: 'string',
        description: "The profile to run under; it must be listed in the operator policy.",
      },
      cwd: {
        type: 'string',
        description: "The run's root. An absent value resolves to the server's launch directory; either way the policy must allow it.",
      },
      session: { type: 'string', description: 'An existing session id to continue. Absent mints one.' },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: "May only narrow the profile's tool set, never widen it.",
      },
      ceilings: {
        type: 'object',
        properties: {
          requests: { type: 'number' },
          tokens: { type: 'number' },
          cost_usd: { type: 'number' },
          wall_clock_s: { type: 'number' },
        },
        description: 'Per-call ceilings. May only lower the policy maxima.',
        additionalProperties: false,
      },
      transcript_budget_bytes: {
        type: 'integer',
        description: 'Soft byte ceiling for the returned transcript.',
      },
    },
    required: ['prompt', 'profile'],
    additionalProperties: false,
  },
} as const;

/** The call's arguments, once their shape has been checked. */
export type AgentRequest = {
  prompt: string;
  profile: string;
  cwd?: string;
  session?: string;
  tools?: string[];
  ceilings?: { requests?: number; tokens?: number; cost_usd?: number; wall_clock_s?: number };
  transcript_budget_bytes?: number;
};

type WireId = string | number | null;
type ToolResult = { content: { type: 'text'; text: string }[]; isError: boolean };

/** One `tools/call` in flight: its own abort trigger, and the promise the reader
 *  waits on at stdin EOF so no child outlives the server. */
type InFlightCall = { controller: AbortController; done: Promise<void> };

type Context = {
  output: Writable;
  diagnostics: Writable;
  env: Record<string, string | undefined>;
  /** The start-up snapshot, or the failure that put the server in the start-up-refused state. */
  profiles: SnapshotLoad;
  /** What an absent `cwd` resolves to, through the same allowlist as any root. */
  launchDir: string;
  /** Where the policy, evidence and sessions are: resolved once, from the launch
   *  environment and launch dir, which are fixed for the process lifetime. */
  locations: Locations;
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

const CEILING_FIELDS = ['requests', 'tokens', 'cost_usd', 'wall_clock_s'];
const ARGUMENT_FIELDS = [
  'prompt',
  'profile',
  'cwd',
  'session',
  'tools',
  'ceilings',
  'transcript_budget_bytes',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check the request's own shape. Returns the field to name in a
 * `request-invalid` detail. The token is DEC-103's; DEC-103 names no position for
 * it, and this build puts the request's own shape first — a caller with a broken
 * request is told about its request rather than about a policy it cannot see.
 * The order is: a start-up snapshot that did not load (`profile-invalid`, every
 * call) -> request shape (`request-invalid`) -> step 1 policy -> step 2
 * enabled -> step 3 profile -> step 4 root -> step 5 capability/form -> step 6
 * ceilings -> `tools` narrowing -> step 7 session -> step 8 child view -> the
 * seam.
 */
function readAgentRequest(value: Record<string, unknown>): { ok: true; request: AgentRequest } | { ok: false; detail: string } {
  for (const field of Object.keys(value)) {
    if (!ARGUMENT_FIELDS.includes(field)) return { ok: false, detail: `unknown field: ${field}` };
  }
  if (value.prompt === undefined) return { ok: false, detail: 'prompt is required' };
  if (typeof value.prompt !== 'string') return { ok: false, detail: 'prompt must be a string' };
  if (value.profile === undefined) return { ok: false, detail: 'profile is required' };
  if (typeof value.profile !== 'string') return { ok: false, detail: 'profile must be a string' };

  const request: AgentRequest = { prompt: value.prompt, profile: value.profile };

  for (const field of ['cwd', 'session'] as const) {
    const holder = value[field];
    if (holder === undefined) continue;
    if (typeof holder !== 'string') return { ok: false, detail: `${field} must be a string` };
    request[field] = holder;
  }

  if (value.tools !== undefined) {
    const tools = value.tools;
    if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === 'string')) {
      return { ok: false, detail: 'tools must be an array of strings' };
    }
    request.tools = tools;
  }

  if (value.ceilings !== undefined) {
    const ceilings = value.ceilings;
    if (!isRecord(ceilings)) return { ok: false, detail: 'ceilings must be an object' };
    for (const field of Object.keys(ceilings)) {
      if (!CEILING_FIELDS.includes(field)) return { ok: false, detail: `unknown field: ceilings.${field}` };
      const limit = ceilings[field];
      if (typeof limit !== 'number' || !Number.isFinite(limit)) {
        return { ok: false, detail: `ceilings.${field} must be a finite number` };
      }
    }
    request.ceilings = ceilings as AgentRequest['ceilings'];
  }

  if (value.transcript_budget_bytes !== undefined) {
    const budget = value.transcript_budget_bytes;
    if (typeof budget !== 'number' || !Number.isInteger(budget)) {
      return { ok: false, detail: 'transcript_budget_bytes must be an integer' };
    }
    request.transcript_budget_bytes = budget;
  }

  return { ok: true, request };
}

/** Unwrap a `tools/call` params object down to the tool's own arguments. */
function readToolCall(params: unknown): { ok: true; request: AgentRequest } | { ok: false; detail: string } {
  if (!isRecord(params)) return { ok: false, detail: 'params is not an object' };
  if (params.name !== PI_AGENT_TOOL.name) {
    return { ok: false, detail: `name must be "${PI_AGENT_TOOL.name}"` };
  }
  if (!isRecord(params.arguments)) return { ok: false, detail: 'arguments is not an object' };
  return readAgentRequest(params.arguments);
}

// ── The run: evidence, the ladder's outcome and the run's result ───────────
//
// The run replaces the seam PHASE-02..05 left here. Everything before it decided
// that this call MAY run; from here the launcher is spawned, the ladder owns the
// ending, and the evidence directory is the only place the outcome is recorded.
// Only a call that passed step 8 reaches this point, so the run directory is
// allocated after validation, not before (EX-6).

/** Write the run's reduced transcript and status beside the stream they came
 *  from. An evidence write that fails is reported as a failed append: a run whose
 *  own evidence cannot be written must not be answered as a clean success. */
function writeRunFiles(layout: RunLayout, reduced: Reduced): boolean {
  try {
    writeFileSync(layout.transcript, reduced.transcript);
    writeFileSync(layout.status, `${JSON.stringify(reduced.status, null, 2)}\n`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`quotient: could not write ${layout.transcript} / ${layout.status}: ${message}\n`);
    return false;
  }
}

function toolResult(document: AgentResult): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(document) }],
    isError: document.state !== 'completed',
  };
}

/** Record a refusal at the request boundary: the ledger's other writer. */
function refused(context: Context, callId: CallId, reason: string, detail: string): ToolResult {
  appendAttempt(usable(context.locations.runDir), { callId, reason, detail });
  return toolResult(refusedResult(reason, detail));
}

/**
 * One `tools/call`: the start-up profile snapshot, the request's shape, steps
 * 1-6, the `tools` narrowing, step 7 (the session), step 8 (the child view) and
 * the run itself. Every refusal is a tool result, recorded in `attempts.jsonl` as
 * it is decided. The session lock is released last, after the ladder, the reap,
 * the drain and the run's final audit append (design sec-4, sec-6).
 */
async function callTool(
  params: unknown,
  id: WireId,
  context: Context,
  controller: AbortController,
): Promise<ToolResult> {
  // A snapshot that did not load is a start-up-refused server, not a per-call
  // discovery: every call answers the reason and the path, whatever its shape.
  if (!context.profiles.ok) {
    return refused(
      context,
      id,
      'profile-invalid',
      `the profile snapshot did not load at start-up: ${context.profiles.path}: ${context.profiles.detail}`,
    );
  }

  const snapshot = context.profiles.snapshot;
  const parsed = readToolCall(params);
  if (!parsed.ok) return refused(context, id, 'request-invalid', parsed.detail);
  const request = parsed.request;

  const admission = admitCall(context.locations, id);
  if (!admission.ok) return toolResult(refusedResult(admission.reason, admission.detail));

  const refuse = (reason: string, detail: string): ToolResult => {
    appendAttempt(admission.runDir, { callId: id, reason, detail, policyDigest: admission.digest });
    return toolResult(refusedResult(reason, detail));
  };

  // Step 3: the profile, from the start-up snapshot only.
  const profile = resolveProfile(snapshot, request.profile, Object.keys(admission.policy.profiles));
  if (!profile.ok) return refuse(profile.reason, profile.detail);

  // Step 4: the root, canonicalised and allowlisted by components.
  const root = resolveRoot(request.cwd, context.launchDir, admission.policy.roots);
  if (!root.ok) return refuse(root.reason, root.detail);

  // Step 5: the capability selects the wrapper form, and the form's declared
  // extensions must be able to deliver the profile's tools (EX-7).
  const form = selectForm(admission.policy, profile.profile.filesystem);
  if (!form.ok) return refuse(form.reason, form.detail);
  // Interim until the spawn branches on the form kind (PHASE-06).
  if (form.form.kind === 'unconfined') {
    return refuse('wrapper-unavailable', 'this build cannot yet launch an unconfined form');
  }
  const extensions = checkProfileExtensions(profile.profile, form.form.extensions);
  if (!extensions.ok) return refuse(extensions.reason, extensions.detail);

  // Step 6: the ceilings, clamped downward.
  const ceilings = clampCeilings(request.ceilings, admission.policy.maxima);
  if (!ceilings.ok) return refuse(ceilings.reason, ceilings.detail);

  // The call's `tools` may only narrow the profile's snapshotted set; the whole
  // narrowed list is what the launch form will hand to `--tools` (PHASE-06).
  const tools = effectiveTools(profile.profile, request.tools);
  if (!tools.ok) return refuse(tools.reason, tools.detail);

  // The admitted values (`root.root`, `form.form`, `ceilings.ceilings`,
  // `tools.tools`) and the snapshot digest are what PHASE-06's spawn consumes.

  // Step 7: the session — grammar, ownership, and the (root, capability) binding
  // recorded in the same critical section as first use (design sec-2 step 7,
  // sec-6). Ownership is conferred by an O_EXCL create and survives until the
  // answer is decided, so it is released last.
  const session = acquireSession({
    sessionHome: admission.sessionHome,
    runDir: admission.runDir,
    session: request.session,
    root: root.root,
    capability: profile.profile.filesystem,
    callId: id,
    policyDigest: admission.digest,
  });
  if (!session.ok) return refuse(session.reason, session.detail);

  // The run's evidence layout, allocated once and handed to the spawn: the spawn
  // would allocate the same five paths itself, and a throw before it returns must
  // still be able to name where the run's evidence lives.
  const layout = runLayout(admission.runDir, id);

  // The gate (design sec-4, PHASE-07): one tick evaluator over the clamped
  // snapshot, aborting through this call's own controller so a crossing reaches
  // the ladder exactly as a cancellation does. Created after the last refusal
  // that precedes the run, so its idle poll never outlives a call.
  const gate = createGate({
    ceilings: ceilings.ceilings,
    policyPath: admission.policyPath,
    // The cause token stays the ladder's input; the trigger rides along
    // additively, so the abort's audit record can name the crossing.
    abort: (trigger) => controller.abort({ cause: trigger.cause, trigger }),
    idleMs: context.gateIdleMs,
  });

  try {
    // Step 8: the child view — the canonicalised union of {root, the active
    // session directory, the policy's fixed mounts} — must not reach a protected
    // store more strongly than that store tolerates (design sec-2 step 8,
    // sec-3). The refusal names the overlapping member and the store and stops;
    // nothing is masked, and no run directory exists yet (PHASE-06 allocates one
    // after this step).
    const view = checkChildView({
      root: root.root,
      capability: profile.profile.filesystem,
      sessionDir: session.sessionDir,
      childBinds: admission.policy.exposure,
      sessionHome: admission.sessionHome,
      runDir: admission.runDir,
      policyPath: admission.policyPath,
    });
    if (!view.ok) return refuse(view.reason, view.detail);

    // Design sec-6's failure policy: a server that cannot record a refusal must
    // not start a run it also could not abort-audit. Decided before the run
    // directory exists, so nothing has been allocated and nothing is spawned.
    if (!writeAttemptProbe(admission.runDir)) {
      return toolResult(
        refusedResult(
          'audit-unavailable',
          `${attemptsPath(admission.runDir)} cannot be appended to: the server does not launch a run it cannot record`,
        ),
      );
    }

    // The abort latch (design sec-5, DEC-093): the causes this call discovers are
    // recorded here, in discovery order, and read once at the commit point below.
    // The result is derived from it in one place, `resultFor` — the server holds no
    // cause → state map of its own (EX-8).
    const latch = createLatch();

    const run = await runChild(
      {
        form: form.form,
        profile: profile.profile,
        session: session.session,
        sessionDir: session.sessionDir,
        root: root.root,
        runDir: admission.runDir,
        callId: id,
        tools: tools.tools,
        prompt: request.prompt,
        policyDigest: admission.digest,
        profileDigest: snapshot.digest,
        layout,
      },
      { signal: controller.signal, graceMs: context.graceMs, env: context.env, onRecord: gate.tick },
    );

    // Nothing ran: the run's own first audit record could not be written, so the
    // directory was discarded and the call is a refusal (EX-6), recorded in the
    // ledger that is still writable.
    if (run.auditFailedBeforeSpawn) {
      appendAttempt(admission.runDir, {
        callId: id,
        reason: 'audit-failed',
        detail: `the run audit could not be written and the run directory was discarded: ${run.layout.audit}`,
        policyDigest: admission.digest,
      });
      return toolResult(
        refusedResult(
          'audit-failed',
          `the run's audit could not be written, so nothing ran: ${run.layout.audit}`,
        ),
      );
    }

    // The one reader (design sec-4): the stream this run captured, reduced by the
    // reducer that owns the accounting, with the transcript budget the call asked
    // for — clamped by the policy's maximum, so neither value is ignored.
    const reduced = reduce(run.lines, {
      budgetBytes: transcriptBudget(request.transcript_budget_bytes, admission.policy.transcript_budget_bytes),
    });
    const wrote = writeRunFiles(run.layout, reduced);

    // The three causes the server discovers, in the order it discovers them: the
    // ladder's own cause, a launch that never ran, then an evidence append that
    // failed. `!wrote` is the same failure as a failed audit append — the run's own
    // evidence cannot be written — so it is the same cause, recorded once.
    if (run.abort !== null) latch.record(run.abort);
    if (run.spawnFailed) latch.record('spawn');
    if (run.auditFailed || !wrote) latch.record('audit');

    // The commit point: after the ladder, the reap, the drain, the final accounting
    // (the reduction above) and the `exit`/abort evidence appends (inside the
    // spawn). Nothing that can fail is left, because the return is the last step.
    const document = resultFor({
      reduced,
      outcome: run,
      causes: latch.commit(),
      session: session.session,
    });
    return toolResult(document);
  } catch (error) {
    // The run was established (a session, a run directory) and the server threw
    // while running it: the answer is a conforming `failed` envelope over the
    // layout, with the reducer's verdict on an unread stream. The detail is
    // diagnostics, not reduced markdown, so it never enters the envelope.
    const detail = error instanceof Error ? error.message : String(error);
    context.diagnostics.write(`quotient: call ${String(id)} failed while running: ${detail}\n`);
    return toolResult(failedResult('error', ['error'], session.session, reduce([], {}).status, layout));
  } finally {
    gate.close();
    session.release();
  }
}

function reply(context: Context, message: Record<string, unknown>): void {
  context.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

/** Dispatch one record. An unknown method with an id answers -32601; anything
 *  unparsable is dropped with a stderr note (there is no id to answer with). */
async function handleLine(line: string, context: Context): Promise<void> {
  if (line.trim().length === 0) return;

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
      return abortNamed(message.params, context);
  }

  if (!hasId) return; // a notification for a request method: nothing to answer

  switch (method) {
    case 'initialize':
      reply(context, {
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: packageVersion() },
        },
      });
      return;
    case 'ping':
      reply(context, { id, result: { pong: true } });
      return;
    case 'tools/list':
      reply(context, { id, result: { tools: [PI_AGENT_TOOL] } });
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
      if (already === undefined) context.inFlight.set(key, [entry]);
      else already.push(entry);
      entry.done = (async () => {
        try {
          const result = await callTool(message.params, id, context, entry.controller);
          if (!context.closed) reply(context, { id, result });
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
            if (at >= 0) running.splice(at, 1);
            if (running.length === 0) context.inFlight.delete(key);
          }
        }
      })();
      return;
    }
    default:
      reply(context, { id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

/** What a caller may override; production takes every default. */
export type ServeOptions = {
  /** The profile directory to snapshot; production uses the module's own. */
  profilesDir?: string;
  /** The server's launch directory, which an absent `cwd` resolves to. */
  launchDir?: string;
  /** SIGTERM-to-SIGKILL grace; `DEFAULT_GRACE_MS` (design sec-4's 2 s) unless a
   *  test asks for less. */
  graceMs?: number;
  /** The gate's idle poll; `DEFAULT_IDLE_MS` (design sec-4's "about a second")
   *  unless a test asks for less — no case may wait a second for a tick. */
  gateIdleMs?: number;
};

/**
 * DEC-103's cancellation trigger: abort exactly the call the notification names
 * and let the call answer itself. An unknown `requestId`, a missing one or a
 * malformed params object aborts nothing and is not an error.
 */
function abortNamed(params: unknown, context: Context): void {
  if (!isRecord(params)) return;
  const requestId = params.requestId;
  if (typeof requestId !== 'string' && typeof requestId !== 'number') return;
  // Every call running under the id, not just the most recent one: two calls may
  // share a wire id, and a cancellation names the id.
  for (const call of context.inFlight.get(callKey(requestId)) ?? []) call.controller.abort('cancelled');
}

/**
 * Serve one client over `input`/`output` until stdin EOF. Takes its streams, its
 * environment and its two deployment locations, so the protocol is driven
 * in-process by the tests; `src/cli.ts` wires the process's own.
 *
 * The profile directory is read once, here, before the first line: one snapshot
 * for the process lifetime, so an edit on disk is inert until a restart (EX-1).
 */
export async function serve(
  input: Readable,
  output: Writable,
  env: Record<string, string | undefined>,
  diagnostics: Writable = process.stderr,
  options: ServeOptions = {},
): Promise<void> {
  const profiles = loadProfiles(options.profilesDir ?? DEFAULT_PROFILES_DIR);
  if (!profiles.ok) {
    // One line, naming the path: the server refuses from here on, and an
    // operator needs to know which document to fix (EX-2).
    diagnostics.write(`quotient: the profile snapshot did not load: ${profiles.path}: ${profiles.detail}\n`);
  }
  const launchDir = options.launchDir ?? process.cwd();
  const context: Context = {
    output,
    diagnostics,
    env,
    profiles,
    launchDir,
    locations: resolveLocations(env, launchDir),
    inFlight: new Map(),
    closed: false,
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
    gateIdleMs: options.gateIdleMs ?? DEFAULT_IDLE_MS,
  };
  const decoder = new StringDecoder('utf8');
  let pending = '';

  for await (const chunk of input) {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      let record = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (record.endsWith('\r')) record = record.slice(0, -1);
      await handleLine(record, context);
      newline = pending.indexOf('\n');
    }
  }
  // EOF ends the loop. A trailing fragment without LF is not a record: JSONL
  // framing terminates every record with one.
  //
  // EOF is DEC-103's second trigger and a different act from a cancellation: the
  // client is gone. Stop admitting, abort every in-flight run through the same
  // ladder, wait for their cleanup and audit flush, and return — no result is
  // written down the closed channel, and no child outlives the server.
  context.closed = true;
  const inFlight = [...context.inFlight.values()].flat();
  for (const call of inFlight) call.controller.abort('eof');
  await Promise.all(inFlight.map((call) => call.done));
}
