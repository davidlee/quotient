// Tests for the spawn (design sec-3's executable contract, sec-4's spawn and
// termination ladder) and for the evidence it captures.
//
// Every case runs against a stub launcher from `test-rig.ts`: a bash script that
// module writes into the rig's temp tree. The stub records what it was given —
// argv, environment, file descriptors, stdin — into a marker directory OUTSIDE the
// run dir, so the run's evidence is never a place the test looks for the child's
// own notes. Nothing touches the network. Every rig registers a teardown that
// SIGKILLs the groups its stubs reported, so a stub that ignores SIGTERM cannot be
// orphaned by a failed assertion.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { reduce, type Tally } from '../reduce/reduce.ts';
import { buildArgv, childEnv, runChild, type SpawnPlan } from './spawn.ts';
import { runLayout, type RunLayout } from './evidence.ts';
import { executeRun, type ExecuteDeps } from './execute.ts';
import type { Profile } from './profiles.ts';
import { createRegistry } from './runs.ts';
import {
  admittedCall,
  attempts,
  auditKinds,
  callLine,
  closeServer,
  DEFAULT_START,
  onlyRunDir,
  runDirs,
  emit,
  isAlive,
  jsonLines,
  line,
  markerPids,
  markerText,
  newRig,
  profileDocument,
  serveRig,
  patchPolicy,
  pause,
  readText,
  resultDocument,
  resultJson,
  runOf,
  SETTLED,
  serverCommand,
  spawnRecord,
  waitForPath,
  waitForReplies,
  waitForResult, type Env, type Rig 
} from './test-rig.ts';


/** A usage-bearing assistant message with a terminal stop reason: a send that
 *  paid for itself, so the run's accounting stays known. */
function answer(stop: string, text = 'the answer'): string {
  return emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: stop,
      content: [{ type: 'text', text }],
      usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    },
  });
}

const READ_PROFILE: Profile = {
  name: 'read',
  source: '/profiles/read.md',
  filesystem: 'read',
  model: 'llm-gateway/deepseek-flash',
  tools: ['read', 'grep', 'bash'],
};

/** The plan an admitted call hands the spawn, for the direct cases. */
function planFor(rig: Rig, overrides: Partial<SpawnPlan> = {}): SpawnPlan {
  return {
    form: { kind: 'confined', path: rig.readLauncher, extensions: [] },
    formSource: { kind: 'policy' },
    profile: READ_PROFILE,
    session: 'session1',
    sessionDir: join(rig.sessionHome, 'session1'),
    root: rig.root,
    runDir: rig.runDir,
    callId: 1,
    tools: ['read', 'bash'],
    prompt: 'review the change\n',
    policyDigest: 'a'.repeat(64),
    profileDigest: 'b'.repeat(64),
    helpDigest: 'c'.repeat(64),
    ...overrides,
  };
}

/** A signal that never fires: the run must end itself. */
const noAbort = (): AbortController => new AbortController();

/** The one run directory's path, waiting for the run to allocate it. */
async function waitForRunDir(runDir: string): Promise<string> {
  const deadline = Date.now() + 10000;
  while (runDirs(runDir).length === 0) {
    if (Date.now() > deadline) {throw new Error(`timed out waiting for a run directory under ${runDir}`);}
    await pause(5);
  }
  return onlyRunDir(runDir);
}

/**
 * One real server process: send one request, wait for its answer, then close
 * stdin. The channel stays open until the answer arrives, because stdin EOF is
 * DEC-103's abort trigger and an aborted call is answered with nothing.
 */
async function oneShot(t: TestContext, rig: Rig, request: string, extraEnv: Env = {}): Promise<Record<string, any>> {
  const child = spawnProcess(...serverCommand, {
    cwd: rig.launchDir,
    env: { ...rig.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const out: string[] = [];
  const err: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => out.push(chunk));
  child.stderr.on('data', (chunk: string) => err.push(chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => { resolve(code); }));
  child.stdin.write(`${request}\n`);
  const deadline = Date.now() + 20000;
  while (!out.join('').includes('\n')) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`no answer from the server: ${err.join('')}`);
    }
    await pause(5);
  }
  child.stdin.end();
  assert.equal(await exited, 0, err.join(''));
  const replies = out
    .join('')
    .split('\n')
    .filter((raw) => raw.length > 0)
    .map((raw) => JSON.parse(raw) as Record<string, any>);
  assert.equal(replies.length, 1, out.join(''));
  return replies[0];
}

// ── EX-1: the launcher argv (VT-1) ─────────────────────────────────────────

test('buildArgv: pi options verbatim — no session positional, no `pi` token, no `--`', () => {
  const argv = buildArgv({
    profile: READ_PROFILE,
    session: 'sess-1',
    sessionDir: '/sessions/sess-1',
    tools: ['read', 'grep'],
  });
  assert.deepEqual(argv, [
    '--mode',
    'json',
    '--model',
    'llm-gateway/deepseek-flash',
    '--tools',
    'read,grep',
    '--session-id',
    'sess-1',
    '--session-dir',
    '/sessions/sess-1',
    '--no-extensions',
  ]);
  assert.ok(!argv.includes('pi'), 'the executable is the command, never a word of its argv');
  assert.ok(!argv.includes('--'), 'pi takes no `--` separator');
  assert.equal(argv.filter((arg) => arg === '--session-dir').length, 1);
  assert.equal(argv[0], '--mode', 'the session positional is the confined branch\'s, not buildArgv\'s');
  assert.equal(argv.filter((arg) => arg === '-e').length, 0, 'a profile with no mcp__* tool passes no -e');
  assert.equal(argv.at(-1), '--no-extensions');
});

test('buildArgv: a profile with a thinking level passes `--thinking <level>` right after the model, exactly once', () => {
  const thinkingProfile: Profile = { ...READ_PROFILE, thinking: 'high' };
  const argv = buildArgv({
    profile: thinkingProfile,
    session: 'sess-1',
    sessionDir: '/sessions/sess-1',
    tools: ['read', 'grep'],
  });
  const model = argv.indexOf('--model');
  assert.deepEqual(
    argv.slice(model, model + 4),
    ['--model', 'llm-gateway/deepseek-flash', '--thinking', 'high'],
    'the level follows the model pair immediately',
  );
  assert.equal(argv.filter((arg) => arg === '--thinking').length, 1, 'exactly one --thinking');

  const plain = buildArgv({
    profile: READ_PROFILE,
    session: 'sess-1',
    sessionDir: '/sessions/sess-1',
    tools: ['read', 'grep'],
  });
  assert.ok(!plain.includes('--thinking'), 'a profile with no level passes no --thinking');
});

test('buildArgv passes `-e builtin:mcp` exactly when the profile names an mcp__* tool', () => {
  const mcpProfile: Profile = { ...READ_PROFILE, tools: ['read', 'mcp__doctrine__search'] };
  const withMcp = buildArgv({
    profile: mcpProfile,
    session: 'sess-1',
    sessionDir: '/sessions/sess-1',
    tools: ['read', 'mcp__doctrine__search'],
  });
  assert.deepEqual(withMcp.slice(-2), ['-e', 'builtin:mcp']);
  assert.equal(withMcp.filter((arg) => arg === '-e').length, 1, 'exactly one -e');
  assert.equal(withMcp.at(-1), 'builtin:mcp');
});

test('the launcher receives the argv head and the tail separately: the session dir, then pi options', async (t) => {
  const rig = newRig(t, {
    read: `for a in "$@"; do printf '%s\n' "$a"; done > "@MARKER@/argv"\n${SETTLED}\nexit 0`,
  });
  const plan = planFor(rig);
  const outcome = await runChild(plan, { signal: noAbort().signal, env: rig.env });
  assert.equal(outcome.spawnFailed, false);

  const sawArgv = markerText(rig, 'argv').split('\n');
  // Head: the single positional the form binds at run time, then pi's own flags.
  assert.deepEqual(sawArgv.slice(0, 6), [plan.sessionDir, '--mode', 'json', '--model', 'llm-gateway/deepseek-flash', '--tools']);
  assert.equal(sawArgv[6], 'read,bash');
  // Tail: the session pair and the load-bearing --no-extensions.
  assert.deepEqual(sawArgv.slice(-5), ['--session-id', 'session1', '--session-dir', plan.sessionDir, '--no-extensions']);
  assert.equal(sawArgv.length, 12, `argv was ${JSON.stringify(sawArgv)}`);
  assert.ok(!sawArgv.includes('pi'));
  assert.ok(!sawArgv.includes('--'));
  assert.ok(!sawArgv.includes('-e'), 'the read profile names no mcp__* tool');

  const [spawned] = jsonLines(join(onlyRunDir(rig.runDir), 'audit.jsonl'));
  assert.equal(spawned.record, 'spawn');
  assert.equal(spawned.form_kind, 'confined');
  assert.equal(spawned.form, rig.readLauncher);
  assert.deepEqual(spawned.argv, sawArgv, 'the audit names the argv the command received');
});

test('the spawn record pins the form, its source and, for a project form, its root and digest', async (t) => {
  const rig = newRig(t);
  const digest = 'd'.repeat(64);
  const policyRun = await runChild(planFor(rig), { signal: noAbort().signal, env: rig.env });
  const projectRun = await runChild(
    planFor(rig, {
      callId: 2,
      form: { kind: 'confined', path: rig.writeLauncher, extensions: [] },
      formSource: { kind: 'project', root: rig.root, sha256: digest },
    }),
    { signal: noAbort().signal, env: rig.env },
  );

  const policy = spawnRecord(policyRun.layout.audit);
  assert.equal(policy.form, rig.readLauncher, 'the executed path');
  assert.equal(policy.form_source, 'policy');
  assert.equal(Object.hasOwn(policy, 'form_root'), false, 'a policy form has no root to name');
  assert.equal(Object.hasOwn(policy, 'form_sha256'), false, 'a policy form is not hashed');

  const project = spawnRecord(projectRun.layout.audit);
  assert.equal(project.form, rig.writeLauncher, 'the project form substitutes the slot executable');
  assert.equal(project.form_source, 'project');
  assert.equal(project.form_root, rig.root);
  assert.equal(project.form_sha256, digest);
});

test('an unconfined write form runs pi with pi\'s argv: no session positional, and form_kind is audited', async (t) => {
  // The stub stands in for pi itself: the policy names it as the unconfined pi.
  const rig = newRig(t, {
    write: `for a in "$@"; do printf '%s\n' "$a"; done > "@MARKER@/argv"\n${answer('stop')}\n${SETTLED}\nexit 0`,
  });
  patchPolicy(rig, 'forms', { read: rig.readLauncher, write: { unconfined: rig.writeLauncher } });

  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(8, { prompt: 'edit', profile: 'write', cwd: rig.root }));
  const [reply] = await waitForReplies(server, 1);
  await closeServer(server);

  const doc = resultDocument(reply);
  assert.equal(doc.state, 'completed', JSON.stringify(doc));
  const sawArgv = markerText(rig, 'argv').split('\n');
  assert.equal(sawArgv[0], '--mode', `pi gets no session positional: ${JSON.stringify(sawArgv)}`);
  const sessionDir = sawArgv[sawArgv.indexOf('--session-dir') + 1];
  assert.equal(sawArgv.filter((arg) => arg === sessionDir).length, 1, 'the sessionDir appears once, as --session-dir\'s value');
  assert.equal(sawArgv.at(-1), '--no-extensions');

  const spawned = spawnRecord(join(onlyRunDir(rig.runDir), 'audit.jsonl'));
  assert.equal(spawned.form_kind, 'unconfined');
  assert.equal(spawned.form, rig.writeLauncher, 'the audit names pi as the command');
  assert.deepEqual(spawned.argv, sawArgv);
});

test('an unconfined form passes no extensions, so a profile naming an mcp__* tool refuses profile-invalid', async (t) => {
  const rig = newRig(t, { write: `printf x > "@MARKER@/ran"\nexit 0` });
  writeFileSync(
    join(rig.profilesDir, 'mcp-write.md'),
    profileDocument({ filesystem: 'write', tools: 'read, write, mcp__doctrine__search' }),
  );
  patchPolicy(rig, 'profiles', { 'mcp-write': 'write' });
  patchPolicy(rig, 'forms', { read: rig.readLauncher, write: { unconfined: rig.writeLauncher } });

  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(9, { prompt: 'edit', profile: 'mcp-write', cwd: rig.root }));
  const [reply] = await waitForReplies(server, 1);
  await closeServer(server);

  const doc = resultDocument(reply);
  assert.equal(doc.state, 'refused', JSON.stringify(doc));
  assert.equal(doc.refusal.reason, 'profile-invalid');
  assert.equal(existsSync(join(rig.markerDir, 'ran')), false, 'nothing ran');
});

test('a profile that needs the MCP built-in makes the launcher receive -e builtin:mcp', async (t) => {
  const rig = newRig(t, {
    read: `for a in "$@"; do printf '%s\n' "$a"; done > "@MARKER@/argv"\n${answer('stop')}\n${SETTLED}\nexit 0`,
  });
  writeFileSync(
    join(rig.profilesDir, 'mcp-read.md'),
    profileDocument({ tools: 'read, mcp__doctrine__search' }),
  );
  patchPolicy(rig, 'profiles', { 'mcp-read': 'read' });
  patchPolicy(rig, 'forms', { read: { path: rig.readLauncher, extensions: ['builtin:mcp'] }, write: rig.writeLauncher });

  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(7, { prompt: 'search', profile: 'mcp-read', cwd: rig.root }));
  const [reply] = await waitForReplies(server, 1);
  server.end();
  await server.done;

  const doc = resultDocument(reply);
  assert.equal(doc.state, 'completed', JSON.stringify(doc));
  const sawArgv = markerText(rig, 'argv').split('\n');
  assert.deepEqual(sawArgv.slice(-2), ['-e', 'builtin:mcp']);
  assert.equal(sawArgv.filter((arg) => arg === '-e').length, 1);
  assert.equal(sawArgv.at(-3), '--no-extensions');
});

// ── EX-2: stream capture (VT-2) ────────────────────────────────────────────

test('stdout lands in events.jsonl as JSONL, stderr in its own file, never merged; the prompt rides the child\'s stdin, closed after the write', async (t) => {
  const rig = newRig(t, {
    read: [
      'cat > "@MARKER@/prompt"',
      emit({ type: 'message_start', message: { role: 'assistant' } }),
      SETTLED,
      'printf \'diagnostic: not an event\\n\' >&2',
      'exit 0',
    ].join('\n'),
  });
  const plan = planFor(rig, { prompt: 'review this diff\nplease\n' });
  const outcome = await runChild(plan, { signal: noAbort().signal, env: rig.env });

  // The stream, in order, exactly as the child wrote it.
  assert.deepEqual(outcome.lines, [
    '{"type":"message_start","message":{"role":"assistant"}}',
    '{"type":"agent_settled"}',
  ]);
  assert.equal(outcome.settled, true);
  assert.equal(outcome.exitCode, 0);

  // stdout is redirected into events.jsonl — JSONL records only — and stderr has
  // its own file, stderr.log. `2>&1` anywhere would put the diagnostic in both.
  assert.equal(basename(outcome.layout.events), 'events.jsonl');
  assert.equal(basename(outcome.layout.stderr), 'stderr.log');
  const events = readFileSync(outcome.layout.events, 'utf8');
  assert.equal(events, `${outcome.lines.join('\n')}\n`);
  for (const raw of events.split('\n').filter((entry) => entry.length > 0)) {
    assert.doesNotThrow(() => JSON.parse(raw), 'every line of events.jsonl is a JSON record');
  }
  assert.ok(!events.includes('diagnostic'), 'stderr is never merged into stdout');
  assert.equal(readFileSync(outcome.layout.stderr, 'utf8'), 'diagnostic: not an event\n');

  // The prompt went to the child's stdin, and `cat` returning is the proof the
  // pipe was closed after the write — never left open, never the server's stdin.
  assert.equal(readText(join(rig.markerDir, 'prompt')), plan.prompt);
});

// ── EX-3: the termination domain (VT-3) ────────────────────────────────────

test('the ladder signals the child\'s own group: SIGTERM, then SIGKILL after the 2 s grace when it is ignored', async (t) => {
  const rig = newRig(t, {
    read: ['trap \'\' TERM', 'printf \'%s\\n\' $$ > "@MARKER@/pid"', 'printf \'%s\\n\' $$ >> "@MARKER@/pids"', 'sleep 60'].join('\n'),
  });
  const controller = noAbort();
  const running = runChild(planFor(rig), { signal: controller.signal, env: rig.env });
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher pid');
  const [pid] = markerPids(rig, 'pids');

  const abortedAt = Date.now();
  controller.abort('cancelled');
  const outcome = await running;
  const elapsed = Date.now() - abortedAt;

  assert.equal(outcome.abort, 'cancelled');
  assert.equal(outcome.signal, 'SIGKILL', 'a TERM-ignoring child is escalated to SIGKILL');
  assert.ok(elapsed >= 2000, `the default grace is 2000 ms, measured ${elapsed}`);
  assert.equal(isAlive(pid), false, 'the group is gone');
  const records = jsonLines(outcome.layout.audit);
  assert.deepEqual(records.map((record) => record.record), ['spawn', 'abort', 'exit']);
  assert.equal(records[1].cause, 'cancelled');
  assert.equal(records[1].usage.requests, 0);
  assert.deepEqual(records[1].usage.context, { peak_tokens: null, requests_unmeasured: 0 });
  assert.equal(records[2].signal, 'SIGKILL');
});

test('detached: the child leads its own process group, so -pid reaches it and nothing else', async (t) => {
  const rig = newRig(t, {
    read: [
      'printf \'%s\\n\' $$ > "@MARKER@/pid"',
      // /proc/<pid>/stat: field 5 is the process-group id. The leader's equals its
      // own pid; a child of the server's group would carry the server's.
      'stat=$(</proc/$$/stat)',
      'rest=${stat#*) }',
      'set -- $rest',
      'printf \'%s\\n\' "$3" > "@MARKER@/pgid"',
      SETTLED,
      'exit 0',
    ].join('\n'),
  });
  // The spawn's `detached: true` is `setsid` semantics: a new session whose leader
  // is the child, which is what lets the ladder signal `-pid`.
  const outcome = await runChild(planFor(rig), { signal: noAbort().signal, env: rig.env });
  assert.equal(outcome.exitCode, 0);
  const [pid] = markerPids(rig);
  assert.equal(Number(markerText(rig, 'pgid')), pid, 'the child is its own process-group leader');
});

test('two concurrent calls and a SIGTERM-ignoring grandchild: cancelling one leaves the other and the server alive, and the cancelled subtree is gone after the grace (EX-3)', async (t) => {
  const rig = newRig(t, {
    read: [
      // The read form: a TERM-ignoring launcher whose grandchild also ignores TERM
      // and holds stdout, so only a group signal can end either.
      'trap \'\' TERM',
      'printf \'%s\\n\' $$ > "@MARKER@/read.pid"',
      'bash -c \'trap "" TERM; exec sleep 60\' &',
      'printf \'%s\\n\' $! > "@MARKER@/grandchild.pid"',
      emit({ type: 'message_start', message: { role: 'assistant' } }),
      'wait',
    ].join('\n'),
    write: [
      // The write form: a cooperative run that outlives the other call's cancel.
      'printf \'%s\\n\' $$ > "@MARKER@/write.pid"',
      'sleep 0.5',
      answer('stop', 'kept'),
      SETTLED,
      'exit 0',
    ].join('\n'),
  });
  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(1, { prompt: 'cancel me', profile: 'read', cwd: rig.root, session: 'cancelme' }));
  server.write(callLine(2, { prompt: 'keep going', profile: 'write', cwd: rig.root, session: 'keeper' }));
  await waitForPath(join(rig.markerDir, 'grandchild.pid'), 'the ignoring grandchild');

  // The wire act: one call cancelled, and both the other call and the server
  // itself (this process) must survive — a signal to the server's group would end
  // the test.
  // The cancelled call is silenced: its outcome is its result.json, and only the
  // other call and the ping answer.
  server.write(line({ method: 'notifications/cancelled', params: { requestId: 1 } }));
  const cancelled = await waitForResult(rig.runDir, runOf(rig.runDir, 1));
  await waitForReplies(server, 1);
  server.write(line({ id: 3, method: 'ping' }));
  const two = await waitForReplies(server, 2);
  server.end();
  await server.done;

  assert.equal(server.replies().find((reply) => reply.id === 1), undefined, 'the cancelled call got no reply');
  const keptReply = two.find((reply) => reply.id === 2);
  const afterPing = two.find((reply) => reply.id === 3);
  assert.ok(keptReply !== undefined && afterPing !== undefined, JSON.stringify(two));
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.termination, 'cancelled');
  assert.deepEqual(cancelled.causes, ['cancelled']);
  const kept = resultDocument(keptReply);
  assert.equal(kept.state, 'completed', JSON.stringify(kept));
  assert.equal(kept.result, 'kept');
  assert.equal(afterPing.id, 3, 'the server answered a ping after the cancel');
  assert.deepEqual(afterPing.result, { pong: true });

  // The cancelled call's whole subtree — launcher and the TERM-ignoring grandchild
  // — is gone after the grace, while the other call's launcher finished on its own.
  const [launcherPid] = markerPids(rig, 'read.pid');
  const [grandchildPid] = markerPids(rig, 'grandchild.pid');
  assert.equal(isAlive(launcherPid), false, 'the launcher is gone');
  assert.equal(isAlive(grandchildPid), false, 'the grandchild is gone: the signal reached -pid');
  const [keeperPid] = markerPids(rig, 'write.pid');
  assert.equal(isAlive(keeperPid), false, 'the other run ended itself, uncancelled');

  // Two calls, two run directories: exactly the cancelled one carries an abort.
  const audits = runDirs(rig.runDir).map((name) => jsonLines(join(rig.runDir, name, 'audit.jsonl')));
  const aborted = audits.filter((records) => records.some((record) => record.record === 'abort'));
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0].find((record) => record.record === 'abort')?.cause, 'cancelled');
});

// ── EX-5 / VT-4: non-exposure ──────────────────────────────────────────────

test('the child inherits no fd, environment variable or argv member naming QUOTIENT_RUN_DIR or the run\'s evidence files', async (t) => {
  const rig = newRig(t, {
    read: [
      'printf \'%s\\n\' $$ > "@MARKER@/pid"',
      'env > "@MARKER@/env"',
      'for a in "$@"; do printf \'%s\\n\' "$a"; done > "@MARKER@/argv"',
      'pwd -P > "@MARKER@/cwd"',
      'exec 9> "@MARKER@/fds"',
      'for fd in /proc/$$/fd/*; do printf \'%s -> %s\\n\' "${fd##*/}" "$(readlink "$fd")" >&9; done',
      'exec 9>&-',
      SETTLED,
      'exit 0',
    ].join('\n'),
  });
  const layout: RunLayout = runLayout(rig.runDir, 1);
  // The child's environment is the server's minus every QUOTIENT_* variable and
  // minus any whose value names the run dir or one of its files; PATH and the
  // provider variables are kept.
  const env: Env = {
    ...rig.env,
    LLM_GATEWAY_KEY: 'gateway-token',
    LEAK_RUN_DIR: rig.runDir,
    LEAK_EVIDENCE_FILE: layout.audit,
    QUOTIENT_EXTRA: 'server-only',
  };
  const outcome = await runChild(planFor(rig, { layout }), { signal: noAbort().signal, env });
  assert.equal(outcome.exitCode, 0);

  const childEnvDump = readText(join(rig.markerDir, 'env'));
  assert.ok(!childEnvDump.includes('QUOTIENT_'), 'no QUOTIENT_* variable reaches the child');
  assert.ok(!childEnvDump.includes(rig.runDir), 'no variable names the run directory');
  assert.ok(!childEnvDump.includes(layout.dir), 'no variable names the run\'s evidence directory');
  assert.ok(!childEnvDump.includes('LEAK_'), 'the variables that named the evidence are dropped');
  assert.ok(childEnvDump.includes('LLM_GATEWAY_KEY=gateway-token'), 'provider configuration survives');
  assert.ok(/^PATH=/m.test(childEnvDump), 'PATH survives: the launch closure needs it');

  const argv = readText(join(rig.markerDir, 'argv'));
  assert.ok(!argv.includes(rig.runDir));
  assert.ok(!argv.includes(layout.dir));

  // The server's own handles stay out of the child's table: three pipes and
  // nothing pointing at the run's evidence.
  const fds = readText(join(rig.markerDir, 'fds'));
  assert.ok(!fds.includes(rig.runDir));
  for (const fd of ['0', '1', '2']) {
    assert.match(fds, new RegExp(`^${fd} -> (pipe|socket):`, 'm'), `fd ${fd} is one of the three pipes`);
  }

  assert.equal(realpathSync(markerText(rig, 'cwd')), realpathSync(rig.root), 'cwd is the call\'s root');

  // The derivation itself, so the rule is not only observed through a stub.
  const derived = childEnv(env, rig.runDir, layout);
  assert.equal(derived.QUOTIENT_RUN_DIR, undefined);
  assert.equal(derived.LEAK_RUN_DIR, undefined);
  assert.equal(derived.LEAK_EVIDENCE_FILE, undefined);
  assert.equal(derived.LLM_GATEWAY_KEY, 'gateway-token');
});

test('an audit append that fails after the child was launched fails the call closed: audit_failed, with the captured evidence intact', async (t) => {
  const rig = newRig(t, {
    read: [
      'printf \'%s\\n\' $$ > "@MARKER@/pid"',
      'sleep 0.4',
      answer('stop', 'done'),
      SETTLED,
      'exit 0',
    ].join('\n'),
  });
  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(11, { prompt: 'work', profile: 'read', cwd: rig.root }));

  // The audit is broken after the `spawn` record landed and before the `exit`
  // record: a run whose audit cannot be appended must not be answered as a clean
  // success (design sec-6's failure policy).
  const auditPath = join(await waitForRunDir(rig.runDir), 'audit.jsonl');
  await waitForPath(auditPath, 'the run audit');
  rmSync(auditPath);
  mkdirSync(auditPath);
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');

  const [reply] = await waitForReplies(server, 1);
  server.end();
  await server.done;

  const doc = resultDocument(reply);
  assert.equal(doc.state, 'audit_failed', JSON.stringify(doc));
  assert.equal(doc.termination, 'audit');
  assert.deepEqual(doc.causes, ['audit']);
  assert.equal(reply.result.isError, true);
  assert.equal(doc.final, false, 'a run that cannot be evidenced is never a success');

  // The surviving evidence: the stream the child produced, the transcript and the
  // status all exist, even though the audit append failed.
  const events = readFileSync(doc.artifacts.events, 'utf8');
  assert.ok(events.includes('"agent_settled"'));
  assert.ok(readFileSync(doc.artifacts.transcript, 'utf8').includes('done'));
  assert.ok(existsSync(doc.artifacts.status));
});

test('an audit record that cannot be written never blocks the ladder: the child is still killed and the failure joins the causes', async (t) => {
  const rig = newRig(t, { read: ['printf \'%s\\n\' $$ > "@MARKER@/pid"', 'trap \'\' TERM', 'sleep 60'].join('\n') });
  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(16, { prompt: 'work', profile: 'read', cwd: rig.root }));
  const auditPath = join(await waitForRunDir(rig.runDir), 'audit.jsonl');
  await waitForPath(auditPath, 'the run audit');
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');
  const [pid] = markerPids(rig);

  // The `abort` record now cannot be appended. The kill must not wait on the
  // audit: the run is cancelled and the failed append is a second cause, never a
  // silently dropped one (design sec-5's precedence).
  rmSync(auditPath);
  mkdirSync(auditPath);
  server.write(line({ method: 'notifications/cancelled', params: { requestId: 16 } }));
  const doc = await waitForResult(rig.runDir, runOf(rig.runDir, 16));
  server.end();
  await server.done;

  assert.deepEqual(server.replies(), [], 'the cancelled call got no reply: its outcome is its result.json');
  assert.equal(doc.state, 'cancelled');
  assert.equal(doc.termination, 'cancelled');
  assert.deepEqual(doc.causes, ['cancelled', 'audit']);
  assert.equal(isAlive(pid), false, 'the ladder ran anyway');
});

// ── EX-6 / VT-5: the failure policy ────────────────────────────────────────

const LAUNCH_MARKER = `printf '%s\\n' $$ > "@MARKER@/launched"\n${SETTLED}\nexit 0`;

test('an unwritable attempts.jsonl refuses audit-unavailable without spawning anything', async (t) => {
  const rig = newRig(t, { read: LAUNCH_MARKER });
  // The ledger path is a directory, so the server can append nothing to it — and
  // a server that cannot record a run must not launch one.
  mkdirSync(join(rig.runDir, 'attempts.jsonl'), { recursive: true });

  const server = serveRig(rig);
  server.write(callLine(12, { prompt: 'work', profile: 'read', cwd: rig.root }));
  const [reply] = await waitForReplies(server, 1);
  server.end();
  await server.done;

  const doc = resultDocument(reply);
  assert.equal(doc.state, 'refused');
  assert.equal(doc.refusal.reason, 'audit-unavailable');
  assert.match(String(doc.refusal.detail), /attempts\.jsonl/);
  assert.equal(existsSync(join(rig.markerDir, 'launched')), false, 'nothing was spawned');
  assert.deepEqual(readdirSync(rig.runDir), ['attempts.jsonl'], 'no run directory was allocated');
});

test('a publish failure (the run directory cannot be made) refuses audit-failed, leaves no run directory and records audit-failed in attempts.jsonl', async (t) => {
  const rig = newRig(t, { read: LAUNCH_MARKER });
  // The ledger stays writable (so the probe passes) while the run dir cannot gain
  // a child directory: publication, the run's `admitted` record, is what fails.
  mkdirSync(rig.runDir, { recursive: true });
  writeFileSync(join(rig.runDir, 'attempts.jsonl'), '');
  chmodSync(rig.runDir, 0o555);
  t.after(() => {
    try {
      chmodSync(rig.runDir, 0o755);
    } catch {
      // already removed by the tree's own teardown
    }
  });

  const server = serveRig(rig);
  server.write(callLine(13, { prompt: 'work', profile: 'read', cwd: rig.root }));
  const [reply] = await waitForReplies(server, 1);
  server.end();
  await server.done;
  chmodSync(rig.runDir, 0o755);

  const doc = resultDocument(reply);
  assert.equal(doc.state, 'refused');
  assert.equal(doc.refusal.reason, 'audit-failed');
  assert.equal(doc.artifacts, null, 'nothing ran, so there is no run to point at');
  assert.equal(existsSync(join(rig.markerDir, 'launched')), false, 'nothing was spawned');
  assert.deepEqual(readdirSync(rig.runDir), ['attempts.jsonl'], 'no run directory survived');

  // The refusal itself is recorded in the ledger that is still writable.
  const attempts = jsonLines(join(rig.runDir, 'attempts.jsonl'));
  assert.deepEqual(
    attempts.map((attempt) => attempt.reason),
    ['audit-failed'],
  );
  assert.equal(attempts[0].call_id, 13);
});

test('a spawn record that cannot be written keeps the run directory, and nothing is launched', async (t) => {
  const rig = newRig(t, { read: LAUNCH_MARKER });
  // The directory is there and cannot take the `spawn` record: nothing ran, but a
  // published run's directory is never deleted (design sec-3's publication line).
  const layout: RunLayout = runLayout(rig.runDir, 1);
  mkdirSync(layout.dir, { recursive: true });
  chmodSync(layout.dir, 0o555);

  const outcome = await runChild(planFor(rig, { layout }), { signal: noAbort().signal, env: rig.env });
  assert.equal(outcome.auditFailedBeforeSpawn, true);
  assert.equal(outcome.auditFailed, true);
  assert.equal(outcome.spawnFailed, false);
  assert.equal(outcome.exitCode, null);
  assert.equal(existsSync(layout.dir), true, 'the run directory stays');
  assert.equal(existsSync(join(rig.markerDir, 'launched')), false, 'nothing was launched');
});

/** What the run reads of the server, for a run driven without `serve`. */
const executeDeps = (rig: Rig): ExecuteDeps => ({
  env: rig.env,
  graceMs: 200,
  gateIdleMs: 20,
  diagnostics: new PassThrough(),
  profileDigest: 'b'.repeat(64),
  helpDigest: 'c'.repeat(64),
});

test('a spawn record that fails after publication keeps the run directory and settles an audit-failed refusal into result.json', async (t) => {
  const rig = newRig(t, { read: LAUNCH_MARKER });
  // The server's launch (C1), with the audit made read-only between publication
  // and the spawn record: the `admitted` record stays readable, and the `spawn`
  // record is the append that fails, so `runChild` reports auditFailedBeforeSpawn.
  const registry = createRegistry({
    diagnostics: new PassThrough(),
    launch: (record, admitted, _queued, onAudit) => {
      chmodSync(record.layout.audit, 0o444);
      t.after(() => {
        if (existsSync(record.layout.audit)) {chmodSync(record.layout.audit, 0o644);}
      });
      return executeRun(admitted, record.layout, record.controller, onAudit, executeDeps(rig)).then((result) => ({ result }));
    },
  });
  const started = registry.start({ ...DEFAULT_START, origin: 'blocking', admitted: admittedCall(rig, 17) });
  if (!started.ok) {assert.fail(`start refused: ${started.reason}: ${started.detail}`);}
  const { record } = started;
  const document = await started.document;
  await record.settled;

  assert.equal(existsSync(record.layout.dir), true, 'a published run directory is never deleted');
  assert.equal(existsSync(join(rig.markerDir, 'launched')), false, 'nothing was launched');
  assert.deepEqual(auditKinds(record.layout), ['admitted'], 'the spawn record was never written');
  assert.equal(record.state, 'settled');

  // The refusal is the run's settlement: result.json holds what the call answers.
  const settled = resultJson(rig.runDir, record.run);
  assert.ok(settled !== null, 'the run settled into its result.json');
  assert.deepEqual(settled, document, 'the call answers the document its result.json holds');
  assert.equal(document.state, 'refused');
  assert.equal(document.refusal?.reason, 'audit-failed');
  assert.doesNotMatch(document.refusal.detail, /discard/);

  const ledger = attempts(rig.runDir);
  assert.deepEqual(ledger.map((attempt): unknown => attempt.reason), ['audit-failed']);
  assert.equal(ledger[0].call_id, 17);
  assert.doesNotMatch(String(ledger[0].detail), /discard/, 'no detail says the directory was discarded');
});

test('a pre-exec spawn failure after the run directory exists reports failed with termination spawn', async (t) => {
  const rig = newRig(t, { read: LAUNCH_MARKER });
  patchPolicy(rig, 'forms', { read: join(rig.dir, 'no-such-launcher'), write: rig.writeLauncher });

  const server = serveRig(rig);
  server.write(callLine(14, { prompt: 'work', profile: 'read', cwd: rig.root }));
  const [reply] = await waitForReplies(server, 1);
  server.end();
  await server.done;

  const doc = resultDocument(reply);
  assert.equal(doc.state, 'failed');
  assert.equal(doc.termination, 'spawn');
  assert.deepEqual(doc.causes, ['spawn']);
  assert.equal(doc.final, false);
  assert.ok(doc.session, 'the session was minted before the spawn');
  // The run directory exists — step 8 passed — and its audit says what happened.
  const records = jsonLines(join(onlyRunDir(rig.runDir), 'audit.jsonl'));
  assert.deepEqual(
    records.map((record) => record.record),
    ['admitted', 'spawn', 'exit'],
  );
  assert.equal(records[2].spawn_failed, true);
  assert.equal(records[2].code, null);
});

// ── EX-7: the facts are reported, not interpreted ──────────────────────────

const stream = (stop: string): string[] => [answer(stop), SETTLED];

test('completed requires settled + exit 0 + an answering reason + known accounting; a nonzero exit is never success', async (t) => {
  const cases: {
    name: string;
    stop: string;
    exit: number;
    state: string;
    termination: string;
    stream: string;
  }[] = [
    { name: 'settled, exit 0, stop', stop: 'stop', exit: 0, state: 'completed', termination: 'stop', stream: 'completed' },
    { name: 'settled, stop, exit 3', stop: 'stop', exit: 3, state: 'failed', termination: 'exit', stream: 'completed' },
    { name: 'settled, exit 0, stopReason error', stop: 'error', exit: 0, state: 'failed', termination: 'error', stream: 'failed' },
    {
      name: 'settled, exit 0, stopReason toolUse (counted, not an answer)',
      stop: 'toolUse',
      exit: 0,
      state: 'incomplete',
      termination: 'toolUse',
      stream: 'completed',
    },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async (inner) => {
      const rig = newRig(inner, {
        read: [...stream(testCase.stop), `exit ${testCase.exit}`].join('\n'),
      });
      const server = serveRig(rig);
      server.write(callLine(15, { prompt: 'work', profile: 'read', cwd: rig.root }));
      const [reply] = await waitForReplies(server, 1);
      server.end();
      await server.done;
      const doc = resultDocument(reply);
      assert.equal(doc.state, testCase.state, JSON.stringify(doc));
      assert.equal(doc.termination, testCase.termination);
      assert.equal(doc.final, testCase.state === 'completed');
      assert.equal(doc.result, testCase.state === 'completed' ? 'the answer' : null);
      // `status.state` is the reducer's verdict on the STREAM; `state` is the
      // server's verdict on the CALL. They differ where a cause outside the stream
      // decided it (the exit status here) and where the stream came to rest without
      // an answer (the toolUse row), and `causes` names which (design sec-5).
      assert.equal(doc.status.state, testCase.stream);
    });
  }
});

// ── EX-4: ordering — result and release last ───────────────────────────────

test('the session lock is released only after the drain and the final audit append: another process is refused session-busy while a grandchild holds stdout, and the ladder is what ends the drain', async (t) => {
  const rig = newRig(t, {
    read: [
      'printf \'%s\\n\' $$ >> "@MARKER@/pids"',
      'if [ -z "${FAST:-}" ]; then',
      // A grandchild keeps the stdout pipe open past the child's own exit, so the
      // drain (and the lock) outlive the child by as long as it chooses to sleep.
      '  sleep 30 &',
      '  printf \'%s\\n\' $! > "@MARKER@/grandchild.pid"',
      'fi',
      'printf \'%s\\n\' done > "@MARKER@/child-done"',
      answer('stop', 'drained'),
      SETTLED,
      'exit 0',
    ].join('\n'),
  });
  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(21, { prompt: 'slow drain', profile: 'read', cwd: rig.root, session: 'drain' }));
  await waitForPath(join(rig.markerDir, 'child-done'), 'the child to exit');
  assert.equal(server.replies().length, 0, 'the answer waits for the drain, not for the exit');
  const [grandchildPid] = markerPids(rig, 'grandchild.pid');
  assert.ok(isAlive(grandchildPid), 'the grandchild is what holds the pipe open');

  const rival = async (extra: Env = {}): Promise<Record<string, any>> =>
    resultDocument(await oneShot(t, rig, callLine(31, { prompt: 'same session', profile: 'read', cwd: rig.root, session: 'drain' }), extra));

  const busy = await rival();
  assert.equal(busy.state, 'refused');
  assert.equal(busy.refusal.reason, 'session-busy', 'cleanup has not finished, so the lock is still held');
  assert.equal(readFileSync(join(rig.markerDir, 'pids'), 'utf8').trim().split('\n').length, 1, 'no second child was created');

  // Nothing has triggered the run, so the drain has no bound and the answer is
  // still owed. The ladder is what ends it: the cancellation kills the group the
  // grandchild is in, so the run settles in the grace rather than in 30 seconds.
  const cancelledAt = Date.now();
  server.write(line({ method: 'notifications/cancelled', params: { requestId: 21 } }));
  const settled = await waitForResult(rig.runDir, runOf(rig.runDir, 21), 5000);
  const elapsed = Date.now() - cancelledAt;
  server.end();
  await server.done;
  assert.deepEqual(server.replies(), [], 'the cancelled call got no reply: its outcome is its result.json');
  assert.equal(settled.state, 'cancelled');
  assert.ok(elapsed < 2000, `the ladder bounded the drain: ${elapsed} ms`);
  assert.equal(isAlive(grandchildPid), false, 'the drain was not outlived by the member holding the pipe');
  // The final audit append is the `exit` record, written after the drain.
  const records = jsonLines(join(onlyRunDir(rig.runDir), 'audit.jsonl'));
  assert.deepEqual(
    records.map((record) => record.record),
    ['admitted', 'spawn', 'abort', 'exit'],
  );

  // Only after that cleanup does the next call get through.
  const later = await rival({ FAST: '1' });
  assert.equal(later.state, 'completed', JSON.stringify(later));
  assert.equal(readFileSync(join(rig.markerDir, 'pids'), 'utf8').trim().split('\n').length, 2);
});

// ── EX-9: no child on the losing side of a session ─────────────────────────

test('two server processes on one session: the loser is refused session-busy and its stub launcher never runs', async (t) => {
  const rig = newRig(t, {
    read: [`printf '%s\\n' $$ >> "@MARKER@/pids"`, 'sleep 1.2', answer('stop'), SETTLED, 'exit 0'].join('\n'),
  });
  const winner = spawnProcess(...serverCommand, { cwd: rig.launchDir, env: rig.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => winner.kill('SIGKILL'));
  const winnerOut: string[] = [];
  winner.stdout.setEncoding('utf8');
  winner.stdout.on('data', (chunk: string) => winnerOut.push(chunk));
  const exited = new Promise<number | null>((resolve) => winner.on('exit', (code) => { resolve(code); }));
  winner.stdin.write(`${callLine(41, { prompt: 'winner', profile: 'read', cwd: rig.root, session: 'shared' })}\n`);

  await waitForPath(join(rig.markerDir, 'pids'), 'the winner\'s child');
  const loserDoc = resultDocument(await oneShot(t, rig, callLine(42, { prompt: 'loser', profile: 'read', cwd: rig.root, session: 'shared' })));
  assert.equal(loserDoc.state, 'refused');
  assert.equal(loserDoc.refusal.reason, 'session-busy');
  assert.equal(readFileSync(join(rig.markerDir, 'pids'), 'utf8').trim().split('\n').length, 1, 'the loser created no child');

  // The winner's channel stays open until its own run answers: closing it first
  // would abort the very run this test is about.
  const deadline = Date.now() + 20000;
  while (!winnerOut.join('').includes('\n')) {
    if (Date.now() > deadline) {throw new Error('the winner never answered');}
    await pause(5);
  }
  winner.stdin.end();
  assert.equal(await exited, 0);
  const winnerDoc = resultDocument(JSON.parse(winnerOut.join('').trim()) as Record<string, any>);
  assert.equal(winnerDoc.state, 'completed', JSON.stringify(winnerDoc));
});

// ── EX-10 / EX-11 / VT-7: the two triggers, one ladder ─────────────────────

test('notifications/cancelled aborts exactly the requestId it names; an unknown requestId is ignored and is not a protocol error', async (t) => {
  const rig = newRig(t, { read: ['printf \'%s\\n\' $$ > "@MARKER@/pid"', 'trap \'\' TERM', 'sleep 60'].join('\n') });
  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(51, { prompt: 'cancel me', profile: 'read', cwd: rig.root, session: 'victim' }));
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');
  const [pid] = markerPids(rig);

  // An id that names no in-flight call aborts nothing and answers nothing.
  server.write(line({ method: 'notifications/cancelled', params: { requestId: 999 } }));
  server.write(line({ id: 52, method: 'ping' }));
  const first = await waitForReplies(server, 1);
  assert.equal(first[0].id, 52, 'the unknown cancellation produced no frame of its own');
  assert.deepEqual(first[0].result, { pong: true });

  server.write(line({ method: 'notifications/cancelled', params: { requestId: 51 } }));
  const cancelled = await waitForResult(rig.runDir, runOf(rig.runDir, 51));
  server.write(line({ id: 53, method: 'ping' }));
  await waitForReplies(server, 2);
  server.end();
  await server.done;

  const replies = server.replies();
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.termination, 'cancelled');
  assert.deepEqual(cancelled.causes, ['cancelled']);
  assert.deepEqual(replies.map((reply): unknown => reply.id), [52, 53], 'the cancelled call got no reply: its outcome is its result.json');
  assert.ok(!replies.some((reply) => reply.error !== undefined), 'a cancellation is never a JSON-RPC error');
  assert.equal(isAlive(pid), false, 'the cancelled call left no child behind');

  const records = jsonLines(join(onlyRunDir(rig.runDir), 'audit.jsonl'));
  assert.equal(records.find((record) => record.record === 'abort')?.cause, 'cancelled');
  assert.equal(records.at(-1)?.record, 'exit');
});

test('a cancellation arriving after the leader was reaped still bounds the drain: the group that holds stdout is killed, so the run settles instead of waiting on a grandchild', async (t) => {
  const rig = newRig(t, {
    read: [
      'printf \'%s\\n\' $$ > "@MARKER@/pid"',
      // The leader ends itself with its stream written; the grandchild, alone in the
      // group now, keeps the stdout pipe open past the leader's exit.
      'sleep 30 &',
      'printf \'%s\\n\' $! > "@MARKER@/grandchild.pid"',
      answer('stop', 'tail'),
      SETTLED,
      'printf \'%s\\n\' done > "@MARKER@/leader-exited"',
      'exit 0',
    ].join('\n'),
  });
  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(53, { prompt: 'the tail is held open', profile: 'read', cwd: rig.root, session: 'tail' }));
  await waitForPath(join(rig.markerDir, 'leader-exited'), 'the leader to exit');
  const [grandchildPid] = markerPids(rig, 'grandchild.pid');
  assert.ok(isAlive(grandchildPid), 'the grandchild holds the pipe while the leader is already reaped');
  assert.equal(server.replies().length, 0, 'the answer waits for the drain');

  // The trigger arrives with no leader left to TERM. The group is still there, and
  // the drain is bounded by the ladder rather than by the grandchild, so the answer
  // arrives within the grace however long the grandchild would have slept.
  const abortedAt = Date.now();
  server.write(line({ method: 'notifications/cancelled', params: { requestId: 53 } }));
  const doc = await waitForResult(rig.runDir, runOf(rig.runDir, 53), 5000);
  const elapsed = Date.now() - abortedAt;
  server.end();
  await server.done;

  assert.ok(elapsed < 2000, `the settlement waits for the bounded drain, not for the grandchild: ${String(elapsed)} ms`);
  assert.deepEqual(server.replies(), [], 'the cancelled call got no reply: its outcome is its result.json');
  assert.equal(doc.state, 'cancelled', JSON.stringify(doc));
  assert.equal(doc.termination, 'cancelled');
  assert.deepEqual(doc.causes, ['cancelled']);

  const records = jsonLines(join(onlyRunDir(rig.runDir), 'audit.jsonl'));
  assert.deepEqual(
    records.map((record) => record.record),
    ['admitted', 'spawn', 'abort', 'exit'],
  );
  assert.equal(records[2].cause, 'cancelled');
  assert.equal(isAlive(grandchildPid), false, 'the group signal reached the member holding the pipe: no child is left behind');
});

test('two tools/calls carrying one id are both in the index: a cancellation naming it aborts both, and each run records its abort', async (t) => {
  const rig = newRig(t, { read: ['printf \'%s\\n\' $$ >> "@MARKER@/pids"', 'trap \'\' TERM', 'sleep 60'].join('\n') });
  const server = serveRig(rig, { graceMs: 200 });
  // The same wire id twice: the id is the client's, and neither call may drop out of
  // the index the cancellation and the EOF sweep read.
  server.write(callLine(71, { prompt: 'first', profile: 'read', cwd: rig.root, session: 'dupe-one' }));
  server.write(callLine(71, { prompt: 'second', profile: 'read', cwd: rig.root, session: 'dupe-two' }));
  const started = Date.now() + 10000;
  while (markerPids(rig, 'pids').length < 2) {
    if (Date.now() > started) {throw new Error('timed out waiting for both launchers');}
    await pause(5);
  }

  server.write(line({ method: 'notifications/cancelled', params: { requestId: 71 } }));
  const settled = await Promise.all(runDirs(rig.runDir).map((run) => waitForResult(rig.runDir, run)));
  server.write(line({ id: 72, method: 'ping' }));
  await waitForReplies(server, 1);
  server.end();
  await server.done;

  assert.deepEqual(server.replies().map((reply): unknown => reply.id), [72], 'neither cancelled call got a reply');
  assert.equal(settled.length, 2);
  for (const doc of settled) {
    assert.equal(doc.state, 'cancelled', JSON.stringify(doc));
    assert.deepEqual(doc.causes, ['cancelled']);
  }
  for (const pid of markerPids(rig, 'pids')) {assert.equal(isAlive(pid), false, 'both cancelled children are gone');}

  // Two calls, two run directories, each with its own abort record: the first
  // call's cleanup did not remove the second from the index and vice versa.
  const audits = runDirs(rig.runDir).map((name) => jsonLines(join(rig.runDir, name, 'audit.jsonl')));
  assert.equal(audits.length, 2);
  for (const records of audits) {assert.equal(records.find((record) => record.record === 'abort')?.cause, 'cancelled');}
});

test('stdin EOF aborts every in-flight run through the same ladder, writes no reply and leaves no child behind', async (t) => {
  const rig = newRig(t, { read: ['printf \'%s\\n\' $$ > "@MARKER@/pid"', 'trap \'\' TERM', 'sleep 60'].join('\n') });
  const server = serveRig(rig, { graceMs: 200 });
  server.write(callLine(61, { prompt: 'work', profile: 'read', cwd: rig.root, session: 'eof' }));
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher');
  const [pid] = markerPids(rig);

  // The client is gone: the server stops admitting, aborts in flight, flushes the
  // audit and exits. Nothing is written down the closed channel.
  server.end();
  await server.done;

  assert.deepEqual(server.replies(), [], 'no result is written after stdin EOF');
  assert.equal(isAlive(pid), false, 'the run was aborted, not left behind');
  const records = jsonLines(join(onlyRunDir(rig.runDir), 'audit.jsonl'));
  assert.deepEqual(
    records.map((record) => record.record),
    ['admitted', 'spawn', 'abort', 'exit'],
  );
  assert.equal(records[2].cause, 'eof');
  assert.equal(records.at(-1)?.signal, 'SIGKILL');
  // The run still settled: a later server reads it settled, not lost (sec-6).
  const settled = resultJson(rig.runDir, basename(onlyRunDir(rig.runDir)));
  assert.ok(settled !== null, 'the aborted run settled into its result.json');
  assert.equal(settled.state, 'incomplete', JSON.stringify(settled));
  assert.deepEqual(settled.causes, ['eof']);
});

// ── the audit hook and malformed stream lines (design sec-7) ───────────────

test('onAudit sees the ts of every audit record the run appends, in order', async (t) => {
  const rig = newRig(t, { read: [answer('end'), SETTLED, 'exit 0'].join('\n') });
  const seen: string[] = [];
  const outcome = await runChild(planFor(rig), {
    signal: noAbort().signal,
    env: rig.env,
    onAudit: (ts) => { seen.push(ts); },
  });

  const written = jsonLines(outcome.layout.audit).map((record) => String(record.ts));
  assert.ok(seen.length >= 2, `at least the spawn and exit records fire it, saw ${String(seen.length)}`);
  assert.deepEqual(seen, written, 'every appended record, once, in the order it was written');
});

test('non-object stream lines (null among them) are malformed, never records, and do not crash the run', async (t) => {
  const junk = [
    "printf '%s\\n' 'null'",
    "printf '%s\\n' 'true'",
    "printf '%s\\n' '42'",
    `printf '%s\\n' '"x"'`,
    "printf '%s\\n' '[]'",
  ];
  const rig = newRig(t, {
    read: [emit({ type: 'message_start', message: { role: 'assistant' } }), ...junk, answer('end'), SETTLED, 'exit 0'].join('\n'),
  });
  const live: { tally: Tally | null } = { tally: null };
  const outcome = await runChild(planFor(rig), {
    signal: noAbort().signal,
    env: rig.env,
    onRecord: (tally) => { live.tally = tally; },
  });

  // The junk rode the stream: it is in `lines`, and the run still ended itself.
  assert.deepEqual(outcome.lines.slice(1, 6), ['null', 'true', '42', '"x"', '[]']);
  assert.equal(outcome.settled, true);
  assert.equal(outcome.exitCode, 0);

  const reduced = reduce(outcome.lines);
  assert.equal(reduced.status.transcript.malformed, 5);
  assert.equal(reduced.status.transcript.records, 3, 'the three real events, the junk excluded');
  assert.notEqual(live.tally, null, 'the observer saw at least one record');
  assert.equal(live.tally?.requests, reduced.status.requests, 'the live tally and the reduction agree');
});

test('a record whose handling throws is skipped and reported, and the run still ends itself', async (t) => {
  const rig = newRig(t, { read: [answer('end'), SETTLED, 'exit 0'].join('\n') });
  let calls = 0;
  const outcome = await runChild(planFor(rig), {
    signal: noAbort().signal,
    env: rig.env,
    // The first call is the fresh tally, before any child output; every later
    // one handles a record from the stream.
    onRecord: () => {
      calls += 1;
      if (calls > 1) {throw new Error('the reader failed');}
    },
  });

  assert.ok(calls > 2, `the reader threw on each stream record, called ${String(calls)} times`);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.abort, null, 'nothing aborted the run');
  assert.equal(outcome.settled, true, 'a later record was still observed: the run settled');
  assert.equal(outcome.lines.length, 2, 'every line still reached the record list');
});

test('onAudit also sees the abort record of a cancelled run', async (t) => {
  const rig = newRig(t, { read: ['printf \'%s\\n\' $$ > "@MARKER@/pid"', 'sleep 60'].join('\n') });
  const controller = noAbort();
  const seen: string[] = [];
  const running = runChild(planFor(rig), { signal: controller.signal, env: rig.env, onAudit: (ts) => { seen.push(ts); } });
  await waitForPath(join(rig.markerDir, 'pid'), 'the launcher pid');
  controller.abort('cancelled');
  const outcome = await running;

  const records = jsonLines(outcome.layout.audit);
  assert.deepEqual(records.map((record) => String(record.record)), ['spawn', 'abort', 'exit']);
  assert.deepEqual(seen, records.map((record) => String(record.ts)));
});
