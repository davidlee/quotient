// The rig the spawn and gate suites run against: a stub launcher this module
// writes into a temp tree it creates, a deployment naming it, and a server in
// this process whose input channel the test owns.
//
// The stub records what it was given — argv, environment, file descriptors,
// stdin — into a marker directory OUTSIDE the run dir, so the run's evidence is
// never a place the test looks for the child's own notes. Every rig registers a
// teardown that SIGKILLs the groups its stubs reported, so a stub that ignores
// SIGTERM cannot be orphaned by a failed assertion.
//
// This file is not a suite: the runner glob is `src/**/*.test.ts`, so it never
// runs on its own.
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from './server.ts';
import type { ServeOptions } from './server.ts';
import { attemptsPath } from './evidence.ts';
import { admitCall } from './policy.ts';
import type { Admission } from './policy.ts';
import type { CallId } from './evidence.ts';
import { resolveLocations } from '../config.ts';
import { reduce } from '../reduce/reduce.ts';
import type { Reduced } from '../reduce/reduce.ts';
import { resultFor } from './result.ts';
import type { AgentResult, Artifacts, LatchCause, RunFacts } from './result.ts';

export type Env = Record<string, string | undefined>;

/** Steps 1-2 for an environment, as the server resolves it from a launch dir. */
export const admit = (env: Env, callId: CallId, launchDir = '/launch'): Admission =>
  admitCall(resolveLocations(env, launchDir), callId);

/** The server as a real process: the bare bin, which serves MCP on stdio. */
export const serverCommand: [string, string[]] = [process.execPath, [new URL('../cli.ts', import.meta.url).pathname]];

export const line = (message: Record<string, unknown>): string => JSON.stringify({ jsonrpc: '2.0', ...message });
export const callLine = (id: number | string, args: Record<string, unknown>): string =>
  line({ id, method: 'tools/call', params: { name: 'pi_agent', arguments: args } });

/** A bash line that writes one event record on stdout, newline-terminated. */
export function emit(record: Record<string, unknown>): string {
  return `printf '%s\\n' '${JSON.stringify(record)}'`;
}

/** `agent_settled`: the stream's own statement that the run came to rest. */
export const SETTLED = emit({ type: 'agent_settled' });

/** The default stub for either form: a stub that settles and exits 0. */
const QUIET = `${SETTLED}\nexit 0`;

/** A policy with every declared field present, per the schema in EX-6. */
export function validPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'quotient-policy/1',
    mode: 'per-call',
    roots: ['/work/one'],
    maxima: { requests: 20, tokens: 100000, cost_usd: 1.5, wall_clock_s: 600 },
    profiles: { read: 'read', write: 'write' },
    forms: { read: '/nix/store/aaa/bin/pi-mcp-read', write: '/nix/store/aaa/bin/pi-mcp-write' },
    exposure: ['/home/operator/.pi'],
    enabled: true,
    transcript_budget_bytes: 8192,
    ...overrides,
  };
}

/**
 * The launch-env paths a temp tree holds, named as the server reads them. The
 * XDG config home is the tree's own, so the XDG profile and help layers never
 * reach the operator's real `~/.config/quotient`.
 */
export function launchEnv(dir: string): Env {
  return {
    QUOTIENT_POLICY: join(dir, 'policy.json'),
    QUOTIENT_RUN_DIR: join(dir, 'run'),
    QUOTIENT_SESSION_HOME: join(dir, 'sessions'),
    XDG_CONFIG_HOME: join(dir, 'config'),
  };
}

/** The XDG profile layer under a tree `launchEnv` names. */
export const xdgProfileLayer = (dir: string): string => join(dir, 'config', 'quotient', 'profiles');

/** The XDG help layer under a tree `launchEnv` names. */
export const xdgHelpLayer = (dir: string): string => join(dir, 'config', 'quotient', 'help');

/** One profile document in the header format the loader documents. */
export function profileDocument(
  overrides: { filesystem?: string; model?: string; thinking?: string; tools?: string } = {},
): string {
  return [
    '<!-- quotient-profile',
    `filesystem: ${overrides.filesystem ?? 'read'}`,
    `model: ${overrides.model ?? 'llm-gateway/deepseek-flash'}`,
    ...(overrides.thinking === undefined ? [] : [`thinking: ${overrides.thinking}`]),
    `tools: ${overrides.tools ?? 'read, grep, find, ls, bash'}`,
    '-->',
    '',
    '# profile',
    '',
    'Prose the loader ignores: only the header is machine-readable.',
    '',
  ].join('\n');
}

/** Write one `<name>.md` per entry into LAYER, creating it; the layer path. */
export function writeProfiles(layer: string, documents: Record<string, string>): string {
  mkdirSync(layer, { recursive: true });
  for (const [name, text] of Object.entries(documents)) writeFileSync(join(layer, `${name}.md`), text);
  return layer;
}

/** The fixture profiles every rig serves: one per capability. */
export const RIG_PROFILES: Record<string, string> = {
  read: profileDocument(),
  write: profileDocument({ filesystem: 'write', tools: 'read, bash, edit, write, grep, find, ls' }),
};

export type Workspace = { env: Env; dir: string; policyPath: string; runDir: string };

/** A temp tree with a policy file, the launch-env paths and RIG_PROFILES in
 *  its XDG profile layer. */
export function workspace(policy: unknown = validPolicy(), options: { raw?: boolean } = {}): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-ws-'));
  writeProfiles(xdgProfileLayer(dir), RIG_PROFILES);
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, options.raw ? String(policy) : JSON.stringify(policy, null, 2));
  const runDir = join(dir, 'run');
  return {
    env: launchEnv(dir),
    dir,
    policyPath,
    runDir,
  };
}

/** A stub launcher: a bash script in the test's own tree, `@MARKER@` replaced by
 *  the marker directory the stub records into (never the run dir). */
function stubLauncher(dir: string, name: string, body: string, markerDir: string): string {
  const path = join(dir, `${name}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${body.replaceAll('@MARKER@', markerDir)}\n`);
  chmodSync(path, 0o755);
  return path;
}

export type Rig = {
  dir: string;
  /** Outside the run dir, so evidence and the child's own notes never mix. */
  markerDir: string;
  runDir: string;
  sessionHome: string;
  root: string;
  policyPath: string;
  /** The server's launch dir: its `.quotient/` is the highest layer, and it is
   *  not the root, so a write call is not refused for containing it. */
  launchDir: string;
  /** The XDG profile layer, seeded with RIG_PROFILES. */
  profilesDir: string;
  readLauncher: string;
  writeLauncher: string;
  /** The server's environment: the process's own plus this deployment's three. */
  env: Env;
};

/** Change one field of the policy on disk, as an operator's flip would. */
export function patchPolicy(rig: Rig, field: string, value: unknown): void {
  const policy = JSON.parse(readFileSync(rig.policyPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(rig.policyPath, JSON.stringify({ ...policy, [field]: value }));
}

/** Kill every group a stub reported, ignoring one that is already gone. */
function killSurvivors(markerDir: string): void {
  for (const name of readdirSync(markerDir)) {
    if (!name.endsWith('pid') && !name.endsWith('pids')) continue;
    for (const raw of readText(join(markerDir, name)).split('\n')) {
      const pid = Number(raw.trim());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }
}

/**
 * A deployment: a root, a run dir, a session home, a profiles dir, a policy
 * naming two stub launchers, and a marker directory outside all of it.
 *
 * `options.policy` replaces the default policy's fields wholesale. Both forms
 * default to `QUIET`, so a case that only cares about one form says nothing.
 */
export function newRig(
  t: TestContext,
  options: { read?: string; write?: string; policy?: Record<string, unknown> } = {},
): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-rig-'));
  const markerDir = join(dir, 'markers');
  mkdirSync(markerDir);
  const root = join(dir, 'root');
  mkdirSync(root);
  const runDir = join(dir, 'run');
  const sessionHome = join(dir, 'sessions');
  const launchDir = join(dir, 'launch');
  mkdirSync(launchDir);
  const profilesDir = writeProfiles(xdgProfileLayer(dir), RIG_PROFILES);
  const readLauncher = stubLauncher(dir, 'pi-mcp-read', options.read ?? QUIET, markerDir);
  const writeLauncher = stubLauncher(dir, 'pi-mcp-write', options.write ?? QUIET, markerDir);
  const policyPath = join(dir, 'policy.json');
  writeFileSync(
    policyPath,
    `${JSON.stringify(
      validPolicy({
        roots: [root],
        forms: { read: readLauncher, write: writeLauncher },
        exposure: [],
        transcript_budget_bytes: 4096,
        ...options.policy,
      }),
      null,
      2,
    )}\n`,
  );
  const rig: Rig = {
    dir,
    markerDir,
    runDir,
    sessionHome,
    root,
    policyPath,
    launchDir,
    profilesDir,
    readLauncher,
    writeLauncher,
    env: {
      ...process.env,
      ...launchEnv(dir),
    },
  };
  t.after(() => {
    killSurvivors(markerDir);
    rmSync(dir, { recursive: true, force: true });
  });
  return rig;
}

/** Every `run-*` directory under a run dir, in directory order. */
export function runDirs(runDir: string): string[] {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir).filter((name) => name.startsWith('run-'));
}

/** The one run directory under a run dir, once the run has allocated it. */
export function onlyRunDir(runDir: string): string {
  const runs = runDirs(runDir);
  assert.equal(runs.length, 1, `expected exactly one run directory, saw ${runs.join(', ')}`);
  return join(runDir, runs[0]);
}

// ── Result fixtures: the real reducer and builder, no child ───────────────

/** pi's `Usage` shape with every component present: missing data is then missing
 *  rather than a zero, which is the distinction accounting turns on. */
export const usage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 110,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  ...overrides,
});

/** A terminal assistant `message_end`, with pi's stop-reason token verbatim (sec-4:
 *  the token is `toolUse`, never `tool_use`). */
export function messageEnd(stop: string, text: string | null = 'the answer', usageOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: stop,
      content: text === null ? [] : [{ type: 'text', text }],
      usage: usage(usageOverrides),
    },
  });
}

/** `agent_settled` as a stream record (`SETTLED` is the stub's bash line for it). */
export const SETTLED_RECORD = JSON.stringify({ type: 'agent_settled' });

export const ARTIFACTS: Artifacts = {
  dir: '/state/runs/run-1',
  events: '/state/runs/run-1/events.jsonl',
  transcript: '/state/runs/run-1/transcript.md',
  status: '/state/runs/run-1/status.json',
  audit: '/state/runs/run-1/audit.jsonl',
};

export type RunInput = {
  lines?: string[];
  /** The child's exit status; `null` means it never exited (a failed launch). */
  exitCode?: number | null;
  spawnFailed?: boolean;
  /** The latch's committed snapshot, as the server hands it over. */
  causes?: LatchCause[];
  budgetBytes?: number;
  /** Patterns the reducer warns about (`status.alerts`). */
  alerts?: string[];
};

/** One run's result, offline: the real reducer, then the server's one builder. */
export function buildResult(input: RunInput = {}): { doc: AgentResult; reduced: Reduced } {
  const reduced = reduce(input.lines ?? [], {
    ...(input.budgetBytes === undefined ? {} : { budgetBytes: input.budgetBytes }),
    ...(input.alerts === undefined ? {} : { alerts: input.alerts }),
  });
  const outcome: RunFacts = {
    exitCode: input.exitCode === undefined ? 0 : input.exitCode,
    spawnFailed: input.spawnFailed ?? false,
    layout: ARTIFACTS,
  };
  return {
    doc: resultFor({ reduced, outcome, causes: input.causes ?? [], session: 'sess-1' }),
    reduced,
  };
}

export function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** A JSONL file as records: the audit, the attempts ledger. */
export function jsonLines(path: string): Record<string, any>[] {
  return readText(path)
    .split('\n')
    .filter((raw) => raw.length > 0)
    .map((raw) => JSON.parse(raw) as Record<string, any>);
}

/** The attempts ledger as records; a missing ledger reads as none. */
export function attempts(runDir: string): Record<string, any>[] {
  return jsonLines(attemptsPath(runDir));
}

export function markerText(rig: Rig, name: string): string {
  return readText(join(rig.markerDir, name)).trim();
}

export function markerPids(rig: Rig, name = 'pid'): number[] {
  return markerText(rig, name)
    .split('\n')
    .map((entry) => Number(entry.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Whether `pid` still exists. A missing pid is a broken rig, never "gone":
 *  `process.kill(undefined)` throws and `process.kill(0)` signals our own group. */
export function isAlive(pid: number): boolean {
  assert.ok(Number.isInteger(pid) && pid > 0, `isAlive needs a recorded pid, got ${pid}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForPath(path: string, what = path, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(5);
  }
}

/** A server in this process, with an input channel the test can write to and
 *  close: stdin EOF is a trigger here, so the test owns when it fires. */
export type LiveServer = {
  replies: () => Record<string, any>[];
  /** One record, newline-framed. */
  write: (record: string) => void;
  /** Raw bytes, exactly as given: for framing cases. */
  send: (bytes: string) => void;
  end: () => void;
  /** The input fails, as a broken stdin pipe would. */
  fail: (error: Error) => void;
  done: Promise<void>;
  stderr: () => string;
};

/**
 * A server in this process. Its launch dir defaults to a fresh empty directory
 * rather than the process cwd, so the checkout's own `.quotient/` never reaches
 * a test's snapshot.
 */
export function openServer(env: Env, options: ServeOptions = {}): LiveServer {
  const out: string[] = [];
  const err: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      out.push(String(chunk));
      done();
    },
  });
  const diagnostics = new Writable({
    write(chunk, _encoding, done) {
      err.push(String(chunk));
      done();
    },
  });
  const input = new PassThrough();
  const launchDir = options.launchDir ?? mkdtempSync(join(tmpdir(), 'quotient-launch-'));
  const done = serve(input, output, env, diagnostics, { ...options, launchDir });
  return {
    replies: () =>
      out
        .join('')
        .split('\n')
        .filter((raw) => raw.length > 0)
        .map((raw) => JSON.parse(raw) as Record<string, any>),
    write: (record) => input.write(`${record}\n`),
    send: (bytes) => input.write(bytes),
    end: () => input.end(),
    fail: (error) => input.destroy(error),
    done,
    stderr: () => err.join(''),
  };
}

/** A server for RIG, launched from the rig's own launch dir. */
export const serveRig = (rig: Rig, options: ServeOptions = {}): LiveServer =>
  openServer(rig.env, { launchDir: rig.launchDir, ...options });

export async function waitForReplies(server: LiveServer, count: number, timeoutMs = 10000): Promise<Record<string, any>[]> {
  const deadline = Date.now() + timeoutMs;
  while (server.replies().length < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} replies: ${server.stderr()}`);
    await pause(5);
  }
  return server.replies();
}

/** End one server after its answers, and wait for its cleanup. */
export async function closeServer(server: LiveServer): Promise<void> {
  server.end();
  await server.done;
}

/** How many answers the given records ask for: one per record that carries an
 *  id, and none for a notification. */
function expectedReplies(content: string): number {
  let count = 0;
  for (const raw of content.split('\n')) {
    if (raw.trim().length === 0) continue;
    try {
      const message = JSON.parse(raw) as Record<string, unknown>;
      if (message && typeof message === 'object' && Object.hasOwn(message, 'id')) count += 1;
    } catch {
      // an unparsable record answers nothing
    }
  }
  return count;
}

/**
 * Write LINES to a fresh `serve` and collect every reply it emits.
 *
 * The input stays open until the answers have arrived: `tools/call` is the one
 * method that overlaps the reader (design sec-4), and stdin EOF is DEC-103's
 * abort trigger — closing the channel first would abort the call rather than let
 * it answer.
 */
export async function converse(
  lines: string[],
  env: Env,
  options: ServeOptions & { chunks?: string[] } = {},
): Promise<{ replies: Record<string, any>[]; stderr: string }> {
  const { chunks, ...serveOptions } = options;
  const content = (chunks ?? lines.map((l) => `${l}\n`)).join('');
  const expected = expectedReplies(content);
  const server = openServer(env, serveOptions);
  server.send(content);
  if (expected > 0) await waitForReplies(server, expected);
  await closeServer(server);
  return { replies: server.replies(), stderr: server.stderr() };
}

/** The pi-agent-result/1 document inside one tool result. */
export function resultDocument(reply: Record<string, any>): Record<string, any> {
  assert.equal(reply.error, undefined, 'a call must never surface as a JSON-RPC error');
  return JSON.parse(reply.result.content[0].text) as Record<string, any>;
}
