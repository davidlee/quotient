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
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { refusedResult, failedResult } from './result.ts';
import type { AgentResult } from './result.ts';
import { admitCall, clampCeilings, createPostureState, knownRunDir, selectForm } from './policy.ts';
import type { PostureState } from './policy.ts';
import { checkProfileExtensions, effectiveTools, loadProfiles, resolveProfile, resolveRoot } from './profiles.ts';
import type { SnapshotLoad } from './profiles.ts';
import { appendAttempt } from './evidence.ts';
import type { CallId } from './evidence.ts';

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
type Context = {
  output: Writable;
  diagnostics: Writable;
  env: Record<string, string | undefined>;
  posture: PostureState;
  /** The start-up snapshot, or the failure that put the server in the start-up-refused state. */
  profiles: SnapshotLoad;
  /** What an absent `cwd` resolves to, through the same allowlist as any root. */
  launchDir: string;
};

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
 * ceilings -> `tools` narrowing -> the seam.
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

/**
 * The seam: steps 1-6 and the `tools` narrowing passed, and everything that
 * turns an admitted call into a run does not exist in this build. PHASE-04 adds
 * sessions, PHASE-05 the child-view check and the evidence layout, PHASE-06 the
 * spawn itself — each replacing this answer from its own step. The snapshot's
 * digest is what PHASE-06 records in the run's audit `spawn` record. Nothing here
 * launches a process, so there is no second launch path to fall back to.
 */
function admittedWithoutRun(): AgentResult {
  return failedResult(
    'spawn',
    ['spawn'],
    'pi_agent admitted this call and launched nothing: the session, child-view and spawn stages are not built yet (SL-029 PHASE-04..06).',
  );
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
 * 1-6, the `tools` narrowing, then the seam. Every refusal is a tool result,
 * recorded in `attempts.jsonl` as it is decided.
 */
async function callTool(params: unknown, id: WireId, context: Context): Promise<ToolResult> {
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
  const profile = resolveProfile(context.profiles.snapshot, request.profile, admission.policy.profiles);
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
  // `tools.tools`) and the snapshot digest are what PHASE-06's spawn consumes;
  // this build stops at the seam below.
  const document = admittedWithoutRun();
  appendAttempt(admission.runDir, {
    callId: id,
    reason: document.termination,
    detail: document.transcript,
    policyDigest: admission.digest,
  });
  return toolResult(document);
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
      // Accepted and ignored: no call is in flight in this build. PHASE-06 gives
      // it teeth, aborting exactly the request id it names.
      return;
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
    case 'tools/call':
      reply(context, { id, result: await callTool(message.params, id, context) });
      return;
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
};

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
}
