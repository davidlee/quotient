// `src/server/forms.ts` (design sec-2 "Step 5: selecting the form" and "The
// selection module"): what is at a root's `.quotient/forms/<capability>` link,
// and what step 5 decides with it.
//
// Hermetic: every case mints its own temp tree — a base whose `.quotient/forms/`
// exists, an executable OUTSIDE every writable path, and the writable set a call
// under the policy would have. Nothing reads the ambient environment and nothing
// is spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPROVALS_SCHEMA, type Approval } from './approvals.ts';
import { sha256Hex } from './evidence.ts';
import { chooseForm, lookupProjectForm, probeProjectForm, type ProjectForm, type SelectedForm } from './forms.ts';
import type { SlotSelection } from './policy.ts';
import type { Filesystem } from './profiles.ts';

/** A base whose `.quotient/forms` exists, an executable outside every writable
 *  path, and the writable paths (`writablePaths`) a call would have. */
type Fixture = {
  dir: string;
  base: string;
  writable: string[];
  executable: string;
  /** `<base>/.quotient/forms/<capability>`, whether or not anything is there. */
  link: (capability?: Filesystem) => string;
};

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'quotient-forms-'));
  const base = join(dir, 'project');
  mkdirSync(join(base, '.quotient', 'forms'), { recursive: true });
  const store = join(dir, 'store');
  mkdirSync(store);
  const executable = join(store, 'pi-mcp-write');
  writeFileSync(executable, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(executable, 0o755);
  return {
    dir,
    base,
    writable: [base, join(dir, 'exposure'), join(dir, 'session')],
    executable,
    link: (capability = 'write') => join(base, '.quotient', 'forms', capability),
  };
}

/** The detail of a probe that must be invalid (the file is judged and refused). */
function invalidDetail(probe: ProjectForm): string {
  if (probe.kind !== 'invalid') {assert.fail(`expected an invalid form, got ${probe.kind}`);}
  return probe.detail;
}

/** The probe of a usable form, asserting it is usable. */
function usableProbe(probe: ProjectForm): { link: string; path: string; sha256: string } {
  if (probe.kind !== 'usable') {assert.fail(`expected a usable form, got ${probe.kind}`);}
  return probe;
}

/** An executable script at PATH, so a case can plant it where it means to. */
function executableAt(path: string): string {
  writeFileSync(path, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

// ── The probe (EX-2, VT-2) ─────────────────────────────────────────────────

test('probeProjectForm: an absent link is absent, not invalid', () => {
  const f = fixture();
  assert.deepEqual(probeProjectForm(f.base, 'write', f.writable), { kind: 'absent' });

  // A base with no `.quotient` at all reads the same: there is no link.
  const bare = join(f.dir, 'bare');
  mkdirSync(bare);
  assert.deepEqual(probeProjectForm(bare, 'write', f.writable), { kind: 'absent' });
});

test('probeProjectForm: a link to an executable outside the writable paths is usable, by real path and digest', () => {
  const f = fixture();
  symlinkSync(f.executable, f.link());

  const probe = usableProbe(probeProjectForm(f.base, 'write', f.writable));
  assert.equal(probe.link, f.link(), 'the link is reported as it is spelled');
  assert.equal(probe.path, realpathSync(f.executable), 'the real path is what would run');
  assert.equal(probe.sha256, sha256Hex(readFileSync(f.executable)), 'the digest covers the real file bytes');
  assert.notEqual(probe.sha256, sha256Hex(f.link()), 'not the link text');
});

test('probeProjectForm: a dangling link and a `.quotient` that is a file are invalid, naming the link', () => {
  const f = fixture();
  symlinkSync(join(f.dir, 'gone'), f.link());
  const dangling = invalidDetail(probeProjectForm(f.base, 'write', f.writable));
  assert.ok(dangling.includes(f.link()), `names the link: ${dangling}`);
  assert.match(dangling, /does not resolve/);

  // ENOTDIR is not an absent entry: `.quotient` being a file is a broken layout.
  const fileBase = join(f.dir, 'file-base');
  mkdirSync(fileBase);
  writeFileSync(join(fileBase, '.quotient'), 'not a directory\n');
  const notDirectory = invalidDetail(probeProjectForm(fileBase, 'write', f.writable));
  assert.ok(notDirectory.includes(join(fileBase, '.quotient', 'forms', 'write')), `names the link: ${notDirectory}`);
});

test('probeProjectForm: a file that is not executable, and a directory target, are invalid', () => {
  const notExecutable = fixture();
  symlinkSync(notExecutable.executable, notExecutable.link());
  chmodSync(notExecutable.executable, 0o644);
  const mode = invalidDetail(probeProjectForm(notExecutable.base, 'write', notExecutable.writable));
  assert.match(mode, /not executable/);
  assert.ok(mode.includes(notExecutable.link()) && mode.includes(realpathSync(notExecutable.executable)), `names link and real path: ${mode}`);

  const directory = fixture();
  const target = join(directory.dir, 'plain');
  mkdirSync(target);
  symlinkSync(target, directory.link());
  const shape = invalidDetail(probeProjectForm(directory.base, 'write', directory.writable));
  assert.match(shape, /not a regular file/);
  assert.ok(shape.includes(realpathSync(target)), `names the real path: ${shape}`);
});

test('probeProjectForm: a target inside a root, an exposure path or the session home is invalid', () => {
  const f = fixture();
  for (const writable of f.writable) {
    mkdirSync(writable, { recursive: true });
    const planted = executableAt(join(writable, 'form.sh'));
    rmSync(f.link(), { force: true });
    symlinkSync(planted, f.link());

    const detail = invalidDetail(probeProjectForm(f.base, 'write', f.writable));
    assert.match(detail, /inside the writable path/);
    assert.ok(detail.includes(realpathSync(planted)), `names the real path: ${detail}`);
    assert.ok(detail.includes(writable), `names the writable path: ${detail}`);
  }
});

// ── The decision (EX-3, VT-3, VT-4) ────────────────────────────────────────

const BASE = '/work/one';
const LINK = `${BASE}/.quotient/forms/write`;
const MACHINE = '/nix/store/aaa/bin/pi-mcp-write';
const APPROVED = '/nix/store/abc-quotient-write';
const DIGEST = 'a'.repeat(64);
const REBUILT = 'b'.repeat(64);

/** The policy's confined `write` slot, declaring `builtin:mcp`. */
const confinedSlot: SlotSelection = {
  ok: true,
  form: { kind: 'confined', path: MACHINE, extensions: ['builtin:mcp'] },
};
const unconfinedSlot: SlotSelection = { ok: true, form: { kind: 'unconfined', pi: '/nix/store/aaa/bin/pi' } };
const absentSlot: SlotSelection = {
  ok: false,
  reason: 'wrapper-unavailable',
  detail: 'the policy declares no "write" wrapper form, and a write-capability profile has no other way to run',
};

/** A usable project form at LINK, with the case's identity. */
const usable = (overrides: { path?: string; sha256?: string } = {}): ProjectForm => ({
  kind: 'usable',
  link: LINK,
  path: overrides.path ?? APPROVED,
  sha256: overrides.sha256 ?? DIGEST,
});
const absentForm: ProjectForm = { kind: 'absent' };
const invalidForm: ProjectForm = {
  kind: 'invalid',
  link: LINK,
  detail: `${LINK} resolves to /nix/store/ddd-broken, which is not executable by this user (EACCES)`,
};

/** An approval for `write` at `/work/one`, with the case's identity. */
const approval = (overrides: Partial<Approval> = {}): Approval => ({
  root: '/work/one',
  capability: 'write',
  path: APPROVED,
  sha256: DIGEST,
  approved_at: '2026-10-24T05:12:44.000Z',
  ...overrides,
});

/** The detail of a decision refused for REASON. */
function refusedForm(selected: SelectedForm, reason: string): string {
  if (selected.ok) {assert.fail(`expected ${reason}, got the ${selected.source.kind} form`);}
  assert.equal(selected.reason, reason);
  return selected.detail;
}

test('chooseForm: an absent machine slot refuses wrapper-unavailable before the store or the link is considered', () => {
  const selected = chooseForm(absentSlot, approval(), BASE, usable());
  if (selected.ok) {assert.fail('expected wrapper-unavailable for a capability with no slot');}
  assert.equal(selected.reason, 'wrapper-unavailable');
  assert.match(selected.detail, /write/);
});

test('chooseForm: an unconfined slot refuses form-invalid with a link or an approval; a project form is never unconfined', () => {
  const linked = refusedForm(chooseForm(unconfinedSlot, undefined, BASE, usable()), 'form-invalid');
  assert.ok(linked.includes(LINK) && linked.includes(APPROVED), `names the link and the real path: ${linked}`);
  assert.match(linked, /never unconfined/);

  const governed = refusedForm(chooseForm(unconfinedSlot, approval(), BASE, absentForm), 'form-invalid');
  assert.ok(governed.includes(LINK), `names the link it would expect: ${governed}`);
  assert.ok(governed.includes(`${APPROVED} (sha256 ${DIGEST})`), `names the approved identity: ${governed}`);

  // With neither, the machine slot stands: there is nothing to substitute.
  assert.deepEqual(chooseForm(unconfinedSlot, undefined, BASE, absentForm), {
    ok: true,
    form: { kind: 'unconfined', pi: '/nix/store/aaa/bin/pi' },
    source: { kind: 'policy' },
  });
});

test('chooseForm: ungoverned — an absent link runs the machine slot, an unusable one is form-invalid, a usable one is form-unapproved', () => {
  assert.deepEqual(chooseForm(confinedSlot, undefined, BASE, absentForm), {
    ok: true,
    form: { kind: 'confined', path: MACHINE, extensions: ['builtin:mcp'] },
    source: { kind: 'policy' },
  });

  const invalid = refusedForm(chooseForm(confinedSlot, undefined, BASE, invalidForm), 'form-invalid');
  assert.ok(invalid.includes(invalidForm.detail), `the probe's reason is what the operator reads: ${invalid}`);
  assert.match(invalid, /no approval governs \/work\/one/);

  const unapproved = refusedForm(chooseForm(confinedSlot, undefined, BASE, usable()), 'form-unapproved');
  assert.ok(unapproved.includes(LINK) && unapproved.includes(APPROVED) && unapproved.includes(DIGEST), `names the link and identity: ${unapproved}`);
  assert.ok(unapproved.includes(`quotient allow /work/one write=${APPROVED}@${DIGEST}`), `the exact record command: ${unapproved}`);
});

test('chooseForm: a governed call runs the approved real path, with the slot extensions inherited', () => {
  assert.deepEqual(chooseForm(confinedSlot, approval(), BASE, usable()), {
    ok: true,
    form: { kind: 'confined', path: APPROVED, extensions: ['builtin:mcp'] },
    source: { kind: 'project', root: '/work/one', sha256: DIGEST },
  });
});

test('chooseForm: a governed call refuses form-invalid when the approved form is missing or unusable', () => {
  const missing = refusedForm(chooseForm(confinedSlot, approval(), BASE, absentForm), 'form-invalid');
  assert.ok(missing.includes(LINK), `names the link: ${missing}`);
  assert.ok(missing.includes('quotient revoke /work/one'), `revoke returns the root to the machine form: ${missing}`);

  const unusable = refusedForm(chooseForm(confinedSlot, approval(), BASE, invalidForm), 'form-invalid');
  assert.ok(unusable.includes(invalidForm.detail), `the probe's reason: ${unusable}`);
  assert.ok(unusable.includes(`${APPROVED} (sha256 ${DIGEST})`), `names the approved identity: ${unusable}`);
});

test('chooseForm: a governed call refuses form-unapproved when either half of the identity changed, naming both and the command', () => {
  const moved = refusedForm(chooseForm(confinedSlot, approval(), BASE, usable({ path: '/nix/store/def-quotient-write' })), 'form-unapproved');
  assert.ok(moved.includes(`${APPROVED} (sha256 ${DIGEST})`), `names the approved identity: ${moved}`);
  assert.ok(moved.includes(`/nix/store/def-quotient-write (sha256 ${DIGEST})`), `names the observed identity: ${moved}`);
  assert.ok(moved.includes(`quotient allow /work/one write=/nix/store/def-quotient-write@${DIGEST}`), `the re-approval command: ${moved}`);

  const rebuilt = refusedForm(chooseForm(confinedSlot, approval(), BASE, usable({ sha256: REBUILT })), 'form-unapproved');
  assert.ok(rebuilt.includes(`sha256 ${DIGEST}`) && rebuilt.includes(`sha256 ${REBUILT}`), `names both digests: ${rebuilt}`);
  assert.ok(rebuilt.includes(`quotient allow /work/one write=${APPROVED}@${REBUILT}`), `the re-approval command: ${rebuilt}`);
});

test('chooseForm: a refusal names the link at the base that was probed, not the approval root', () => {
  // PHASE-05's `allow` probes a candidate base, which need not be the approval's
  // root: naming the approval root's link would name a link nobody inspected.
  const base = '/work/elsewhere';
  const probed = join(base, '.quotient', 'forms', 'write');

  const unconfined = refusedForm(chooseForm(unconfinedSlot, approval(), base, absentForm), 'form-invalid');
  assert.ok(unconfined.includes(probed), `names the probed link: ${unconfined}`);
  assert.ok(!unconfined.includes(LINK), `not the approval root's link: ${unconfined}`);

  const missing = refusedForm(chooseForm(confinedSlot, approval(), base, absentForm), 'form-invalid');
  assert.ok(missing.includes(probed), `names the probed link: ${missing}`);
  assert.ok(!missing.includes(LINK), `not the approval root's link: ${missing}`);
  assert.ok(missing.includes('quotient revoke /work/one'), `revoke still names the approval's root: ${missing}`);
});

// ── The lookup (EX-7, VT-5) ───────────────────────────────────────────────

/** An approvals store at PATH with ENTRIES, in the shape the writer publishes. */
function writeStore(path: string, entries: unknown[]): string {
  writeFileSync(path, `${JSON.stringify({ schema: APPROVALS_SCHEMA, approvals: entries }, null, 2)}\n`);
  return path;
}

/** The fields every lookup needs, defaulted to the `write` capability and
 *  nothing writable, so a case names only what it judges. */
type LookupInput = {
  approvalsPath: string;
  capability?: Filesystem;
  root: string;
  rootsEntry: string;
  base?: string;
  writable?: string[];
};

const lookupInput = ({ capability = 'write', writable = [], ...rest }: LookupInput): Parameters<typeof lookupProjectForm>[0] => ({
  capability,
  writable,
  ...rest,
});

test('lookupProjectForm: a governing approval supplies the base, else the roots entry, and an explicit base overrides both', () => {
  const f = fixture();
  const root = realpathSync(f.base);
  // The approval is recorded deeper than the roots entry, so a lookup that fell
  // back to the roots entry would be visibly wrong; each base has its own link,
  // so the probe's link says which base it ran at.
  const sub = join(root, 'sub');
  const callRoot = join(sub, 'deep');
  mkdirSync(callRoot, { recursive: true });
  const rootLink = join(root, '.quotient', 'forms', 'write');
  const subLink = join(sub, '.quotient', 'forms', 'write');
  mkdirSync(join(sub, '.quotient', 'forms'), { recursive: true });
  symlinkSync(f.executable, rootLink);
  symlinkSync(f.executable, subLink);
  const storePath = join(f.dir, 'approvals.json');
  const entry = { root: sub, capability: 'write', path: APPROVED, sha256: DIGEST, approved_at: '2026-10-24T05:12:44.000Z' };

  const governed = lookupProjectForm(lookupInput({ approvalsPath: writeStore(storePath, [entry]), root: callRoot, rootsEntry: root }));
  if (!governed.ok) {assert.fail(`expected the store to be read, got ${governed.detail}`);}
  assert.equal(governed.base, sub, 'the approval root, not the roots entry');
  assert.equal(governed.governing?.root, sub);
  assert.equal(usableProbe(governed.probe).link, subLink, 'the probe ran at the approval root');

  // An absent store is an empty one: nothing governs, so the roots entry is the base.
  const ungoverned = lookupProjectForm(lookupInput({ approvalsPath: join(f.dir, 'none.json'), root: callRoot, rootsEntry: root }));
  if (!ungoverned.ok) {assert.fail(`expected an absent store to be empty, got ${ungoverned.detail}`);}
  assert.equal(ungoverned.governing, undefined);
  assert.equal(ungoverned.base, root);
  assert.equal(usableProbe(ungoverned.probe).link, rootLink, 'the probe ran at the roots entry');

  // An explicit base wins over both, and the probe is the one at that base.
  const other = join(f.dir, 'other');
  mkdirSync(join(other, '.quotient', 'forms'), { recursive: true });
  symlinkSync(f.executable, join(other, '.quotient', 'forms', 'write'));
  const explicit = lookupProjectForm(
    lookupInput({ approvalsPath: writeStore(storePath, [entry]), root: callRoot, rootsEntry: root, base: other }),
  );
  if (!explicit.ok) {assert.fail(`expected the store to be read, got ${explicit.detail}`);}
  assert.equal(explicit.base, other);
  assert.equal(usableProbe(explicit.probe).link, join(other, '.quotient', 'forms', 'write'), 'the probe ran at the explicit base');
});

test('lookupProjectForm: a malformed store refuses, naming the store and the failure', () => {
  const f = fixture();
  const storePath = join(f.dir, 'approvals.json');
  writeFileSync(storePath, '{\n');

  const lookup = lookupProjectForm(lookupInput({ approvalsPath: storePath, root: f.base, rootsEntry: f.base }));
  if (lookup.ok) {assert.fail('expected a malformed store to be refused');}
  assert.ok(lookup.detail.includes(storePath), `names the store: ${lookup.detail}`);
  assert.ok(lookup.detail.includes('not valid JSON'), `names the failure: ${lookup.detail}`);
});
