// The one tool this server exposes, and the shape of a call's arguments.
//
// The declaration is the wire's contract with the orchestrator (`tools/list`),
// and `readAgentRequest` is its one reader: the request's own shape is checked
// here, before any admission step looks at it. Nothing in this module knows
// about policy, sessions or the run — it is the vocabulary the rest of the
// server speaks, and the order it checks in is the order a caller is told about.

import { isRecord } from '../json.ts';

/** The one tool this server exposes, with its declared input schema. Its
 *  description is the `tool` help section, read at start-up. */
export const PI_AGENT_TOOL = {
  name: 'pi_agent',
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
          context_tokens: { type: 'number' },
          cost_usd: { type: 'number' },
          wall_clock_s: { type: 'number' },
        },
        description: 'Per-call requests, peak context_tokens, cost and wall-clock ceilings. May only lower the policy maxima.',
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
  ceilings?: { requests?: number; context_tokens?: number; cost_usd?: number; wall_clock_s?: number };
  transcript_budget_bytes?: number;
};

/** One ceilings object: the four units this build reads. */
type Ceilings = NonNullable<AgentRequest['ceilings']>;

const CEILING_FIELDS = ['requests', 'context_tokens', 'cost_usd', 'wall_clock_s'] as const;

type CeilingField = (typeof CEILING_FIELDS)[number];

const ARGUMENT_FIELDS = [
  'prompt',
  'profile',
  'cwd',
  'session',
  'tools',
  'ceilings',
  'transcript_budget_bytes',
];

/** What a failed shape check says: the field to name in a `request-invalid`
 *  detail (DEC-103's token). */
type Invalid = { ok: false; detail: string };

const invalid = (detail: string): Invalid => ({ ok: false, detail });

const isCeilingField = (field: string): field is CeilingField =>
  CEILING_FIELDS.some((known) => known === field);

/** The first field the request does not declare, named in its key order. */
function strayField(value: Record<string, unknown>): Invalid | null {
  const field = Object.keys(value).find((key) => !ARGUMENT_FIELDS.includes(key));
  return field === undefined ? null : invalid(`unknown field: ${field}`);
}

/** The two required strings, checked in the order the request declares them. */
function required(value: Record<string, unknown>): { ok: true; prompt: string; profile: string } | Invalid {
  const prompt = value.prompt;
  if (prompt === undefined) {return invalid('prompt is required');}
  if (typeof prompt !== 'string') {return invalid('prompt must be a string');}
  const profile = value.profile;
  if (profile === undefined) {return invalid('profile is required');}
  if (typeof profile !== 'string') {return invalid('profile must be a string');}
  return { ok: true, prompt, profile };
}

/** `cwd` and `session`: optional strings, written onto REQUEST when present. */
function optionalStrings(value: Record<string, unknown>, request: AgentRequest): Invalid | null {
  for (const field of ['cwd', 'session'] as const) {
    const holder = value[field];
    if (holder === undefined) {continue;}
    if (typeof holder !== 'string') {return invalid(`${field} must be a string`);}
    request[field] = holder;
  }
  return null;
}

/** A tool list: an array of strings, or nothing. */
function toolsOf(value: unknown, request: AgentRequest): Invalid | null {
  if (value === undefined) {return null;}
  if (!Array.isArray(value)) {return invalid('tools must be an array of strings');}
  const items: unknown[] = value;
  const tools = items.filter((tool): tool is string => typeof tool === 'string');
  if (tools.length !== items.length) {return invalid('tools must be an array of strings');}
  request.tools = tools;
  return null;
}

/** The `ceilings` object: known fields only, each a finite number. */
function ceilingsOf(value: unknown, request: AgentRequest): Invalid | null {
  if (value === undefined) {return null;}
  if (!isRecord(value)) {return invalid('ceilings must be an object');}
  const limits: Ceilings = {};
  for (const field of Object.keys(value)) {
    if (field === 'tokens') {
      return invalid('ceilings.tokens is no longer supported; use ceilings.context_tokens');
    }
    if (!isCeilingField(field)) {return invalid(`unknown field: ceilings.${field}`);}
    const limit = value[field];
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
      return invalid(`ceilings.${field} must be a finite number`);
    }
    limits[field] = limit;
  }
  request.ceilings = limits;
  return null;
}

/** The transcript budget: an integer, or nothing. */
function budgetOf(value: unknown, request: AgentRequest): Invalid | null {
  if (value === undefined) {return null;}
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return invalid('transcript_budget_bytes must be an integer');
  }
  request.transcript_budget_bytes = value;
  return null;
}

/**
 * Check the request's own shape. Returns the field to name in a
 * `request-invalid` detail. The token is DEC-103's; DEC-103 names no position for
 * it, and this build puts the request's own shape first — a caller with a broken
 * request is told about its request rather than about a policy it cannot see.
 * The order is: a start-up snapshot that did not load (`profile-invalid`, every
 * call) -> request shape (`request-invalid`) -> step 1 policy -> step 2
 * enabled -> step 3 profile -> step 4 root -> step 5 capability/form -> step 6
 * ceilings -> `tools` narrowing -> step 7 session -> step 8 child view -> the
 * seam. The steps after the request's shape are `admission.ts`'s.
 */
export function readAgentRequest(
  value: Record<string, unknown>,
): { ok: true; request: AgentRequest } | Invalid {
  const stray = strayField(value);
  if (stray !== null) {return stray;}

  const both = required(value);
  if (!both.ok) {return both;}

  const request: AgentRequest = { prompt: both.prompt, profile: both.profile };
  const named = optionalStrings(value, request);
  if (named !== null) {return named;}
  const tools = toolsOf(value.tools, request);
  if (tools !== null) {return tools;}
  const ceilings = ceilingsOf(value.ceilings, request);
  if (ceilings !== null) {return ceilings;}
  const budget = budgetOf(value.transcript_budget_bytes, request);
  if (budget !== null) {return budget;}
  return { ok: true, request };
}
