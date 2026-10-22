// Location resolution (design sec-3): env beats XDG, only an unset variable
// falls through, and the policy is never looked up in the launch dir. Pure, so
// every case is an env object and a path — no filesystem, no process.env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLocations } from './config.ts';
import type { Resolved } from './config.ts';

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
    LAUNCH,
  );
  assert.equal(path(locations.policyPath), '/etc/quotient/policy.json');
  assert.equal(path(locations.runDir), '/var/quotient/runs');
  assert.equal(path(locations.sessionHome), '/var/quotient/sessions');
});

test('an unset QUOTIENT_* variable falls through to XDG, then to HOME', () => {
  const xdg = resolveLocations({ HOME, XDG_CONFIG_HOME: '/xdg/config', XDG_STATE_HOME: '/xdg/state' }, LAUNCH);
  assert.equal(path(xdg.policyPath), '/xdg/config/quotient/policy.json');
  assert.equal(path(xdg.runDir), '/xdg/state/quotient/runs');
  assert.equal(path(xdg.sessionHome), '/xdg/state/quotient/sessions');

  const home = resolveLocations({ HOME }, LAUNCH);
  assert.equal(path(home.policyPath), `${HOME}/.config/quotient/policy.json`);
  assert.equal(path(home.runDir), `${HOME}/.local/state/quotient/runs`);
  assert.equal(path(home.sessionHome), `${HOME}/.local/state/quotient/sessions`);
});

test('a set but empty or relative QUOTIENT_* variable is unusable, never a fall-through', () => {
  for (const name of ['QUOTIENT_POLICY', 'QUOTIENT_RUN_DIR', 'QUOTIENT_SESSION_HOME'] as const) {
    for (const [value, why] of [['', 'empty'], ['relative/path', 'not an absolute path']]) {
      const locations = resolveLocations({ HOME, [name]: value }, LAUNCH);
      const item = { QUOTIENT_POLICY: locations.policyPath, QUOTIENT_RUN_DIR: locations.runDir, QUOTIENT_SESSION_HOME: locations.sessionHome }[name];
      assert.equal(refusal(item), `${name} is set but ${why}`);
    }
  }
});

test('a relative XDG_* is ignored, per the XDG spec', () => {
  const locations = resolveLocations({ HOME, XDG_CONFIG_HOME: 'config', XDG_STATE_HOME: 'state' }, LAUNCH);
  assert.equal(path(locations.policyPath), `${HOME}/.config/quotient/policy.json`);
  assert.equal(path(locations.runDir), `${HOME}/.local/state/quotient/runs`);
  assert.deepEqual(locations.profileLayers, [`${LAUNCH}/.quotient/profiles`, `${HOME}/.config/quotient/profiles`]);
});

test('no usable HOME or XDG gives policy-unavailable for every defaulted location', () => {
  for (const env of [{}, { HOME: '' }, { HOME: 'relative', XDG_CONFIG_HOME: 'x', XDG_STATE_HOME: 'y' }]) {
    const locations = resolveLocations(env, LAUNCH);
    // Each is the caller's policy-unavailable; the detail names what was missing.
    assert.match(refusal(locations.policyPath), /QUOTIENT_POLICY is unset and neither XDG_CONFIG_HOME nor HOME/);
    assert.match(refusal(locations.runDir), /QUOTIENT_RUN_DIR is unset and neither XDG_STATE_HOME nor HOME/);
    assert.match(refusal(locations.sessionHome), /QUOTIENT_SESSION_HOME is unset and neither XDG_STATE_HOME nor HOME/);
    // The launch layers do not depend on HOME; the XDG layers are absent.
    assert.deepEqual(locations.profileLayers, [`${LAUNCH}/.quotient/profiles`]);
    assert.deepEqual(locations.helpLayers, [`${LAUNCH}/.quotient/help`]);
  }
});

test('profiles and help layer launch dir over XDG; the policy is never read from the launch dir', () => {
  // A real tree with .quotient/policy.json present: resolution must not see it.
  const launch = mkdtempSync(join(tmpdir(), 'quotient-config-'));
  mkdirSync(join(launch, '.quotient'));
  writeFileSync(join(launch, '.quotient', 'policy.json'), '{}');

  const locations = resolveLocations({ XDG_CONFIG_HOME: '/xdg/config', XDG_STATE_HOME: '/xdg/state' }, launch);
  assert.equal(path(locations.policyPath), '/xdg/config/quotient/policy.json');
  assert.deepEqual(locations.profileLayers, [join(launch, '.quotient/profiles'), '/xdg/config/quotient/profiles']);
  assert.deepEqual(locations.helpLayers, [join(launch, '.quotient/help'), '/xdg/config/quotient/help']);

  const noXdg = resolveLocations({}, launch);
  assert.ok(!noXdg.policyPath.ok, 'with no XDG base the policy is unavailable, not found in the launch dir');
});
