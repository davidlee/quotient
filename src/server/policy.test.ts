// Tests for the operator artefact (design sec-1, sec-2 steps 1-2, sec-6):
// the launch-environment contract, the policy schema, the one posture this
// build serves, the enable gate, and the attempts ledger every refusal reaches.
//
// Hermetic: each test mints its own temp tree and passes an environment object
// to `admit` (`admitCall` over the resolved locations); the ambient process environment is never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clampCeilings, selectSlot, transcriptBudget, writablePaths, type Admission } from './policy.ts';
import { sha256Hex } from './evidence.ts';
import { admit, attempts, validPolicy, workspace, type Env } from './test-rig.ts';

function refuse(verdict: Admission, reason: string, detail: RegExp): void {
  if (verdict.ok) {assert.fail(`expected a ${reason} refusal, got an admission`);}
  assert.equal(verdict.reason, reason);
  assert.match(verdict.detail, detail);
}

// ── The launch environment is a contract (EX-10) ────────────────────────────

test('a policy declared by the launch environment is admitted', () => {
  const ws = workspace(validPolicy());
  const verdict = admit(ws.env, 1);
  if (!verdict.ok) {assert.fail(`expected admission, got ${verdict.reason}: ${verdict.detail}`);}
  assert.equal(verdict.policy.mode, 'per-call');
  assert.equal(verdict.policy.roots.length, 1);
  assert.equal(verdict.digest, sha256Hex(readFileSync(ws.policyPath)));
  assert.equal(verdict.runDir, ws.runDir);
});

// Where each location comes from is config.test.ts's; here, that any unusable
// one refuses before the policy is read, with the resolver's detail.
test('an unusable location refuses policy-unavailable, naming the variable: unset with no XDG base, or relative', () => {
  const ws = workspace(validPolicy());
  for (const name of ['QUOTIENT_POLICY', 'QUOTIENT_RUN_DIR', 'QUOTIENT_SESSION_HOME']) {
    const unset: Env = { ...ws.env };
    delete unset[name];
    delete unset.XDG_CONFIG_HOME;
    refuse(admit(unset, 1), 'policy-unavailable', new RegExp(`${name} is unset`));
    refuse(admit({ ...ws.env, [name]: 'relative/path' }, 17), 'policy-unavailable', new RegExp(`${name} is set but not`));
  }
});

// ── The artefact: absent, unparsable, schema-invalid (EX-3, EX-6) ───────────

test('an absent policy file refuses policy-unavailable and records an attempt without a digest', () => {
  const ws = workspace(validPolicy());
  const env: Env = { ...ws.env, QUOTIENT_POLICY: join(ws.dir, 'missing.json') };
  refuse(admit(env, 7), 'policy-unavailable', /missing\.json/);

  const lines = attempts(ws.runDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'policy-unavailable');
  assert.equal(lines[0].call_id, 7);
  assert.equal('policy_digest' in lines[0], false);
});

test('an unparsable policy refuses policy-invalid and records the readable digest', () => {
  const ws = workspace('{"mode": "per-call",', { raw: true });
  refuse(admit(ws.env, 2), 'policy-invalid', /not valid JSON/);

  const lines = attempts(ws.runDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'policy-invalid');
  assert.equal(lines[0].policy_digest, sha256Hex(readFileSync(ws.policyPath)));
  assert.match(String(lines[0].policy_digest), /^[0-9a-f]{64}$/);
});

test('an unknown policy key refuses policy-invalid, naming it', () => {
  const ws = workspace(validPolicy({ speed: 'fast' }));
  refuse(admit(ws.env, 3), 'policy-invalid', /speed/);
  assert.equal(attempts(ws.runDir)[0].reason, 'policy-invalid');
});

test('a wrong-typed policy value refuses policy-invalid, naming the field', () => {
  const cases: [string, unknown][] = [
    ['roots', 'work/one'],
    ['profiles', 'read'],
    ['maxima', []],
    ['forms', 'pi-mcp-read'],
    ['exposure', [7]],
    ['exposure', ['relative/path']],
    ['enabled', 'yes'],
    ['transcript_budget_bytes', 1.5],
  ];
  for (const [field, value] of cases) {
    const ws = workspace(validPolicy({ [field]: value }));
    refuse(admit(ws.env, 4), 'policy-invalid', new RegExp(field));
  }
});

test('maxima that do not bound the run refuse policy-invalid: all four are required and positive', () => {
  // A delegate with no ceiling is unbounded spend: the wall clock bounds time, not
  // money, so a spend ceiling may not be left out (design sec-1; REQ-004, DEC-057).
  const full = { requests: 20, context_tokens: 100000, cost_usd: 1.5, wall_clock_s: 600 };
  const without = (field: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(full).filter(([key]) => key !== field));
  const cases: [Record<string, unknown>, RegExp][] = [
    [{}, /maxima\./],
    [{ wall_clock_s: 600 }, /maxima\./],
    ...Object.keys(full).map((field): [Record<string, unknown>, RegExp] => [without(field), new RegExp(`maxima\\.${field}`)]),
    [{ ...full, wall_clock_s: 0 }, /maxima\.wall_clock_s/],
    [{ ...full, cost_usd: -1 }, /maxima\.cost_usd/],
    [{ ...full, requests: 0 }, /maxima\.requests/],
  ];
  for (const [maxima, detail] of cases) {
    const ws = workspace(validPolicy({ maxima }));
    refuse(admit(ws.env, 4), 'policy-invalid', detail);
  }
  assert.ok(admit(workspace(validPolicy({ maxima: full })).env, 4).ok);
});

test('a negative transcript budget refuses policy-invalid; 0 is admitted and sets no ceiling', () => {
  refuse(admit(workspace(validPolicy({ transcript_budget_bytes: -1 })).env, 4), 'policy-invalid', /transcript_budget_bytes/);
  assert.ok(admit(workspace(validPolicy({ transcript_budget_bytes: 0 })).env, 4).ok);
});

test('a policy naming a non-absolute root or form path refuses policy-invalid', () => {
  refuse(
    admit(workspace(validPolicy({ roots: ['relative/root'] })).env, 5),
    'policy-invalid',
    /roots/,
  );
  refuse(
    admit(workspace(validPolicy({ forms: { read: 'pi-mcp-read' } })).env, 5),
    'policy-invalid',
    /forms\.read/,
  );
});

test('a missing required policy field refuses policy-invalid, naming it', () => {
  for (const field of ['schema', 'mode', 'roots', 'profiles', 'forms', 'exposure', 'enabled']) {
    const policy = validPolicy();
    delete policy[field];
    refuse(admit(workspace(policy).env, 6), 'policy-invalid', new RegExp(field));
  }
});

// ── One posture: per-call only (EX-4) ───────────────────────────────────────

test('mode = static refuses posture-unsupported instead of being downgraded', () => {
  const ws = workspace(validPolicy({ mode: 'static' }));
  const verdict = admit(ws.env, 8);
  refuse(verdict, 'posture-unsupported', /static/);
  assert.equal(attempts(ws.runDir)[0].reason, 'posture-unsupported');
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
    refuse(admit(ws.env, 9), 'posture-unsupported', new RegExp(field));
    // Nothing was spawned, so the ledger is the only sink that can hold it.
    assert.equal(attempts(ws.runDir)[0].reason, 'posture-unsupported');
  }
});

test('an unrecognised mode refuses posture-unsupported: only per-call is served', () => {
  refuse(admit(workspace(validPolicy({ mode: 'shared' })).env, 10), 'posture-unsupported', /shared/);
});

test('a mode change between calls is refused at the next call by the schema re-validation: only per-call is served, so posture-unsupported names both modes', () => {
  const ws = workspace(validPolicy());
  const first = admit(ws.env, 11);
  assert.equal(first.ok, true);

  // No process state remembers the first call's mode: the artefact is re-read and
  // re-validated per call, and the schema is what refuses the new one.
  writeFileSync(ws.policyPath, JSON.stringify(validPolicy({ mode: 'static' })));
  refuse(admit(ws.env, 12), 'posture-unsupported', /static/);

  const lines = attempts(ws.runDir);
  assert.equal(lines.length, 1, 'the admitted call records no refusal; the refused one does');
  assert.equal(lines[0].reason, 'posture-unsupported');
  assert.equal(lines[0].call_id, 12);
  assert.match(String(lines[0].detail), /per-call/);
});

// ── The enable gate (EX-5) ─────────────────────────────────────────────────

test('enabled = false refuses disabled and records it in attempts.jsonl', () => {
  const ws = workspace(validPolicy({ enabled: false }));
  refuse(admit(ws.env, 13), 'disabled', /enabled/);

  const lines = attempts(ws.runDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'disabled');
  assert.equal(lines[0].call_id, 13);
  assert.equal(lines[0].policy_digest, sha256Hex(readFileSync(ws.policyPath)));
});

test('a policy re-read per call sees an enable flip at the next call', () => {
  const ws = workspace(validPolicy());
  assert.equal(admit(ws.env, 14).ok, true);

  writeFileSync(ws.policyPath, JSON.stringify(validPolicy({ enabled: false })));
  refuse(admit(ws.env, 15), 'disabled', /enabled/);
});

// ── The forms: a capability selects its wrapper form (EX-5, EX-7) ──────────

/** A policy as `admitCall` normalised it, so the later steps see the real shape. */
function admittedPolicy(overrides: Record<string, unknown> = {}) {
  const ws = workspace(validPolicy(overrides));
  const verdict = admit(ws.env, 1);
  if (!verdict.ok) {assert.fail(`expected admission, got ${verdict.reason}: ${verdict.detail}`);}
  return verdict.policy;
}

test('the machine slot is selected by capability; a capability with no form is wrapper-unavailable', () => {
  const policy = admittedPolicy({ forms: { read: '/nix/store/aaa/bin/pi-mcp-read' } });

  const read = selectSlot(policy, 'read');
  if (!read.ok) {assert.fail(`expected the read form, got ${read.reason}: ${read.detail}`);}
  assert.deepEqual(read.form, { kind: 'confined', path: '/nix/store/aaa/bin/pi-mcp-read', extensions: [] }, 'the string form declares no extension');

  const write = selectSlot(policy, 'write');
  if (write.ok) {assert.fail('expected wrapper-unavailable for a capability with no form');}
  assert.equal(write.reason, 'wrapper-unavailable');
  assert.match(write.detail, /write/);
});

test('writablePaths: every roots entry, exposure path and the session home, canonicalised', () => {
  const policy = admittedPolicy({ roots: ['/work/one', '/work/two'], exposure: ['/home/operator/.pi'] });

  assert.deepEqual(writablePaths(policy, '/state/sessions'), [
    '/work/one',
    '/work/two',
    '/home/operator/.pi',
    '/state/sessions',
  ]);
});

test('a form may declare the extensions it passes, and nothing else', () => {
  const policy = admittedPolicy({
    forms: { read: { path: '/nix/store/aaa/bin/pi-mcp-read', extensions: ['builtin:mcp'] } },
  });
  assert.deepEqual(policy.forms.read, { kind: 'confined', path: '/nix/store/aaa/bin/pi-mcp-read', extensions: ['builtin:mcp'] });

  // A form with no declared extensions passes none, which is what EX-7 compares.
  assert.deepEqual(admittedPolicy({ forms: { read: { path: '/nix/store/aaa/bin/pi-mcp-read' } } }).forms.read, {
    kind: 'confined',
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
    refuse(admit(workspace(validPolicy({ forms })).env, 2), 'policy-invalid', detail);
  }

  // The launch forms pass no `-e` other than the one extension this build wires,
  // so a foreign entry is a policy naming a launcher that does not exist here.
  const foreign = admit(
    workspace(
      validPolicy({
        forms: { read: { path: '/nix/store/aaa/bin/pi-mcp-read', extensions: ['/nix/store/bbb/lib/other.ts'] } },
      }),
    ).env,
    2,
  );
  if (foreign.ok) {assert.fail('expected a foreign extension to refuse policy-invalid');}
  assert.equal(foreign.reason, 'policy-invalid');
  assert.match(foreign.detail, /forms\.read\.extensions\[0\]/, 'the detail names the offending index');
  assert.match(foreign.detail, /other\.ts/, 'and the offending entry');
});

// ── quotient-policy/2: the schema tag, the profiles map, unconfined, exposure ─

test('quotient-policy/2: schema is required and checked first; /1 is refused with migration guidance', () => {
  const missing = validPolicy();
  delete missing.schema;
  refuse(admit(workspace(missing).env, 1), 'policy-invalid', /missing policy field: schema/);
  // First: before the static-only posture check and the unknown-key check.
  refuse(admit(workspace({ ...missing, agent: 'x', speed: 'fast' }).env, 1), 'policy-invalid', /schema/);
  refuse(admit(workspace(validPolicy({ schema: 'quotient-policy/1' })).env, 1), 'policy-invalid', /context_tokens/);
  for (const schema of ['pi-mcp-policy/1', 1, null]) {
    refuse(admit(workspace(validPolicy({ schema })).env, 1), 'policy-invalid', /schema/);
  }
});

test('policy/2 refuses old or mixed token ceiling fields and requires context_tokens', () => {
  const old = validPolicy();
  const oldMaxima = old.maxima as Record<string, unknown>;
  delete oldMaxima.context_tokens;
  oldMaxima.tokens = 100000;
  refuse(admit(workspace(old).env, 1), 'policy-invalid', /maxima\.tokens.*context_tokens/);

  const mixed = validPolicy();
  (mixed.maxima as Record<string, unknown>).tokens = 100000;
  refuse(admit(workspace(mixed).env, 1), 'policy-invalid', /maxima\.tokens.*context_tokens/);

  const missing = validPolicy();
  delete (missing.maxima as Record<string, unknown>).context_tokens;
  refuse(admit(workspace(missing).env, 1), 'policy-invalid', /maxima\.context_tokens/);
});

test('child_binds is now an unknown field; exposure replaces it', () => {
  const policy = validPolicy({ child_binds: [] });
  refuse(admit(workspace(policy).env, 1), 'policy-invalid', /unknown policy field: child_binds/);
  assert.deepEqual(admittedPolicy({ exposure: ['/home/operator/.pi'] }).exposure, ['/home/operator/.pi']);
});

test('profiles maps a profile name to read or write', () => {
  assert.deepEqual(admittedPolicy({ profiles: { read: 'read', research: 'read', write: 'write' } }).profiles, {
    read: 'read',
    research: 'read',
    write: 'write',
  });
  const cases: [unknown, RegExp][] = [
    [['read', 'write'], /profiles must be an object/],
    [{ Read: 'read' }, /profiles\.Read/],
    [{ read: 'rw' }, /profiles\.read must be "read" or "write"/],
    [{ read: true }, /profiles\.read must be "read" or "write"/],
  ];
  for (const [profiles, detail] of cases) {
    refuse(admit(workspace(validPolicy({ profiles })).env, 1), 'policy-invalid', detail);
  }
});

test('a write form may be unconfined; read unconfined, path with unconfined, and a relative pi are policy-invalid', () => {
  const policy = admittedPolicy({ forms: { read: '/nix/store/aaa/bin/quotient-read', write: { unconfined: '/usr/bin/pi' } } });
  assert.deepEqual(policy.forms.write, { kind: 'unconfined', pi: '/usr/bin/pi' }, 'a write unconfined is admitted');

  const cases: [Record<string, unknown>, RegExp][] = [
    [{ read: { unconfined: '/usr/bin/pi' } }, /forms\.read: a read form cannot be unconfined/],
    [{ write: { path: '/nix/store/aaa/bin/quotient-write', unconfined: '/usr/bin/pi' } }, /forms\.write: path and unconfined/],
    [{ write: { unconfined: 'pi' } }, /forms\.write\.unconfined must be an absolute path/],
    [{ write: { unconfined: '/usr/bin/pi', extensions: ['builtin:mcp'] } }, /unknown policy field: forms\.write\.extensions/],
  ];
  for (const [forms, detail] of cases) {
    refuse(admit(workspace(validPolicy({ forms })).env, 1), 'policy-invalid', detail);
  }
});

// ── Ceilings clamp downward and refuse an above-maximum request (EX-6) ─────

test('ceilings clamp to the maxima, refuse an above-maximum request, and take the maximum when absent', () => {
  const maxima = { requests: 20, context_tokens: 100000, cost_usd: 1.5, wall_clock_s: 600 };

  const narrowed = clampCeilings({ requests: 5, context_tokens: 1000 }, maxima);
  if (!narrowed.ok) {assert.fail(`expected a clamp, got ${narrowed.reason}: ${narrowed.detail}`);}
  assert.deepEqual(
    narrowed.ceilings,
    { requests: 5, context_tokens: 1000, cost_usd: 1.5, wall_clock_s: 600 },
    'an absent ceiling takes the maximum',
  );

  const atMaximum = clampCeilings({ requests: 20, cost_usd: 1.5 }, maxima);
  if (!atMaximum.ok) {assert.fail(`a ceiling at the maximum is admitted, got ${atMaximum.reason}`);}
  assert.equal(atMaximum.ceilings.requests, 20);
  assert.equal(atMaximum.ceilings.cost_usd, 1.5);

  for (const [unit, requested, maximum] of [
    ['requests', 21, 20],
    ['context_tokens', 100001, 100000],
    ['cost_usd', 1.6, 1.5],
    ['wall_clock_s', 601, 600],
  ] as const) {
    const refused = clampCeilings({ [unit]: requested }, maxima);
    if (refused.ok) {assert.fail(`expected ceiling-above-maximum for ${unit}`);}
    assert.equal(refused.reason, 'ceiling-above-maximum');
    assert.match(refused.detail, new RegExp(unit));
    assert.match(refused.detail, new RegExp(String(requested)));
    assert.match(refused.detail, new RegExp(String(maximum)));
  }

  const unbounded = clampCeilings(undefined, {});
  if (!unbounded.ok) {assert.fail('no maximum and no request is not a refusal');}
  assert.deepEqual(unbounded.ceilings, {}, 'no maximum and no request leaves the ceiling absent');

  const requestedOnly = clampCeilings({ context_tokens: 10 }, {});
  if (!requestedOnly.ok) {assert.fail('a request under no maximum is admitted');}
  assert.deepEqual(requestedOnly.ceilings, { context_tokens: 10 });
});

// ── The transcript budget: the one clamp that narrows silently ─────────────

test('the transcript budget clamps to the policy maximum, silently where clampCeilings refuses (F-6)', () => {
  assert.equal(transcriptBudget(undefined, undefined), undefined, 'nothing asked and no ceiling: the reducer default stands');
  assert.equal(transcriptBudget(4096, undefined), 4096);
  assert.equal(transcriptBudget(0, undefined), 0, '0 is the reducer\'s own word for the full transcript');
  assert.equal(transcriptBudget(undefined, 4096), 4096, 'the policy maximum applies to a call that asked for nothing');
  assert.equal(transcriptBudget(4096, 2048), 2048, 'the call\'s value is clamped, never passed through');
  assert.equal(transcriptBudget(0, 2048), 2048, 'a call asking for the whole transcript cannot unbound an operator ceiling');
  assert.equal(transcriptBudget(8192, 0), 8192, 'a policy maximum of 0 sets no ceiling');
});
