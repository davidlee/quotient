// Behaviour tests for pi-run-reduce. The reducer is the contract: the CLI, the
// shell wrappers and (later) the MCP server all report through it, so these
// assert the rendering rules and the status derivation, not the internals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduce } from './reduce.ts';
import type { Reduced } from './reduce.ts';

const cli = new URL('./cli.ts', import.meta.url).pathname;

const ev = (type: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ type, ...extra });

const assistant = (content: unknown[], stopReason = 'stop', usage?: unknown): string =>
  ev('message_end', { message: { role: 'assistant', content, stopReason, model: 'test-model', usage } });

const call = (name: string, args: Record<string, unknown>): string[] => [
  ev('tool_execution_start', { toolCallId: `c-${name}-${JSON.stringify(args)}`, toolName: name, args }),
];

const result = (text: string, extra: Record<string, unknown> = {}): string =>
  ev('tool_execution_end', {
    toolCallId: 'c',
    toolName: 'bash',
    result: { content: [{ type: 'text', text }], structuredContent: { exit_code: 0 } },
    isError: false,
    ...extra,
  });

/** A minimal run: context echo, a tool round trip, then an answer. */
const run = (...middle: string[]): string[] => [
  ev('session', { version: 3, id: 'sess-1', cwd: '/repo' }),
  ev('agent_start'),
  ev('turn_start'),
  ev('message_end', { message: { role: 'system', content: 'SYSTEM PROMPT ECHO' } }),
  ev('message_end', { message: { role: 'user', content: 'USER PROMPT ECHO' } }),
  ...middle,
  ev('agent_settled'),
];

const reduceLines = (lines: string[], budgetBytes = 8192, alerts: string[] = []): Reduced =>
  reduce(lines, { budgetBytes, alerts });

test('renders prose verbatim, tool calls as one line, results as their first line', () => {
  const { transcript, status } = reduceLines(
    run(
      assistant([{ type: 'text', text: 'Looking at the tree.' }], 'toolUse'),
      ...call('bash', { command: 'ls -la' }),
      result('total 2\ndrwxr-xr-x 1 david users\n'),
      assistant([{ type: 'text', text: 'Two entries.' }]),
    ),
  );
  assert.match(transcript, /^Looking at the tree\.$/m);
  assert.match(transcript, /^→ bash\(ls -la\)$/m);
  assert.match(transcript, /^ {2}↳ total 2$/m);
  assert.match(transcript, /^## Result\nTwo entries\.$/m);
  assert.equal(status.state, 'completed');
  assert.equal(status.tool_calls, 1);
  assert.equal(status.turns, 2);
});

test('drops context echo and thinking, which are most of the raw stream', () => {
  const { transcript } = reduceLines(
    run(
      assistant([
        { type: 'thinking', thinking: 'SECRET DELIBERATION' },
        { type: 'text', text: 'Done.' },
      ]),
    ),
  );
  assert.doesNotMatch(transcript, /SYSTEM PROMPT ECHO|USER PROMPT ECHO|SECRET DELIBERATION/);
});

test('collapses identical repeated activity, but not differing output', () => {
  const cmd = { command: 'grep -r x .' };
  const { transcript } = reduceLines(
    run(
      ...call('bash', cmd),
      result('same output'),
      ...call('bash', cmd),
      result('same output'),
      ...call('bash', cmd),
      result('different output'),
      assistant([{ type: 'text', text: 'ok' }]),
    ),
  );
  assert.match(transcript, /^→ bash\(grep -r x \.\) ×2$/m);
  // The count belongs to the action; the identical output is shown once.
  assert.equal(transcript.match(/^ {2}↳ same output$/gm)?.length, 1);
  // A retry whose output changed is information: it stays visible.
  assert.match(transcript, /^ {2}↳ different output$/m);
});

test('marks failed tool results and non-zero exits', () => {
  const { transcript } = reduceLines(
    run(
      result('boom: no such file', { isError: true }),
      result('partial output', { result: { content: [{ type: 'text', text: 'partial output' }], structuredContent: { exit_code: 2 } } }),
      assistant([{ type: 'text', text: 'gave up' }]),
    ),
  );
  assert.match(transcript, /^ {2}✗ boom: no such file$/m);
  assert.match(transcript, /^ {2}↳ \[exit 2\] partial output$/m);
});

test('alerts match untruncated text, beyond the rendered snippet', () => {
  const buried = `${'x'.repeat(400)} FORBIDDEN-PATH`;
  const { status } = reduceLines(run(result(buried), assistant([{ type: 'text', text: 'ok' }])), 8192, ['forbidden-path']);
  assert.equal(status.alerts.length, 1);
  assert.equal(status.alerts[0].pattern, 'forbidden-path');
  // The rendered line is clipped; the alert still fires on the full text.
  assert.match(status.alerts[0].text, /FORBIDDEN-PATH$/);
});

test('budget is enforced, elided from the middle, and never eats the result', () => {
  const middle: string[] = [];
  for (let i = 0; i < 100; i++) {
    middle.push(...call('bash', { command: `step ${i} --with-a-reasonably-long-argument` }), result(`output of step ${i}`));
  }
  middle.push(assistant([{ type: 'text', text: 'FINISHED' }]));
  const budget = 600;
  const { transcript, status } = reduceLines(run(...middle), budget);

  assert.ok(Buffer.byteLength(transcript) <= budget, `transcript is ${Buffer.byteLength(transcript)} bytes`);
  assert.match(transcript, /entries elided/);
  assert.match(transcript, /^## Result\nFINISHED$/m);
  assert.ok(status.transcript.elided > 0);
  // The opening move survives: elision is middle-out, not tail-drop.
  assert.match(transcript, /step 0 /);
});

test('a budget too small for the mandatory sections reports honestly instead of lying', () => {
  const { transcript, status } = reduceLines(run(assistant([{ type: 'text', text: 'x'.repeat(2000) }])), 100);
  assert.ok(status.transcript.bytes > 100);
  assert.equal(status.transcript.bytes, Buffer.byteLength(transcript));
  assert.match(transcript, /^## Result\nx+$/m);
});

test('state: failed on an error stop reason, even when settled', () => {
  const { status } = reduceLines(run(assistant([{ type: 'text', text: 'nope' }], 'error')));
  assert.equal(status.state, 'failed');
});

test('state: incomplete when the stream stops without agent_settled', () => {
  const lines = run(assistant([{ type: 'text', text: 'partial' }])).filter((line) => !line.includes('agent_settled'));
  const { status } = reduceLines(lines);
  assert.equal(status.state, 'incomplete');
});

test('tokens and cost accumulate across turns, once', () => {
  const usage = { input: 100, output: 10, cacheRead: 40, cost: { total: 0.002 } };
  const { status } = reduceLines(
    run(
      assistant([{ type: 'text', text: 'a' }], 'toolUse', usage),
      ...call('bash', { command: 'true' }),
      result(''), // agent_end replays the last message; it must not double-count
      assistant([{ type: 'text', text: 'b' }], 'stop', usage),
      ev('agent_end', { messages: [{ role: 'assistant', model: 'test-model', usage }], willRetry: false }),
    ),
  );
  assert.deepEqual(status.tokens, { input: 200, output: 20, cached: 80 });
  assert.equal(status.cost_usd?.toFixed(4), '0.0040');
});

test('malformed lines are counted, not fatal', () => {
  const { status } = reduceLines([...run(assistant([{ type: 'text', text: 'ok' }])), 'not json at all']);
  assert.equal(status.state, 'completed');
  assert.equal(status.transcript.malformed, 1);
});

test('cli: one status line by default, exit 0 when completed', () => {
  const stdout = execFileSync('node', [cli, '--out', mkdtempSync(join(tmpdir(), 'reduce-'))], {
    input: run(assistant([{ type: 'text', text: 'ok' }])).join('\n'),
    encoding: 'utf8',
  });
  assert.equal(stdout.trim().split('\n').length, 1);
  assert.match(stdout.trim(), /^completed turns=1 tools=0 tokens=0\/0 cost=0\.0000 transcript=.*transcript\.md$/);
});

test('cli: writes transcript.md and status.json beside the input, exit 1 when failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reduce-'));
  const events = join(dir, 'events.jsonl');
  writeFileSync(events, run(assistant([{ type: 'text', text: 'broke' }], 'error')).join('\n'));

  let code = 0;
  try {
    execFileSync('node', [cli, events], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    code = (error as { status: number }).status;
  }
  assert.equal(code, 1);
  assert.match(readFileSync(join(dir, 'transcript.md'), 'utf8'), /^## Result\nbroke$/m);
  assert.equal(JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')).state, 'failed');
});

test('cli: alerts go to stderr, status line stays parseable; -q is silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reduce-'));
  const input = run(result('touched .doctrine/state/x'), assistant([{ type: 'text', text: 'ok' }])).join('\n');
  const stdout = execFileSync('node', [cli, '--out', dir, '--alert', '\\.doctrine/'], { input, encoding: 'utf8' });
  assert.match(stdout, /^completed /);
  const quiet = execFileSync('node', [cli, '--out', dir, '-q'], { input, encoding: 'utf8' });
  assert.equal(quiet, '');
});

test('cli: usage errors exit 2 and name the problem', () => {
  let code = 0;
  let stderr = '';
  try {
    execFileSync('node', [cli, '--budget-bytes', 'lots'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    code = (error as { status: number }).status;
    stderr = String((error as { stderr: string }).stderr);
  }
  assert.equal(code, 2);
  assert.match(stderr, /--budget-bytes needs a non-negative integer/);
});
