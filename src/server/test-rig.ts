// The rig the spawn and gate suites run against: a stub launcher this module
// writes into a temp tree it creates, a deployment naming it, and a server in
// this process whose input channel the test owns. The run suites share it too:
// the fake launch, the staged pid table and the run-directory fixtures below are
// the same levers `runs.test.ts` and `views.test.ts` drive.
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
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveLocations } from '../config.ts';
import { reduce, type Reduced } from '../reduce/reduce.ts';
import { isRecord } from '../json.ts';
import { serve, type ServeOptions } from './server.ts';
import { APPROVALS_SCHEMA } from './approvals.ts';
import type { Admitted, Refused } from './admission.ts';
import {
  appendAudit,
  attemptsPath,
  layoutFor,
  readAudit,
  readResult,
  runName,
  sha256Hex,
  writeResult,
  type AuditRecord,
  type CallId,
  type RunLayout,
} from './evidence.ts';
import type { Filesystem } from './profiles.ts';
import { createRegistry, type Launch, type Registry, type RunRecord, type StartSpec } from './runs.ts';
import type { HostIdentity, RunOwner } from './session.ts';
import { admitCall, type Admission } from './policy.ts';
import { resultFor, type AgentResult, type Artifacts, type LatchCause, type RunFacts } from './result.ts';

export type Env = Record<string, string | undefined>;

/** Steps 1-2 for an environment, as the server resolves it. */
export const admit = (env: Env, callId: CallId): Admission =>
  admitCall(resolveLocations(env), callId);

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
    schema: 'quotient-policy/2',
    mode: 'per-call',
    roots: ['/work/one'],
    maxima: { requests: 20, context_tokens: 100000, cost_usd: 1.5, wall_clock_s: 600 },
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
  for (const [name, text] of Object.entries(documents)) {writeFileSync(join(layer, `${name}.md`), text);}
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

/** A form's identity as the approvals store records it. */
export type RigForm = { path: string; sha256: string };

/**
 * An executable at PATH in the rig's stub shape, with its identity, creating the
 * directory it needs. The one place a test's executable is written: the machine
 * forms a policy names and the project forms a probe judges are made the same way.
 */
export function executableAt(path: string, body: string = QUIET): RigForm {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${body}\n`);
  chmodSync(path, 0o755);
  return { path, sha256: sha256Hex(readFileSync(path)) };
}

/** A stub launcher: an executable in the test's own tree, `@MARKER@` replaced by
 *  the marker directory the stub records into (never the run dir). */
const stubLauncher = (dir: string, name: string, body: string, markerDir: string): string =>
  executableAt(join(dir, `${name}.sh`), body.replaceAll('@MARKER@', markerDir)).path;

/** An executable inside the rig but outside every roots entry: a project form's
 *  ordinary target, where no delegate admitted under the policy can rewrite it. */
export function rigForm(rig: Rig, name: string, body: string = QUIET): RigForm {
  return executableAt(join(rig.dir, `${name}.sh`), body.replaceAll('@MARKER@', rig.markerDir));
}

/** Plant `<base>/.quotient/forms/<capability>` as a symlink to TARGET, the shape
 *  an operator publishes, and return the link's path. */
export function plantProjectForm(
  rig: Rig,
  target: RigForm,
  options: { base?: string; capability?: Filesystem } = {},
): string {
  const { base = rig.root, capability = 'write' } = options;
  const dir = join(base, '.quotient', 'forms');
  mkdirSync(dir, { recursive: true });
  const link = join(dir, capability);
  symlinkSync(target.path, link);
  return link;
}

/** The approvals store the rig's server reads: `<rig XDG config>/quotient/approvals.json`. */
export const rigApprovalsPath = (rig: Rig): string => join(rig.dir, 'config', 'quotient', 'approvals.json');

/** Record approvals where `quotient allow` would: the rig's own XDG store. */
export function writeApprovals(
  rig: Rig,
  entries: { root?: string; capability?: Filesystem; form: RigForm }[],
): string {
  const path = rigApprovalsPath(rig);
  mkdirSync(dirname(path), { recursive: true });
  const approvals = entries.map(({ root = rig.root, capability = 'write', form }) => ({
    root,
    capability,
    path: form.path,
    sha256: form.sha256,
    approved_at: '2026-10-24T05:12:44.000Z',
  }));
  writeFileSync(path, `${JSON.stringify({ schema: APPROVALS_SCHEMA, approvals }, null, 2)}\n`);
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
  /** The server's launch dir: it defaults a call's `cwd` and resolves a relative
   *  one, and it holds no layer (`.quotient/` there is ordinary project content). */
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
    if (!name.endsWith('pid') && !name.endsWith('pids')) {continue;}
    for (const raw of readText(join(markerDir, name)).split('\n')) {
      const pid = Number(raw.trim());
      if (!Number.isInteger(pid) || pid <= 0) {continue;}
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
  // The rig plants nothing under the launch dir: the XDG profile layer is the
  // one layer a server launched here reads.
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
  if (!existsSync(runDir)) {return [];}
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

/** The `spawn` record of a run, read from its audit: what was launched, and from
 *  where. The audit has no contract (research F5), so the record's shape is this
 *  reader's and the suites' assertions'. */
export function spawnRecord(audit: string): Record<string, unknown> {
  const records: unknown[] = jsonLines(audit);
  const spawn = records.find((record) => isRecord(record) && record.record === 'spawn');
  if (!isRecord(spawn)) {assert.fail(`no spawn record in ${audit}`);}
  return spawn;
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
    if (Date.now() > deadline) {throw new Error(`timed out waiting for ${what}`);}
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
    if (Date.now() > deadline) {throw new Error(`timed out waiting for ${count} replies: ${server.stderr()}`);}
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
    if (raw.trim().length === 0) {continue;}
    try {
      const message = JSON.parse(raw) as Record<string, unknown>;
      if (message && typeof message === 'object' && Object.hasOwn(message, 'id')) {count += 1;}
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
  if (expected > 0) {await waitForReplies(server, expected);}
  await closeServer(server);
  return { replies: server.replies(), stderr: server.stderr() };
}

/** The pi-agent-result/2 document inside one tool result. */
export function resultDocument(reply: Record<string, any>): Record<string, any> {
  assert.equal(reply.error, undefined, 'a call must never surface as a JSON-RPC error');
  return JSON.parse(reply.result.content[0].text) as Record<string, any>;
}

/** One process as a fake pid table should show it: its start time, and the host
 *  facts the session module reads to decide where a pid means something. */
export type FakeProcOwner = { pid: number; starttime: string; boot?: string; pidns?: string; timens?: string; nspid?: number[] };

/**
 * A pid table staged under DIR, for `ServeOptions.procDir` and
 * `AcquireOptions.procDir`: `<proc>/<pid>/stat` for the staged owner with
 * `starttime` at field 22, PLUS this process's own stat line copied from /proc/self, so
 * an acquisition always finds its own start time under any staged owner.
 *
 * `boot` stages `sys/kernel/random/boot_id`, `pidns` and `timens` the `self/ns/pid`
 * and `self/ns/time` symlinks, and
 * `nspid` the `NSpid:` line of `self/status` (an empty list omits it). Nothing
 * staged is nothing written: the reader sees null. `'unreadable'` is a path that
 * does not exist, which is what an unreadable pid table looks like.
 */
export function fakeProc(dir: string, staged: FakeProcOwner | 'unreadable'): string {
  const procDir = join(dir, 'proc');
  if (staged === 'unreadable') {return procDir;}

  const own = join(procDir, String(process.pid), 'stat');
  mkdirSync(dirname(own), { recursive: true });
  // `/proc/self`, not `/proc/<process.pid>`: under a /proc mounted from an
  // ancestor pid namespace, `process.pid` numbers another process there.
  copyFileSync('/proc/self/stat', own);

  // A staged owner that IS this process keeps the real stat line: its start time
  // is the one the kernel reports, so the record and the table agree.
  if (staged.pid !== process.pid) {
    const owner = String(staged.pid);
    const stat = join(procDir, owner, 'stat');
    mkdirSync(dirname(stat), { recursive: true });
    const fields = Array.from({ length: 18 }, () => '0');
    writeFileSync(stat, `${owner} (node) S ${fields.join(' ')} ${staged.starttime} 0 0\n`);
  }

  const nspid = staged.nspid ?? [process.pid];
  const status = join(procDir, 'self', 'status');
  mkdirSync(dirname(status), { recursive: true });
  writeFileSync(status, `Name:\tnode\n${nspid.length === 0 ? '' : `NSpid:\t${nspid.join('\t')}\n`}`);

  if (staged.boot !== undefined) {
    const bootId = join(procDir, 'sys', 'kernel', 'random', 'boot_id');
    mkdirSync(dirname(bootId), { recursive: true });
    writeFileSync(bootId, `${staged.boot}\n`);
  }

  for (const [name, id] of [['pid', staged.pidns], ['time', staged.timens]] as const) {
    if (id === undefined) {continue;}
    const ns = join(procDir, 'self', 'ns', name);
    mkdirSync(dirname(ns), { recursive: true });
    symlinkSync(id, ns);
  }

  return procDir;
}

// ── The run registry's fake launch (sec-9) ────────────────────────────────
//
// `runs.ts` drives every run from a single seam — the `Launch` it is given — so
// a suite owns the whole lifecycle with no processes: each launch is a
// `Pending` the test settles by hand, with a document, a refusal, a rejection
// or a synchronous throw. The one fact the fixture cannot know by itself is
// which record a `release()` belongs to, so the release spy is *watched*: the
// test names the record immediately after `start` returns (a launch runs in a
// microtask, so nothing has fired yet) and each release records what was true
// at that instant — whether `result.json` had landed, whether the `lost` record
// was already published, the record's state and the stack depth. A release that
// fires before the watch records `unwatched`, which is what a publish failure
// (no record yet) must look like.

/** What one `release()` saw, measured as it was called. */
export type ReleaseCall = {
  /** Whether `result.json` existed then. */
  resultExists: boolean;
  /** Whether a `lost` audit record was already readable then. */
  lostReadable: boolean;
  /** The record's state then, or 'unwatched' when no record had been named. */
  state: string;
  /** `new Error().stack`'s frame count then: `settle` must not recurse (EX-4). */
  frames: number;
};

/** The release of one fixture session: where its calls land, and the record they
 *  speak about. */
export type ReleaseSpy = {
  calls: ReleaseCall[];
  release(): void;
  /** Name the record releases belong to; call it before the launch's microtask. */
  watch(record: RunRecord): void;
};

/** One launched run: what the registry handed the fake, and the ways it ends. */
export type Pending = {
  record: RunRecord;
  admitted: Admitted;
  /** True iff the launch happened outside the `start` that admitted the run (C4). */
  queued: boolean;
  onAudit: (ts: string) => void;
  /** End the run task with this document. */
  result(document: AgentResult): void;
  /** End it as a re-admission refusal: the registry writes the `refused` record. */
  refuse(refused: Refused): void;
  /** End it by rejecting, as a run task that threw after launch — with any value. */
  reject(error: unknown): void;
};

/** One fixture admission: what `start` consumes, and the spy to read afterwards. */
export type FakeAdmission = { admitted: Admitted; release: ReleaseSpy };

/** `fakeLaunch`'s handle: the `Launch` to hand `createRegistry`, and its levers. */
export type FakeLaunch = {
  launch: Launch;
  /** Every launch, in the order the registry made them. */
  launches: Pending[];
  /** The run dir every fixture admission shares unless it names its own. */
  runDir: string;
  /** Make the next launch call throw synchronously, as a broken run task would. */
  throwNext(): void;
  admitted(options?: { runDir?: string; session?: string; callId?: CallId }): FakeAdmission;
};

/** The audit record kinds a run left, in order; none when the audit is unreadable. */
export function auditKinds(layout: RunLayout): string[] {
  const audit = readAudit(layout);
  return audit === null ? [] : audit.records.map((record) => record.record);
}

/** A completed `pi-agent-result/2` document for a run at LAYOUT, from the real
 *  reducer and builder: exactly what a run that answered and exited 0 writes.
 *  TEXT is the answer, so a case can choose a result's size. */
export function completedResult(layout: RunLayout, session: string, text = 'the answer'): AgentResult {
  return resultFor({
    reduced: reduce([messageEnd('stop', text), SETTLED_RECORD], {}),
    outcome: { exitCode: 0, spawnFailed: false, layout },
    causes: [],
    session,
  });
}

/** The release spy: one call per release, each measuring the moment it fired. */
function releaseSpy(): ReleaseSpy {
  let watched: RunRecord | undefined;
  const calls: ReleaseCall[] = [];
  return {
    calls,
    watch: (record: RunRecord): void => {
      watched = record;
    },
    release: (): void => {
      calls.push({
        state: watched === undefined ? 'unwatched' : watched.state,
        resultExists: watched !== undefined && existsSync(watched.layout.result),
        lostReadable: watched !== undefined && auditKinds(watched.layout).includes('lost'),
        frames: new Error('release').stack?.split('\n').length ?? 0,
      });
    },
  };
}

/** One `Admitted` at RUN_DIR, whose session reports its release to RELEASE. */
function admittedFixture(
  runDir: string,
  session: string,
  callId: CallId,
  release: ReleaseSpy,
): Admitted {
  const root = join(runDir, 'root');
  const sessions = join(runDir, 'sessions');
  const sessionDir = join(sessions, session);
  return {
    request: { prompt: 'work', profile: 'read', cwd: root },
    root,
    profile: { name: 'read', source: join(runDir, 'read.md'), filesystem: 'read', model: 'fake/model', tools: [] },
    form: { kind: 'unconfined', pi: '/bin/pi' },
    formSource: { kind: 'policy' },
    ceilings: {},
    tools: [],
    session: {
      ok: true,
      session,
      sessionDir,
      paths: {
        home: runDir,
        sessions,
        sessionDir,
        lock: join(sessions, `${session}.lock`),
        binding: join(sessions, `${session}.binding`),
        claim: join(sessions, `${session}.claim`),
      },
      root,
      capability: 'read',
      binding: { session, root, capability: 'read', bound: '2026-01-01T00:00:00.000Z' },
      owner: FIXTURE_OWNER,
      release: (): void => {
        release.release();
      },
    },
    policyDigest: 'policy-digest-1',
    policyPath: join(runDir, 'policy.json'),
    runDir,
    transcriptBudget: undefined,
    callId,
  };
}

/**
 * The fake `Launch` (sec-9): every run waits for the test to end it. Registered
 * on T, its temp run dir is removed when the test finishes.
 */
export function fakeLaunch(t?: TestContext): FakeLaunch {
  const runDir = mkdtempSync(join(tmpdir(), 'pi-runs-'));
  if (t !== undefined) {
    t.after(() => {
      rmSync(runDir, { recursive: true, force: true });
    });
  }
  const launches: Pending[] = [];
  let throws: Error | undefined;
  let minted = 0;

  const launch: Launch = (
    record: RunRecord,
    admitted: Admitted,
    queued: boolean,
    onAudit: (ts: string) => void,
  ): Promise<{ refused: Refused } | { result: AgentResult }> => {
    const throwing = throws;
    if (throwing !== undefined) {
      throws = undefined;
      throw throwing;
    }
    return new Promise<{ refused: Refused } | { result: AgentResult }>((resolve, reject) => {
      launches.push({
        record,
        admitted,
        queued,
        onAudit,
        result: (document) => {
          resolve({ result: document });
        },
        refuse: (refused) => {
          resolve({ refused });
        },
        reject,
      });
    });
  };

  return {
    launch,
    launches,
    runDir,
    throwNext: (): void => {
      throws = new Error('the launch threw');
    },
    admitted: (options = {}): FakeAdmission => {
      minted += 1;
      const release = releaseSpy();
      const session = options.session ?? `sess-${String(minted)}`;
      const callId = options.callId ?? `call-${String(minted)}`;
      return { release, admitted: admittedFixture(options.runDir ?? runDir, session, callId, release) };
    },
  };
}

// ── Run fixtures shared by the runs and views suites ──────────────────────
//
// Both suites drive the registry through the one fake launch, and both stage run
// directories on disk, so the pieces they each carried live here once: the
// identity a fixture records and the liveness rows that identity is read
// against, the disk fixture (`runIn`) with the records it writes, the temp-path
// blockers, and the registry levers (`registryFor`, `startRun`, `tick`,
// `launchFor`).

/** The owner every fixture records: one server, one host. */
export const FIXTURE_OWNER: RunOwner = {
  pid: 4242,
  starttime: '1000',
  boot: 'boot-a',
  pidns: 'pid:[1]',
  timens: 'time:[1]',
  host: 'host-a',
};

/** The reader's identity when it is that same server (D-4: `here` is passed in). */
export const FIXTURE_HERE: HostIdentity = { boot: 'boot-a', pidns: 'pid:[1]', timens: 'time:[1]', host: 'host-a' };

/** The session a fixture run owns, unless it names one. */
export const FIXTURE_SESSION = 'sess-views';

/** The owner's pid alive in the staged table: same pid, same start time. */
export const OWNER_ALIVE: FakeProcOwner = { pid: FIXTURE_OWNER.pid, starttime: FIXTURE_OWNER.starttime };

/** The owner's pid reused by another process: a different kernel start time. */
export const OWNER_REUSED: FakeProcOwner = { pid: FIXTURE_OWNER.pid, starttime: '2000' };

/** The owner's pid gone: the table stages some other process instead. */
export const OWNER_GONE: FakeProcOwner = { pid: 5000, starttime: '1000' };

/** Append one audit record the test can name: a fixture's records must land. */
export function appendRecord(layout: RunLayout, record: AuditRecord): string {
  const ts = appendAudit(layout, record);
  if (ts === null) {
    assert.fail(`the ${record.record} record must land`);
  }
  return ts;
}

/** What a fixture run directory is asked to hold. */
export type RunSpec = {
  /** Whether an `admitted` record is written at all (default true). */
  admitted?: boolean;
  /** The owner the admitted record names; null records none (default FIXTURE_OWNER). */
  owner?: RunOwner | null;
  lane?: string | null;
  key?: string | null;
  predecessor?: string | null;
  session?: string;
  /** Extra audit records, appended after the admitted one. */
  records?: AuditRecord[];
  /** Whether a completed `result.json` is written (default false). */
  result?: boolean;
  /** Start the audit with a partly written line that has no newline (sec-7). */
  torn?: boolean;
};

/** One fixture run directory, and the timestamps its records were given. */
export type Fixture = {
  run: string;
  layout: RunLayout;
  session: string;
  /** Each `appendAudit` answer, in the order the records were appended. */
  stamps: string[];
};

/** The `admitted` record a run from this release leaves: where it sits, the
 *  session it owns and the owner; a run from before the release named no owner. */
export function admittedRecord(owner: RunOwner | null, spec: RunSpec, session: string): AuditRecord {
  const record: AuditRecord = {
    record: 'admitted',
    origin: 'start',
    lane: spec.lane ?? null,
    predecessor: spec.predecessor ?? null,
    needs_success: false,
    key: spec.key ?? null,
    session,
    policy_digest: 'policy-digest-1',
  };
  if (owner !== null) {
    record.owner = owner;
  }
  return record;
}

/** A record that was only partly written: no newline, so `appendAudit` starts the
 *  next record on a fresh line and a torn line never hides the records after it. */
export function tornLine(layout: RunLayout): void {
  writeFileSync(layout.audit, '{"record":"admit');
}

/**
 * One run directory under DIR: an `admitted` record naming LANE, KEY,
 * PREDECESSOR, SESSION and the owner, any extra records, a torn line if asked,
 * and a completed `result.json` if asked.
 */
export function runIn(dir: string, spec: RunSpec = {}): Fixture {
  const run = runName('call');
  const layout = layoutFor(dir, run);
  const session = spec.session ?? FIXTURE_SESSION;
  mkdirSync(layout.dir, { recursive: true });
  if (spec.torn === true) {
    tornLine(layout);
  }
  const stamps = auditRecords(layout, spec, session);
  if (spec.result === true) {
    writeResult(layout, completedResult(layout, session));
  }
  return { run, layout, session, stamps };
}

/** The trail a fixture leaves: the admitted record unless a pre-release run is
 *  staged, then any extra records, each stamped as it lands. */
export function auditRecords(layout: RunLayout, spec: RunSpec, session: string): string[] {
  const stamps: string[] = [];
  if (spec.admitted !== false) {
    const owner = spec.owner === undefined ? FIXTURE_OWNER : spec.owner;
    stamps.push(appendRecord(layout, admittedRecord(owner, spec, session)));
  }
  for (const record of spec.records ?? []) {
    stamps.push(appendRecord(layout, record));
  }
  return stamps;
}

/** The result document a run left and the moment it was written, or a failed
 *  expectation: the one read every suite asks of `result.json`. */
export function foundResult(layout: RunLayout): { found: AgentResult; writtenAt: string } {
  const read = readResult(layout);
  if (read === 'absent' || read === 'unreadable') {
    assert.fail(`the run must have left a result, saw ${read}`);
  }
  return read;
}

/** Make PATH unwritable as a file, by replacing whatever is there with a
 *  non-empty directory (C6): neither a rename nor an append can land on it, and
 *  a read of it fails with something other than ENOENT. */
export function block(path: string): void {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(join(path, 'x'), { recursive: true });
}

/** Make RUN's `result.json` unwritable while leaving it absent: the temp it is
 *  written to cannot be made, so the rename never happens — what a failed commit
 *  leaves on disk (blocking `result.json` itself would make it unreadable). */
export function blockResultWrite(layout: RunLayout): void {
  block(join(layout.dir, '.result.json.tmp'));
}

/** One run a test started: the registry's record, its document, and the spy. */
export type Started = {
  record: RunRecord;
  document: Promise<AgentResult>;
  admitted: Admitted;
  release: ReleaseSpy;
};

/** The fields `startRun` defaults: a plain unlaned start in the only door a suite
 *  takes, with no key and one digest (a key's own cases pass both). */
export const DEFAULT_START: Omit<StartSpec, 'admitted'> = {
  origin: 'start',
  lane: null,
  needsSuccess: false,
  key: null,
  argsDigest: 'digest-1',
};

/** One admitted run, with the release spy wired to the record `start` answered.
 *  A launch runs in a microtask, so naming the record here is always in time. */
export function startRun(
  registry: Registry,
  fake: FakeLaunch,
  options: Partial<Omit<StartSpec, 'admitted'>> & { fixture?: FakeAdmission } = {},
): Started {
  const fixture = options.fixture ?? fake.admitted();
  const started = registry.start({ ...DEFAULT_START, ...options, admitted: fixture.admitted });
  if (!started.ok) {
    assert.fail(`start refused: ${started.reason}: ${started.detail}`);
  }
  fixture.release.watch(started.record);
  return { record: started.record, document: started.document, admitted: fixture.admitted, release: fixture.release };
}

/** One macrotask, so every microtask the registry queued has run. */
export const tick = (): Promise<void> => new Promise<void>((resolve) => {
  setImmediate(resolve);
});

/** The launch the fake recorded for RECORD, once the registry's microtask ran it. */
export async function launchFor(fake: FakeLaunch, record: RunRecord): Promise<Pending> {
  for (let tries = 0; tries < 50; tries += 1) {
    const found = fake.launches.find((pending) => pending.record.run === record.run);
    if (found !== undefined) {
      return found;
    }
    await tick();
  }
  assert.fail(`no launch for ${record.run}`);
}

/** A registry over the fake launch; its diagnostics sink is not asserted here. */
export function registryFor(fake: FakeLaunch): Registry {
  return createRegistry({ launch: fake.launch, diagnostics: new PassThrough() });
}
