// The wire's two eras and the tasks extension (design sec-2, sec-7).
//
// Every request is classified by its own `params._meta`: there is no process-wide
// era. A legacy request is served as before; a modern one (2026-07-28) carries
// `resultType` on every result, may reach `server/discover` and the three `tasks/*`
// methods, and may be answered with a task. Everything here is pure: the server
// hands the task methods what they read of runs through `TaskDeps`, so this
// module imports neither the registry nor the server.
import { isRecord } from '../json.ts';
import { taskOf, toolResult } from './documents.ts';
import { RUN_NAME_GRAMMAR } from './evidence.ts';
import type { Resolution } from './views.ts';

export const MODERN_VERSION = '2026-07-28';
/** The revision `initialize` answers, as `satan/satan-mcp.el` announces it. */
export const LEGACY_VERSION = '2025-06-18';
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';

/** A JSON-RPC error body. */
export type RpcError = { code: number; message: string; data?: unknown };

export type Era =
  | { era: 'legacy' }
  | { era: 'modern'; capabilities: Record<string, unknown> }
  | { error: RpcError & { code: -32022 | -32602 } };

/**
 * Sec-2's era table, in its order: no version key is legacy; a version that is not
 * a string is -32602; a string other than the modern revision is -32022, even with
 * no capabilities; then capabilities that are not an object are -32602.
 */
export function classifyEra(params: unknown): Era {
  if (!isRecord(params) || !isRecord(params._meta) || !Object.hasOwn(params._meta, VERSION_KEY)) {
    return { era: 'legacy' };
  }
  const meta = params._meta;
  const version = meta[VERSION_KEY];
  if (typeof version !== 'string') {
    return { error: { code: -32602, message: `_meta ${VERSION_KEY} must be a string` } };
  }
  if (version !== MODERN_VERSION) {
    return {
      error: { code: -32022, message: 'Unsupported protocol version', data: { supported: [MODERN_VERSION], requested: version } },
    };
  }
  const capabilities = meta[CAPABILITIES_KEY];
  if (!isRecord(capabilities)) {
    return { error: { code: -32602, message: `_meta ${CAPABILITIES_KEY} must be an object` } };
  }
  return { era: 'modern', capabilities };
}

/** Whether a request may be answered with a task: modern, and its client declares
 *  the tasks extension — the extension's only handshake (EVD-004). */
export function declaresTasks(era: Era): boolean {
  if (!('era' in era) || era.era !== 'modern') {return false;}
  const { extensions } = era.capabilities;
  return isRecord(extensions) && Object.hasOwn(extensions, TASKS_EXTENSION);
}

/** A modern result: RESULT plus its `resultType`. */
export function modernResult(result: object, resultType: 'complete' | 'task'): object {
  return { ...result, resultType };
}

/** What `tools/list` and `server/discover` say of caching: the descriptions are
 *  rendered from local policy on every request, so re-fetch, and never share. */
export const LIST_CACHE = { ttlMs: 0, cacheScope: 'private' } as const;

/** `server/discover`'s body: the one result that carries server info in `_meta`. */
export function discoverResult(instructions: string, serverInfo: { name: string; version: string }): object {
  return modernResult(
    {
      supportedVersions: [MODERN_VERSION],
      capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } },
      instructions,
      _meta: { [SERVER_INFO_KEY]: serverInfo },
      ...LIST_CACHE,
    },
    'complete',
  );
}

/** What the task methods read of runs, and how they cancel one. `cancel` marks the
 *  run and starts its ending synchronously; it never waits for the run to end. */
export type TaskDeps = { resolve(run: string): Resolution; cancel(run: string): void };

type TaskAnswer = { result: object } | { error: RpcError };

const EMPTY = { result: modernResult({}, 'complete') };
const UNREADABLE: TaskAnswer = { error: { code: -32603, message: 'the result could not be read; retry' } };

/** The task a request names, resolved: a malformed or unknown `taskId` is -32602,
 *  and a malformed one is never resolved. */
function namedTask(params: unknown, deps: TaskDeps): { run: string; resolved: Exclude<Resolution, null> } | { error: RpcError } {
  const taskId = isRecord(params) ? params.taskId : undefined;
  if (typeof taskId !== 'string' || !RUN_NAME_GRAMMAR.test(taskId)) {
    return { error: { code: -32602, message: 'taskId must be a run id' } };
  }
  const resolved = deps.resolve(taskId);
  if (resolved === null) {return { error: { code: -32602, message: `unknown task: ${taskId}` } };}
  return { run: taskId, resolved };
}

/** `tasks/get`: the Task plus sec-2's status-table member — a settled run's result
 *  as blocking `pi_agent` would answer it, or a lost run's error. A result that
 *  cannot be read now has no status to report. */
export function tasksGet(params: unknown, deps: TaskDeps): TaskAnswer {
  const named = namedTask(params, deps);
  if ('error' in named) {return named;}
  if (named.resolved === 'unreadable') {return UNREADABLE;}
  const { view, result } = named.resolved;
  let member: object = {};
  if (view.state === 'settled') {
    if (result === null) {return UNREADABLE;}
    if (result.state !== 'cancelled') {member = { result: modernResult(toolResult(result), 'complete') };}
  } else if (view.state === 'lost') {
    member = {
      error: { code: -32603, message: 'run lost: no result was recorded; inspect the evidence directory', data: { dir: view.layout.dir } },
    };
  }
  return { result: modernResult({ ...taskOf(view), ...member }, 'complete') };
}

/** `tasks/cancel`: a queued or running run is cancelled; any other is left as it is.
 *  Answered at once either way: cancellation is cooperative. */
export function tasksCancel(params: unknown, deps: TaskDeps): TaskAnswer {
  const named = namedTask(params, deps);
  if ('error' in named) {return named;}
  const { resolved } = named;
  if (resolved !== 'unreadable' && (resolved.view.state === 'queued' || resolved.view.state === 'running')) {
    deps.cancel(named.run);
  }
  return EMPTY;
}

/** `tasks/update`: no run ever asks for input, so there is nothing to update. */
export function tasksUpdate(params: unknown, deps: TaskDeps): TaskAnswer {
  const named = namedTask(params, deps);
  return 'error' in named ? named : EMPTY;
}
