// Tests for the operator artefact (design sec-1, sec-2 steps 1-2, sec-6):
// the launch-environment contract, the policy schema, the one posture this
// build serves, the enable gate, and the attempts ledger every refusal reaches.
//
// Hermetic: each test mints its own temp tree and passes an environment object
// to `admitCall`; the ambient process environment is never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitCall, clampCeilings, createPostureState, selectForm } from './policy.ts';
import type { Admission } from './policy.ts';
import { attemptsPath, sha256Hex } from './evidence.ts';

type Env = Record<string, string | undefined>;

type Workspace = { env: Env; dir: string; policyPath: string; runDir: string };

/** A temp tree with a policy file and the three launch-env paths. */
function workspace(policy: unknown, options: { raw?: boolean } = {}): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'pi-mcp-policy-'));
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, options.raw ? String(policy) : JSON.stringify(policy, null, 2));
  const runDir = join(dir, 'run');
  return {
    env: {
      PI_MCP_POLICY: policyPath,
      PI_MCP_RUN_DIR: runDir,
      PI_MCP_SESSION_HOME: join(dir, 'sessions'),
    },
    dir,
    policyPath,
    runDir,
  };
}

/** A policy with every declared field present, per the schema in EX-6. */
function validPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function attemptLines(runDir: string): Record<string, unknown>[] {
  return readFileSync(attemptsPath(runDir), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function refuse(verdict: Admission, reason: string, detail: RegExp): void {
  if (verdict.ok) assert.fail(`expected a ${reason} refusal, got an admission`);
  assert.equal(verdict.reason, reason);
  assert.match(verdict.detail, detail);
}

// ── The launch environment is a contract (EX-10) ────────────────────────────

test('a policy declared by the launch environment is admitted', () => {
  const ws = workspace(validPolicy());
  const verdict = admitCall(ws.env, createPostureState(), 1);
  if (!verdict.ok) assert.fail(`expected admission, got ${verdict.reason}: ${verdict.detail}`);
  assert.equal(verdict.policy.mode, 'per-call');
  assert.equal(verdict.policy.roots.length, 1);
  assert.equal(verdict.digest, sha256Hex(readFileSync(ws.policyPath)));
  assert.equal(verdict.runDir, ws.runDir);
});

test('an unset PI_MCP_POLICY refuses policy-unavailable, naming the variable', () => {
  const ws = workspace(validPolicy());
  const env: Env = { ...ws.env };
  delete env.PI_MCP_POLICY;
  refuse(admitCall(env, createPostureState(), 1), 'policy-unavailable', /PI_MCP_POLICY/);
});

test('a relative PI_MCP_RUN_DIR is refused as policy-unavailable: an absolute path is required, never a cwd default', () => {
  const ws = workspace(validPolicy());
  refuse(
    admitCall({ ...ws.env, PI_MCP_RUN_DIR: 'relative/run' }, createPostureState(), 1),
    'policy-unavailable',
    /PI_MCP_RUN_DIR/,
  );
});

test('every launch-env variable must be an absolute path', () => {
  const ws = workspace(validPolicy());
  for (const name of ['PI_MCP_POLICY', 'PI_MCP_RUN_DIR', 'PI_MCP_SESSION_HOME']) {
    refuse(
      admitCall({ ...ws.env, [name]: 'relative/path' }, createPostureState(), 17),
      'policy-unavailable',
      new RegExp(name),
    );
  }
});

test('an unset PI_MCP_SESSION_HOME refuses policy-unavailable, naming the variable', () => {
  const ws = workspace(validPolicy());
  const env: Env = { ...ws.env };
  delete env.PI_MCP_SESSION_HOME;
  refuse(admitCall(env, createPostureState(), 1), 'policy-unavailable', /PI_MCP_SESSION_HOME/);
});

// ── The artefact: absent, unparsable, schema-invalid (EX-3, EX-6) ───────────

test('an absent policy file refuses policy-unavailable and records an attempt without a digest', () => {
  const ws = workspace(validPolicy());
  const env: Env = { ...ws.env, PI_MCP_POLICY: join(ws.dir, 'missing.json') };
  refuse(admitCall(env, createPostureState(), 7), 'policy-unavailable', /missing\.json/);

  const lines = attemptLines(ws.runDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'policy-unavailable');
  assert.equal(lines[0].call_id, 7);
  assert.equal('policy_digest' in lines[0], false);
});

test('an unparsable policy refuses policy-invalid and records the readable digest', () => {
  const ws = workspace('{"mode": "per-call",', { raw: true });
  refuse(admitCall(ws.env, createPostureState(), 2), 'policy-invalid', /not valid JSON/);

  const lines = attemptLines(ws.runDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'policy-invalid');
  assert.equal(lines[0].policy_digest, sha256Hex(readFileSync(ws.policyPath)));
  assert.match(String(lines[0].policy_digest), /^[0-9a-f]{64}$/);
});

test('an unknown policy key refuses policy-invalid, naming it', () => {
  const ws = workspace(validPolicy({ speed: 'fast' }));
  refuse(admitCall(ws.env, createPostureState(), 3), 'policy-invalid', /speed/);
  assert.equal(attemptLines(ws.runDir)[0].reason, 'policy-invalid');
});

test('a wrong-typed policy value refuses policy-invalid, naming the field', () => {
  const cases: [string, unknown][] = [
    ['roots', 'work/one'],
    ['profiles', 'read'],
    ['maxima', []],
    ['forms', 'pi-mcp-read'],
    ['child_binds', [7]],
    ['enabled', 'yes'],
    ['transcript_budget_bytes', 1.5],
  ];
  for (const [field, value] of cases) {
    const ws = workspace(validPolicy({ [field]: value }));
    refuse(admitCall(ws.env, createPostureState(), 4), 'policy-invalid', new RegExp(field));
  }
});

test('a policy naming a non-absolute root or form path refuses policy-invalid', () => {
  refuse(
    admitCall(workspace(validPolicy({ roots: ['relative/root'] })).env, createPostureState(), 5),
    'policy-invalid',
    /roots/,
  );
  refuse(
    admitCall(
      workspace(validPolicy({ forms: { read: 'pi-mcp-read' } })).env,
      createPostureState(),
      5,
    ),
    'policy-invalid',
    /forms\.read/,
  );
});

test('a missing required policy field refuses policy-invalid, naming it', () => {
  for (const field of ['mode', 'roots', 'profiles', 'forms', 'child_binds', 'enabled']) {
    const policy = validPolicy();
    delete policy[field];
    refuse(admitCall(workspace(policy).env, createPostureState(), 6), 'policy-invalid', new RegExp(field));
  }
});

// ── One posture: per-call only (EX-4) ───────────────────────────────────────

test('mode = static refuses posture-unsupported instead of being downgraded', () => {
  const ws = workspace(validPolicy({ mode: 'static' }));
  const verdict = admitCall(ws.env, createPostureState(), 8);
  refuse(verdict, 'posture-unsupported', /static/);
  assert.equal(attemptLines(ws.runDir)[0].reason, 'posture-unsupported');
});

test('any static-only field refuses posture-unsupported, with no field drop', () => {
  const fields: [string, unknown][] = [
    ['agent', '/nix/store/aaa/bin/pi-mcp'],
    ['root', '/work/one'],
    ['filesystem', 'read'],
    ['session_home', '/run/sessions'],
    ['run_dir', '/run'],
    ['evidence_dir', '/run/evidence'],
  ];
  for (const [field, value] of fields) {
    const ws = workspace(validPolicy({ [field]: value }));
    refuse(admitCall(ws.env, createPostureState(), 9), 'posture-unsupported', new RegExp(field));
    // Nothing was spawned, so the ledger is the only sink that can hold it.
    assert.equal(attemptLines(ws.runDir)[0].reason, 'posture-unsupported');
  }
});

test('an unrecognised mode refuses posture-unsupported: only per-call is served', () => {
  refuse(admitCall(workspace(validPolicy({ mode: 'shared' })).env, createPostureState(), 10), 'posture-unsupported', /shared/);
});

test('a mode change between calls is refused at the next call: the posture is fixed for the lifetime', () => {
  const ws = workspace(validPolicy());
  const posture = createPostureState();
  const first = admitCall(ws.env, posture, 11);
  assert.equal(first.ok, true);

  writeFileSync(ws.policyPath, JSON.stringify(validPolicy({ mode: 'static' })));
  refuse(admitCall(ws.env, posture, 12), 'posture-unsupported', /per-call|static/);
});

// ── The enable gate (EX-5) ─────────────────────────────────────────────────

test('enabled = false refuses disabled and records it in attempts.jsonl', () => {
  const ws = workspace(validPolicy({ enabled: false }));
  refuse(admitCall(ws.env, createPostureState(), 13), 'disabled', /enabled/);

  const lines = attemptLines(ws.runDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'disabled');
  assert.equal(lines[0].call_id, 13);
  assert.equal(lines[0].policy_digest, sha256Hex(readFileSync(ws.policyPath)));
});

test('a policy re-read per call sees an enable flip at the next call', () => {
  const ws = workspace(validPolicy());
  const posture = createPostureState();
  assert.equal(admitCall(ws.env, posture, 14).ok, true);

  writeFileSync(ws.policyPath, JSON.stringify(validPolicy({ enabled: false })));
  refuse(admitCall(ws.env, posture, 15), 'disabled', /enabled/);
});

// ── The forms: a capability selects its wrapper form (EX-5, EX-7) ──────────

/** A policy as `admitCall` normalised it, so the later steps see the real shape. */
function admittedPolicy(overrides: Record<string, unknown> = {}) {
  const ws = workspace(validPolicy(overrides));
  const verdict = admitCall(ws.env, createPostureState(), 1);
  if (!verdict.ok) assert.fail(`expected admission, got ${verdict.reason}: ${verdict.detail}`);
  return verdict.policy;
}

test('the profile capability selects its form; a form the policy does not declare is wrapper-unavailable', () => {
  const policy = admittedPolicy({ forms: { read: '/nix/store/aaa/bin/pi-mcp-read' } });

  const read = selectForm(policy, 'read');
  if (!read.ok) assert.fail(`expected the read form, got ${read.reason}: ${read.detail}`);
  assert.equal(read.form.path, '/nix/store/aaa/bin/pi-mcp-read');
  assert.deepEqual(read.form.extensions, [], 'the string form declares no extension');

  const write = selectForm(policy, 'write');
  if (write.ok) assert.fail('expected wrapper-unavailable for a capability with no form');
  assert.equal(write.reason, 'wrapper-unavailable');
  assert.match(write.detail, /write/);
});

test('a form may declare the extensions it passes, and nothing else', () => {
  const policy = admittedPolicy({
    forms: { read: { path: '/nix/store/aaa/bin/pi-mcp-read', extensions: ['builtin:mcp'] } },
  });
  assert.deepEqual(policy.forms.read, { path: '/nix/store/aaa/bin/pi-mcp-read', extensions: ['builtin:mcp'] });

  // A form with no declared extensions passes none, which is what EX-7 compares.
  assert.deepEqual(admittedPolicy({ forms: { read: { path: '/nix/store/aaa/bin/pi-mcp-read' } } }).forms.read, {
    path: '/nix/store/aaa/bin/pi-mcp-read',
    extensions: [],
  });

  const cases: [Record<string, unknown>, RegExp][] = [
    [{ read: { path: '/nix/store/aaa/bin/pi-mcp-read', flags: [] } }, /forms\.read\.flags/],
    [{ read: { path: 'pi-mcp-read' } }, /forms\.read\.path/],
    [{ read: { path: '/nix/store/aaa/bin/pi-mcp-read', extensions: [7] } }, /forms\.read\.extensions/],
    [{ read: { path: '/nix/store/aaa/bin/pi-mcp-read', extensions: 'builtin:mcp' } }, /forms\.read\.extensions/],
  ];
  for (const [forms, detail] of cases) {
    refuse(admitCall(workspace(validPolicy({ forms })).env, createPostureState(), 2), 'policy-invalid', detail);
  }
});

// ── Ceilings clamp downward and refuse an above-maximum request (EX-6) ─────

test('ceilings clamp to the maxima, refuse an above-maximum request, and take the maximum when absent', () => {
  const maxima = { requests: 20, tokens: 100000, cost_usd: 1.5, wall_clock_s: 600 };

  const narrowed = clampCeilings({ requests: 5, tokens: 1000 }, maxima);
  if (!narrowed.ok) assert.fail(`expected a clamp, got ${narrowed.reason}: ${narrowed.detail}`);
  assert.deepEqual(
    narrowed.ceilings,
    { requests: 5, tokens: 1000, cost_usd: 1.5, wall_clock_s: 600 },
    'an absent ceiling takes the maximum',
  );

  const atMaximum = clampCeilings({ requests: 20, cost_usd: 1.5 }, maxima);
  if (!atMaximum.ok) assert.fail(`a ceiling at the maximum is admitted, got ${atMaximum.reason}`);
  assert.equal(atMaximum.ceilings.requests, 20);
  assert.equal(atMaximum.ceilings.cost_usd, 1.5);

  for (const [unit, requested, maximum] of [
    ['requests', 21, 20],
    ['tokens', 100001, 100000],
    ['cost_usd', 1.6, 1.5],
    ['wall_clock_s', 601, 600],
  ] as const) {
    const refused = clampCeilings({ [unit]: requested }, maxima);
    if (refused.ok) assert.fail(`expected ceiling-above-maximum for ${unit}`);
    assert.equal(refused.reason, 'ceiling-above-maximum');
    assert.match(refused.detail, new RegExp(unit));
    assert.match(refused.detail, new RegExp(String(requested)));
    assert.match(refused.detail, new RegExp(String(maximum)));
  }

  const unbounded = clampCeilings(undefined, {});
  if (!unbounded.ok) assert.fail('no maximum and no request is not a refusal');
  assert.deepEqual(unbounded.ceilings, {}, 'no maximum and no request leaves the ceiling absent');

  const requestedOnly = clampCeilings({ tokens: 10 }, {});
  if (!requestedOnly.ok) assert.fail('a request under no maximum is admitted');
  assert.deepEqual(requestedOnly.ceilings, { tokens: 10 });
});
