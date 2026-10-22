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

export type Env = Record<string, string | undefined>;

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
    mode: 'per-call',
    roots: ['/work/one'],
    maxima: { requests: 20, tokens: 100000, cost_usd: 1.5, wall_clock_s: 600 },
    profiles: ['read', 'write'],
    forms: { read: '/nix/store/aaa/bin/pi-mcp-read', write: '/nix/store/aaa/bin/pi-mcp-write' },
    child_binds: ['/home/operator/.pi'],
    enabled: true,
    transcript_budget_bytes: 8192,
    ...overrides,
  };
}

/** The three launch-env paths a temp tree holds, named as the server reads them. */
export function launchEnv(dir: string): Env {
  return {
    PI_MCP_POLICY: join(dir, 'policy.json'),
    PI_MCP_RUN_DIR: join(dir, 'run'),
    PI_MCP_SESSION_HOME: join(dir, 'sessions'),
  };
}

export type Workspace = { env: Env; dir: string; policyPath: string; runDir: string };

/** A temp tree with a policy file and the three launch-env paths. */
export function workspace(policy: unknown = validPolicy(), options: { raw?: boolean } = {}): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-ws-'));
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
  const profilesDir = join(dir, 'profiles');
  mkdirSync(profilesDir);
  const readLauncher = stubLauncher(dir, 'pi-mcp-read', options.read ?? QUIET, markerDir);
  const writeLauncher = stubLauncher(dir, 'pi-mcp-write', options.write ?? QUIET, markerDir);
  const policyPath = join(dir, 'policy.json');
  writeFileSync(
    policyPath,
    `${JSON.stringify(
      validPolicy({
        roots: [root],
        forms: { read: readLauncher, write: writeLauncher },
        child_binds: [],
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
  done: Promise<void>;
  stderr: () => string;
};

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
  const done = serve(input, output, env, diagnostics, options);
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
    done,
    stderr: () => err.join(''),
  };
}

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
