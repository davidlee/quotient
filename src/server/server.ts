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
import { RESULT_SCHEMA, refusedResult, failedResult } from './result.ts';
import type { AgentResult, Artifacts, ResultState, Termination } from './result.ts';
import { admitCall, clampCeilings, createPostureState, knownRunDir, selectForm } from './policy.ts';
import type { PostureState } from './policy.ts';
import { checkProfileExtensions, effectiveTools, loadProfiles, resolveProfile, resolveRoot } from './profiles.ts';
import type { SnapshotLoad } from './profiles.ts';
import { acquireSession } from './session.ts';
import { checkChildView } from './childview.ts';
import { attemptsPath, appendAttempt, writeAttemptProbe } from './evidence.ts';
import type { CallId, RunLayout } from './evidence.ts';
import { runChild, DEFAULT_GRACE_MS } from './spawn.ts';
import type { RunOutcome } from './spawn.ts';
import { createGate, DEFAULT_IDLE_MS } from './gate.ts';

export const SERVER_NAME = 'pi-mcp';
export const SERVER_VERSION = '0';
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
  posture: PostureState;
  /** The start-up snapshot, or the failure that put the server in the start-up-refused state. */
  profiles: SnapshotLoad;
  /** What an absent `cwd` resolves to, through the same allowlist as any root. */
  launchDir: string;
  /** `tools/call` is the only method that overlaps the reader (design sec-4); a
   *  cancellation names one of these by its request id. */
  inFlight: Map<string, InFlightCall>;
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
 * The order is: request shape (`request-invalid`) -> step 1 policy -> step 2
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

// ── The run: evidence, the ladder's outcome and the provisional result ─────
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
    process.stderr.write(`pi-mcp: could not write ${layout.transcript} / ${layout.status}: ${message}\n`);
    return false;
  }
}

/** The stop reasons design sec-5 names as terminal, verbatim (pi's tokens). */
const TERMINAL_REASONS: readonly Termination[] = ['stop', 'length', 'error', 'aborted', 'toolUse', 'deferred'];

/**
 * The run's termination when nothing aborted it: what the stream's terminal reason
 * and the child's exit status already say. Reported, not interpreted — PHASE-08
 * owns the rest of the mapping (sec-5's table).
 */
function runTermination(reduced: Reduced, outcome: RunOutcome): Termination {
  if (outcome.spawnFailed) return 'spawn';
  if (outcome.exitCode !== 0) return 'exit';
  const reason = reduced.terminalReason;
  const terminal = TERMINAL_REASONS.find((candidate) => candidate === reason);
  return terminal ?? 'eof';
}

type ProvisionalInput = {
  reduced: Reduced;
  outcome: RunOutcome;
  session: string;
  /** An audit or evidence append failed after the child was launched. */
  auditFailed: boolean;
};

/**
 * The PROVISIONAL result builder. PHASE-08 replaces it with sec-5's precedence
 * table, the abort latch and the enum-reachability claims; what stands here is
 * only design sec-5 without a table.
 *
 * `completed` requires ALL of: `agent_settled` observed, exit status 0, a
 * terminal reason that answers (`stop` / `length`), accounting known, and no
 * abort cause — so a nonzero exit is never success, and an answer is never
 * inferred from exit 0 (EX-7). Everything else is `failed`, or `cancelled` when
 * DEC-103's cancel caused the abort, with `causes[0]` reported as the
 * termination.
 */
function provisionalResult(input: ProvisionalInput): AgentResult {
  const { reduced, outcome } = input;
  const artifacts: Artifacts = {
    dir: outcome.layout.dir,
    events: outcome.layout.events,
    transcript: outcome.layout.transcript,
    status: outcome.layout.status,
    audit: outcome.layout.audit,
  };
  const causes: Termination[] = [];
  if (outcome.abort !== null) causes.push(outcome.abort);
  if (outcome.spawnFailed) causes.push('spawn');
  if (input.auditFailed) causes.push('audit');

  const completed =
    causes.length === 0 &&
    outcome.exitCode === 0 &&
    reduced.settled &&
    (reduced.terminalReason === 'stop' || reduced.terminalReason === 'length') &&
    reduced.accounting === 'known';

  if (completed) {
    const termination = reduced.terminalReason as Termination;
    return {
      schema: RESULT_SCHEMA,
      state: 'completed',
      termination,
      causes: [termination],
      session: input.session,
      final: true,
      truncated: reduced.truncated,
      result: reduced.result,
      transcript: reduced.transcript,
      status: reduced.status,
      artifacts,
      refusal: null,
    };
  }

  const termination = causes.length > 0 ? causes[0] : runTermination(reduced, outcome);
  const reported = causes.length > 0 ? causes : [termination];
  // The one provisional cause -> state map. PHASE-08 replaces it with DEC-093's
  // table in result.ts; this is sec-5's row for each cause the gate can raise.
  const state: ResultState =
    termination === 'cancelled'
      ? 'cancelled'
      : termination === 'audit'
        ? 'audit_failed'
        : termination === 'ceiling'
          ? 'ceiling_exceeded'
          : termination === 'timeout'
            ? 'timeout'
            : termination === 'accounting'
              ? 'accounting_unknown'
              : 'failed';
  return {
    schema: RESULT_SCHEMA,
    state,
    termination,
    causes: reported,
    session: input.session,
    final: false,
    truncated: false,
    result: null,
    transcript: reduced.transcript,
    status: reduced.status,
    artifacts,
    refusal: null,
  };
}

function toolResult(document: AgentResult): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(document) }],
    isError: document.state !== 'completed',
  };
}

/** Record a refusal at the request boundary: the ledger's other writer. */
function refused(context: Context, callId: CallId, reason: string, detail: string): ToolResult {
  appendAttempt(knownRunDir(context.env), { callId, reason, detail });
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

  const admission = admitCall(context.env, context.posture, id);
  if (!admission.ok) return toolResult(refusedResult(admission.reason, admission.detail));

  const refuse = (reason: string, detail: string): ToolResult => {
    appendAttempt(admission.runDir, { callId: id, reason, detail, policyDigest: admission.digest });
    return toolResult(refusedResult(reason, detail));
  };

  // Step 3: the profile, from the start-up snapshot only.
  const profile = resolveProfile(snapshot, request.profile, admission.policy.profiles);
  if (!profile.ok) return refuse(profile.reason, profile.detail);

  // Step 4: the root, canonicalised and allowlisted by components.
  const root = resolveRoot(request.cwd, context.launchDir, admission.policy.roots);
  if (!root.ok) return refuse(root.reason, root.detail);

  // Step 5: the capability selects the wrapper form, and the form's declared
  // extensions must be able to deliver the profile's tools (EX-7).
  const form = selectForm(admission.policy, profile.profile.filesystem);
  if (!form.ok) return refuse(form.reason, form.detail);
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

  // The gate (design sec-4, PHASE-07): one tick evaluator over the clamped
  // snapshot, aborting through this call's own controller so a crossing reaches
  // the ladder exactly as a cancellation does. Created after the last refusal
  // that precedes the run, so its idle poll never outlives a call.
  const gate = createGate({
    ceilings: ceilings.ceilings,
    policyPath: admission.policyPath,
    abort: (cause) => controller.abort(cause),
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
      childBinds: admission.policy.child_binds,
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
    // reducer that owns the accounting, with the policy's transcript budget.
    const reduced = reduce(run.lines, { budgetBytes: admission.policy.transcript_budget_bytes });
    const wrote = writeRunFiles(run.layout, reduced);

    // The child's exit status and the observed `agent_settled` are REPORTED to the
    // builder, not interpreted here (EX-7).
    const document = provisionalResult({
      reduced,
      outcome: run,
      session: session.session,
      auditFailed: run.auditFailed || !wrote,
    });
    return toolResult(document);
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
    context.diagnostics.write('pi-mcp: unparsable JSON-RPC line dropped\n');
    return;
  }
  if (!isRecord(message)) {
    context.diagnostics.write('pi-mcp: JSON-RPC message is not an object; dropped\n');
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
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
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
      // tick finds it instead of racing the registration.
      context.inFlight.set(key, entry);
      entry.done = (async () => {
        try {
          const result = await callTool(message.params, id, context, entry.controller);
          if (!context.closed) reply(context, { id, result });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          context.diagnostics.write(`pi-mcp: call ${String(id)} failed while running: ${detail}\n`);
          if (!context.closed) {
            reply(context, { id, result: toolResult(failedResult('error', ['error'], `the server failed while running this call: ${detail}`)) });
          }
        } finally {
          context.inFlight.delete(key);
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
  context.inFlight.get(callKey(requestId))?.controller.abort('cancelled');
}

/**
 * Serve one client over `input`/`output` until stdin EOF. Takes its streams, its
 * environment and its two deployment locations, so the protocol is driven
 * in-process by the tests; `main.ts` wires the process's own.
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
    diagnostics.write(`pi-mcp: the profile snapshot did not load: ${profiles.path}: ${profiles.detail}\n`);
  }
  const context: Context = {
    output,
    diagnostics,
    env,
    posture: createPostureState(),
    profiles,
    launchDir: options.launchDir ?? process.cwd(),
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
  const inFlight = [...context.inFlight.values()];
  for (const call of inFlight) call.controller.abort('eof');
  await Promise.all(inFlight.map((call) => call.done));
}
