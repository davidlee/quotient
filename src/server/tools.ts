// The five tools this server exposes, and the shape of each call's arguments.
//
// The table is the wire's contract with the orchestrator (`tools/list`), and the
// readers are its only readers: each request's own shape is checked here, before
// any admission step or the registry looks at it. Nothing in this module knows
// about policy, sessions or the runs — it is the vocabulary the rest of the
// server speaks, and the order it checks in is the order a caller is told about.

import { resolve } from 'node:path';
import type { Section } from '../help/help.ts';
import { isRecord } from '../json.ts';
import { RUN_NAME_GRAMMAR, sha256Hex } from './evidence.ts';
import { SESSION_GRAMMAR } from './session.ts';

export type ToolName = 'pi_agent' | 'pi_agent_start' | 'pi_agent_wait' | 'pi_agent_ack' | 'pi_agent_cancel';

/** The MCP hints a client reads to decide whether to prompt (design sec-2),
 *  each optional as MCP declares them. `destructiveHint` is left at its default
 *  everywhere. */
type Annotations = { readOnlyHint?: boolean; openWorldHint?: boolean; idempotentHint?: boolean };

/** One tool: its input schema (kept literal, so a reader can see its fields),
 *  its hints, and the help section that is its description. */
type Tool<S extends object = object> = { inputSchema: S; annotations: Annotations; section: Section };

const tool = <S extends object>(inputSchema: S, annotations: Annotations, section: Section): Tool<S> => ({
  inputSchema,
  annotations,
  section,
});

/** Today's `pi_agent` arguments, plus the lane a run may queue in. */
const AGENT_PROPERTIES = {
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
  lane: {
    type: 'string',
    description: 'Queue the run behind the runs already started in this lane: it launches once they settle.',
  },
  needs_success: {
    type: 'boolean',
    description: "With lane: launch only if the lane's previous run completed; otherwise the run is refused.",
  },
};

/** A schema over PROPERTIES that refuses any field it does not declare. */
const schema = <P extends object>(
  properties: P,
  required: string[],
): { type: 'object'; properties: P; required: string[]; additionalProperties: false } => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** The run ids `pi_agent_ack` and `pi_agent_cancel` act on. */
const RUN_IDS = {
  type: 'array',
  items: { type: 'string' },
  description: 'Run ids, as their handles name them.',
};

/** The five tools, in the order `tools/list` names them. Each description is
 *  its help section, read at start-up. */
export const TOOLS = {
  pi_agent: tool(schema(AGENT_PROPERTIES, ['prompt', 'profile']), { readOnlyHint: false, openWorldHint: true }, 'tool'),
  pi_agent_start: tool(
    schema(
      {
        ...AGENT_PROPERTIES,
        key: {
          type: 'string',
          description: 'Up to 128 printable ASCII characters. A repeated start with the same key and request answers the same run.',
        },
      },
      ['prompt', 'profile'],
    ),
    { readOnlyHint: false, openWorldHint: true },
    'tool-start',
  ),
  pi_agent_wait: tool(
    schema(
      {
        runs: { ...RUN_IDS, description: 'The runs to wait on.' },
        lanes: { type: 'array', items: { type: 'string' }, description: 'Wait on every run in these lanes.' },
        until: { type: 'string', enum: ['all', 'any'], description: 'Answer when all, or any, of the runs settle. Default all.' },
        timeout_s: { type: 'number', description: 'Seconds to wait before answering with what is settled; 0 answers now.' },
        status_only: { type: 'boolean', description: 'Answer with each run\'s status and no result. Default false.' },
        budget_bytes: { type: 'integer', description: 'Soft byte ceiling for the answer.' },
      },
      [],
    ),
    { readOnlyHint: true },
    'tool-wait',
  ),
  pi_agent_ack: tool(schema({ runs: RUN_IDS }, ['runs']), { readOnlyHint: false, idempotentHint: true }, 'tool-ack'),
  pi_agent_cancel: tool(schema({ runs: RUN_IDS }, ['runs']), { readOnlyHint: false, idempotentHint: true }, 'tool-cancel'),
} satisfies Record<ToolName, Tool>;

/** A `pi_agent` or `pi_agent_start` call's arguments, once their shape has been checked. */
export type AgentRequest = {
  prompt: string;
  profile: string;
  cwd?: string;
  session?: string;
  tools?: string[];
  ceilings?: { requests?: number; context_tokens?: number; cost_usd?: number; wall_clock_s?: number };
  transcript_budget_bytes?: number;
  lane?: string;
  needs_success?: boolean;
  key?: string;
};

/** A `pi_agent_wait` call's arguments, defaults filled in. */
export type WaitRequest = {
  runs?: string[];
  lanes?: string[];
  until: 'all' | 'any';
  timeout_s?: number;
  status_only: boolean;
  budget_bytes?: number;
};

/** What every reader answers. */
type Read<T> = { ok: true; request: T } | Invalid;

/** One ceilings object: the four units this build reads. */
type Ceilings = NonNullable<AgentRequest['ceilings']>;

/** The ceiling units, as a request and the policy's maxima both name them. */
export const CEILING_FIELDS = ['requests', 'context_tokens', 'cost_usd', 'wall_clock_s'] as const;

type CeilingField = (typeof CEILING_FIELDS)[number];

const AGENT_FIELDS = [
  'prompt',
  'profile',
  'cwd',
  'session',
  'tools',
  'ceilings',
  'transcript_budget_bytes',
  'lane',
  'needs_success',
];

const WAIT_FIELDS = ['runs', 'lanes', 'until', 'timeout_s', 'status_only', 'budget_bytes'];

/** A key: 1-128 printable ASCII characters (design sec-2). */
const KEY_GRAMMAR = /^[\x20-\x7e]{1,128}$/;

/** What a failed shape check says: the field to name in a `request-invalid`
 *  detail (DEC-103's token). */
type Invalid = { ok: false; detail: string };

const invalid = (detail: string): Invalid => ({ ok: false, detail });

/** One present field's value, checked: `field` names it in the detail. */
type Parse<T> = (held: unknown, field: string) => { ok: true; value: T } | Invalid;

/** One step of a reader: a check of VALUE that may write onto REQUEST. */
type Step<R> = (value: Record<string, unknown>, request: R) => Invalid | null;

const isCeilingField = (field: string): field is CeilingField =>
  CEILING_FIELDS.some((known) => known === field);

const string: Parse<string> = (held, field) =>
  typeof held === 'string' ? { ok: true, value: held } : invalid(`${field} must be a string`);

const boolean: Parse<boolean> = (held, field) =>
  typeof held === 'boolean' ? { ok: true, value: held } : invalid(`${field} must be a boolean`);

/** A string GRAMMAR matches. */
const matching = (grammar: RegExp): Parse<string> => (held, field) =>
  typeof held === 'string' && grammar.test(held)
    ? { ok: true, value: held }
    : invalid(`${field} must match ${grammar.source}`);

/** A number ACCEPTS, which WHAT names. */
const number = (accepts: (held: number) => boolean, what: string): Parse<number> => (held, field) =>
  typeof held === 'number' && accepts(held) ? { ok: true, value: held } : invalid(`${field} must be ${what}`);

/** An array of strings, each of which ACCEPTS, which WHAT names. */
const strings = (accepts: (item: string) => boolean, what: string): Parse<string[]> => (held, field) => {
  if (!Array.isArray(held)) {return invalid(`${field} must be an array of ${what}`);}
  const items: unknown[] = held;
  const names = items.filter((item): item is string => typeof item === 'string' && accepts(item));
  return names.length === items.length ? { ok: true, value: names } : invalid(`${field} must be an array of ${what}`);
};

const until: Parse<WaitRequest['until']> = (held, field) =>
  held === 'all' || held === 'any' ? { ok: true, value: held } : invalid(`${field} must be "all" or "any"`);

const runIds = strings((id) => RUN_NAME_GRAMMAR.test(id), 'run ids');

const finite = number(Number.isFinite, 'a finite number');

/** The `ceilings` object: known fields only, each a finite number. */
const ceilings: Parse<Ceilings> = (held) => {
  if (!isRecord(held)) {return invalid('ceilings must be an object');}
  const limits: Ceilings = {};
  for (const field of Object.keys(held)) {
    if (field === 'tokens') {
      return invalid('ceilings.tokens is no longer supported; use ceilings.context_tokens');
    }
    if (!isCeilingField(field)) {return invalid(`unknown field: ceilings.${field}`);}
    const limit = finite(held[field], `ceilings.${field}`);
    if (!limit.ok) {return limit;}
    limits[field] = limit.value;
  }
  return { ok: true, value: limits };
};

/** FIELD of VALUE, which must be present. */
function required<T>(value: Record<string, unknown>, field: string, parse: Parse<T>): { ok: true; value: T } | Invalid {
  const held = value[field];
  return held === undefined ? invalid(`${field} is required`) : parse(held, field);
}

/** A step that reads FIELD, when present, onto the request's field of that name. */
function optional<R, K extends keyof R & string>(field: K, parse: Parse<NonNullable<R[K]>>): Step<R> {
  return (value, request) => {
    const held = value[field];
    if (held === undefined) {return null;}
    const read = parse(held, field);
    if (!read.ok) {return read;}
    request[field] = read.value;
    return null;
  };
}

/** `needs_success: true` names a predecessor, which only a lane has. */
const laneForNeedsSuccess: Step<AgentRequest> = (_value, request) =>
  request.needs_success === true && request.lane === undefined ? invalid('needs_success: true needs a lane') : null;

/**
 * Read ARGS: an object holding only FIELDS, named in its key order; then the
 * request BEGIN reads from it; then each of STEPS, in order. The first failure
 * is the detail.
 */
function readArguments<R>(
  args: unknown,
  fields: readonly string[],
  begin: (value: Record<string, unknown>) => Read<R>,
  steps: readonly Step<R>[],
): Read<R> {
  if (!isRecord(args)) {return invalid('arguments is not an object');}
  const stray = Object.keys(args).find((field) => !fields.includes(field));
  if (stray !== undefined) {return invalid(`unknown field: ${stray}`);}
  const begun = begin(args);
  if (!begun.ok) {return begun;}
  for (const step of steps) {
    const failed = step(args, begun.request);
    if (failed !== null) {return failed;}
  }
  return begun;
}

/** The two required strings, checked in the order the request declares them. */
function promptAndProfile(value: Record<string, unknown>): Read<AgentRequest> {
  const prompt = required(value, 'prompt', string);
  if (!prompt.ok) {return prompt;}
  const profile = required(value, 'profile', string);
  if (!profile.ok) {return profile;}
  return { ok: true, request: { prompt: prompt.value, profile: profile.value } };
}

const AGENT_STEPS: readonly Step<AgentRequest>[] = [
  optional('cwd', string),
  optional('session', string),
  optional('tools', strings(() => true, 'strings')),
  optional('ceilings', ceilings),
  optional('transcript_budget_bytes', number(Number.isInteger, 'an integer')),
  optional('lane', matching(SESSION_GRAMMAR)),
  optional('needs_success', boolean),
  laneForNeedsSuccess,
];

/**
 * Check a `pi_agent` call's own shape, or with `options.key` a
 * `pi_agent_start` call's, which may also carry a `key`. Returns the field to
 * name in a `request-invalid` detail. The token is DEC-103's; DEC-103 names no
 * position for it, and this build puts the request's own shape first — a caller
 * with a broken request is told about its request rather than about a policy it
 * cannot see. The order is: a start-up snapshot that did not load
 * (`profile-invalid`, every call) -> request shape (`request-invalid`) -> step 1
 * policy -> step 2 enabled -> step 3 profile -> step 4 root -> step 5
 * capability/form -> step 6 ceilings -> `tools` narrowing -> step 7 session ->
 * step 8 child view -> the seam. The steps after the request's shape are
 * `admission.ts`'s.
 */
export function readAgentRequest(args: unknown, options = { key: false }): Read<AgentRequest> {
  return options.key
    ? readArguments(args, [...AGENT_FIELDS, 'key'], promptAndProfile, [...AGENT_STEPS, optional('key', matching(KEY_GRAMMAR))])
    : readArguments(args, AGENT_FIELDS, promptAndProfile, AGENT_STEPS);
}

/** Check a `pi_agent_wait` call's shape; `until` defaults to all, `status_only` to false. */
export function readWaitRequest(args: unknown): Read<WaitRequest> {
  return readArguments<WaitRequest>(args, WAIT_FIELDS, () => ({ ok: true, request: { until: 'all', status_only: false } }), [
    optional('runs', runIds),
    optional('lanes', strings((lane) => SESSION_GRAMMAR.test(lane), 'lane names')),
    optional('until', until),
    optional('timeout_s', number((seconds) => Number.isFinite(seconds) && seconds >= 0, 'a non-negative finite number')),
    optional('status_only', boolean),
    optional('budget_bytes', number((bytes) => Number.isInteger(bytes) && bytes > 0, 'a positive integer')),
  ]);
}

/** Check a `pi_agent_ack` or `pi_agent_cancel` call's shape: `runs` and nothing else. */
export function readRunIds(args: unknown): Read<{ runs: string[] }> {
  return readArguments(args, ['runs'], (value) => {
    const runs = required(value, 'runs', runIds);
    return runs.ok ? { ok: true, request: { runs: runs.value } } : runs;
  }, []);
}

/** A JSON replacer that writes every object's keys in sorted order. */
const sortedKeys = (_key: string, held: unknown): unknown =>
  isRecord(held) ? Object.fromEntries(Object.entries(held).sort(([a], [b]) => (a < b ? -1 : 1))) : held;

/**
 * The digest a key replay compares (design sec-7): sha256 over the request with
 * its keys sorted, after normalising what two spellings of one request may
 * differ in — `cwd` resolved against LAUNCHDIR (lexically: the digest is pure),
 * an absent `needs_success` as false, empty `ceilings` as none, `tools` as a
 * sorted set — and with `key`,
 * which names the request rather than being part of it, left out (JSON drops an
 * undefined member).
 */
export function argsDigest(request: AgentRequest, launchDir: string): string {
  const normal = {
    ...request,
    key: undefined,
    cwd: resolve(launchDir, request.cwd ?? '.'),
    needs_success: request.needs_success ?? false,
    ceilings: request.ceilings !== undefined && Object.keys(request.ceilings).length > 0 ? request.ceilings : undefined,
    ...(request.tools === undefined ? {} : { tools: [...new Set(request.tools)].sort() }),
  };
  return sha256Hex(JSON.stringify(normal, sortedKeys));
}
