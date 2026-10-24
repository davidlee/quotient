// Location resolution (design sec-3): env beats XDG, only an unset variable
// falls through, and the policy is never looked up in the launch dir. Pure, so
// every case is an env object and a path — no filesystem, no process.env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyLayers, resolveLocations, type Resolved } from './config.ts';

const LAUNCH = '/work/project';
const HOME = '/home/someone';

const path = (resolved: Resolved): string => {
  assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.detail);
  return (resolved as { path: string }).path;
};
const refusal = (resolved: Resolved): string => {
  assert.equal(resolved.ok, false, 'expected an unusable location');
  return (resolved as { detail: string }).detail;
};

test('QUOTIENT_* variables win over the XDG defaults', () => {
  const locations = resolveLocations(
    {
      HOME,
      XDG_CONFIG_HOME: '/xdg/config',
      XDG_STATE_HOME: '/xdg/state',
      QUOTIENT_POLICY: '/etc/quotient/policy.json',
      QUOTIENT_RUN_DIR: '/var/quotient/runs',
      QUOTIENT_SESSION_HOME: '/var/quotient/sessions',
    },
  );
  assert.equal(path(locations.policyPath), '/etc/quotient/policy.json');
  assert.equal(path(locations.runDir), '/var/quotient/runs');
  assert.equal(path(locations.sessionHome), '/var/quotient/sessions');
});

test('an unset QUOTIENT_* variable falls through to XDG, then to HOME', () => {
  const xdg = resolveLocations({ HOME, XDG_CONFIG_HOME: '/xdg/config', XDG_STATE_HOME: '/xdg/state' });
  assert.equal(path(xdg.policyPath), '/xdg/config/quotient/policy.json');
  assert.equal(path(xdg.runDir), '/xdg/state/quotient/runs');
  assert.equal(path(xdg.sessionHome), '/xdg/state/quotient/sessions');

  const home = resolveLocations({ HOME });
  assert.equal(path(home.policyPath), `${HOME}/.config/quotient/policy.json`);
  assert.equal(path(home.runDir), `${HOME}/.local/state/quotient/runs`);
  assert.equal(path(home.sessionHome), `${HOME}/.local/state/quotient/sessions`);
});

test('a set but empty or relative QUOTIENT_* variable is unusable, never a fall-through', () => {
  for (const name of ['QUOTIENT_POLICY', 'QUOTIENT_RUN_DIR', 'QUOTIENT_SESSION_HOME'] as const) {
    for (const [value, why] of [['', 'empty'], ['relative/path', 'not an absolute path']]) {
      const locations = resolveLocations({ HOME, [name]: value });
      const item = { QUOTIENT_POLICY: locations.policyPath, QUOTIENT_RUN_DIR: locations.runDir, QUOTIENT_SESSION_HOME: locations.sessionHome }[name];
      assert.equal(refusal(item), `${name} is set but ${why}`);
    }
  }
});

test('a relative XDG_* is ignored, per the XDG spec', () => {
  const locations = resolveLocations({ HOME, XDG_CONFIG_HOME: 'config', XDG_STATE_HOME: 'state' });
  assert.equal(path(locations.policyPath), `${HOME}/.config/quotient/policy.json`);
  assert.equal(path(locations.runDir), `${HOME}/.local/state/quotient/runs`);
  assert.deepEqual(locations.profileLayers, [`${HOME}/.config/quotient/profiles`]);
});

test('no usable HOME or XDG gives policy-unavailable for every defaulted location', () => {
  for (const env of [{}, { HOME: '' }, { HOME: 'relative', XDG_CONFIG_HOME: 'x', XDG_STATE_HOME: 'y' }]) {
    const locations = resolveLocations(env);
    // Each is the caller's policy-unavailable; the detail names what was missing.
    assert.match(refusal(locations.policyPath), /QUOTIENT_POLICY is unset and neither XDG_CONFIG_HOME nor HOME/);
    assert.match(refusal(locations.runDir), /QUOTIENT_RUN_DIR is unset and neither XDG_STATE_HOME nor HOME/);
    assert.match(refusal(locations.sessionHome), /QUOTIENT_SESSION_HOME is unset and neither XDG_STATE_HOME nor HOME/);
    // The layers follow the config base, so neither exists here.
    assert.deepEqual(locations.profileLayers, []);
    assert.deepEqual(locations.helpLayers, []);
  }
});

test('profiles and help come from XDG only; the launch dir supplies no layer', () => {
  // A real tree holding both a policy and both layers: resolution must see none.
  const launch = mkdtempSync(join(tmpdir(), 'quotient-config-'));
  for (const kind of ['profiles', 'help']) {mkdirSync(join(launch, '.quotient', kind), { recursive: true });}
  writeFileSync(join(launch, '.quotient', 'policy.json'), '{}');
  writeFileSync(join(launch, '.quotient', 'profiles', 'write.md'), 'not a profile\n');

  const locations = resolveLocations({ XDG_CONFIG_HOME: '/xdg/config', XDG_STATE_HOME: '/xdg/state' });
  assert.equal(path(locations.policyPath), '/xdg/config/quotient/policy.json');
  assert.deepEqual(locations.profileLayers, ['/xdg/config/quotient/profiles']);
  assert.deepEqual(locations.helpLayers, ['/xdg/config/quotient/help']);

  const noXdg = resolveLocations({});
  assert.ok(!noXdg.policyPath.ok, 'with no XDG base the policy is unavailable, not found in the launch dir');
  assert.deepEqual(noXdg.profileLayers, [], 'and no layer is found there either');
  assert.deepEqual(noXdg.helpLayers, []);
});

test('legacyLayers names the two launch-dir layers earlier versions read', () => {
  // Pure: the paths are derived, not looked up; whether they exist is the
  // start-up check's question, not this function's.
  assert.deepEqual(legacyLayers(LAUNCH), [`${LAUNCH}/.quotient/profiles`, `${LAUNCH}/.quotient/help`]);
  assert.deepEqual(legacyLayers('/work/project/'), ['/work/project/.quotient/profiles', '/work/project/.quotient/help']);
  const relative = legacyLayers('project');
  assert.deepEqual(relative, ['project/.quotient/profiles', 'project/.quotient/help']);
});

test('approvalsPath is <xdgConfig>/quotient/approvals.json, and no variable moves it', () => {
  assert.equal(
    path(resolveLocations({ HOME, XDG_CONFIG_HOME: '/xdg/config' }).approvalsPath),
    '/xdg/config/quotient/approvals.json',
  );
  assert.equal(path(resolveLocations({ HOME }).approvalsPath), `${HOME}/.config/quotient/approvals.json`);
  assert.equal(
    path(resolveLocations({ HOME, XDG_CONFIG_HOME: 'relative' }).approvalsPath),
    `${HOME}/.config/quotient/approvals.json`,
    'a relative XDG base is ignored, per the XDG spec',
  );

  // The store is authority, like the policy: every launch variable set, and it
  // still resolves under the XDG config base. There is no QUOTIENT_APPROVALS.
  const everywhere = resolveLocations({
    HOME,
    XDG_CONFIG_HOME: '/xdg/config',
    QUOTIENT_POLICY: '/etc/quotient/policy.json',
    QUOTIENT_RUN_DIR: '/var/quotient/runs',
    QUOTIENT_SESSION_HOME: '/var/quotient/sessions',
    QUOTIENT_APPROVALS: '/tmp/mine.json',
  });
  assert.equal(path(everywhere.approvalsPath), '/xdg/config/quotient/approvals.json');
});

test('with no absolute XDG base or HOME the approvals path is unusable', () => {
  for (const env of [{}, { HOME: '' }, { HOME: 'relative', XDG_CONFIG_HOME: 'x' }]) {
    assert.match(refusal(resolveLocations(env).approvalsPath), /neither XDG_CONFIG_HOME nor HOME/);
  }
});

test('QUOTIENT_LAUNCHER names the launcher only when absolute; it never refuses', () => {
  assert.equal(resolveLocations({ HOME, QUOTIENT_LAUNCHER: '/opt/q/bin/quotient' }).launcher, '/opt/q/bin/quotient');
  assert.equal(resolveLocations({ HOME, QUOTIENT_LAUNCHER: '/opt/q/./bin/quotient' }).launcher, '/opt/q/bin/quotient', 'normalised');
  for (const value of [undefined, '', 'bin/quotient']) {
    const locations = resolveLocations({ HOME, QUOTIENT_LAUNCHER: value });
    assert.equal(locations.launcher, null);
    assert.ok(locations.policyPath.ok, 'an unusable launcher does not touch the policy');
  }
});
