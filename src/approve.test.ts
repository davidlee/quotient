// `quotient allow` and `quotient revoke` (design sec-3): the operator's two
// verbs over the approvals store. `allow` reports what the project's links are
// and, given the identities it printed, records them; `revoke` removes what was
// recorded, addressing a stored root.
//
// Hermetic: every case mints its own tree (a `newRig` deployment for the verbs
// that read a policy, a store and a link; a hand-built view for the renderer,
// which must be a pure function of observations and nothing else).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allow, renderReport, revoke, type CapabilityView } from './approve.ts';
import { readApprovals, type Approval } from './server/approvals.ts';
import type { ProjectForm, ProjectFormLookup } from './server/forms.ts';
import type { SlotSelection } from './server/policy.ts';
import { executableAt, newRig, patchPolicy, plantProjectForm, rigApprovalsPath, rigForm, writeApprovals, type Rig } from './server/test-rig.ts';

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A confined machine slot, the only kind a project form may replace. */
const confined = (path = '/nix/store/machine/bin/quotient-write', extensions: string[] = []): SlotSelection => ({
  ok: true,
  form: { kind: 'confined', path, extensions },
});

/** A recorded approval, keyed at ROOT by default. */
const approval = (overrides: Partial<Approval> = {}): Approval => ({
  root: '/work',
  capability: 'write',
  path: '/nix/store/approved/bin/quotient-write',
  sha256: 'a'.repeat(64),
  approved_at: '2026-10-24T05:12:44.000Z',
  ...overrides,
});

/** A usable form at LINK, resolving to PATH with digest SHA256. */
type UsableForm = Extract<ProjectForm, { kind: 'usable' }>;

const usable = (path: string, sha256: string, link = '/work/satan/.quotient/forms/write'): UsableForm => ({
  kind: 'usable',
  link,
  path,
  sha256,
});

/** What admission would see: one observation of one capability. */
type Observation = Extract<ProjectFormLookup, { ok: true }>;

const observed = (overrides: Partial<Observation> = {}): Observation => ({
  ok: true,
  governing: undefined,
  base: '/work/satan',
  probe: usable('/nix/store/approved/bin/quotient-write', 'a'.repeat(64)),
  ...overrides,
});

/** One capability as the report shows it. */
const view = (overrides: Partial<CapabilityView> = {}): CapabilityView => ({
  capability: 'write',
  slot: confined(),
  observed: observed(),
  ...overrides,
});

/** The written record of one verb run, from its two sinks. */
type Run = { status: number; out: string; err: string };

const sinks = (): { run: (status: number) => Run; out: (text: string) => void; err: (text: string) => void; result: () => Run } => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    run: (status) => ({ status, out: out.join(''), err: err.join('') }),
    result: () => ({ status: 0, out: out.join(''), err: err.join('') }),
  };
};

/** One verb against RIG's deployment, with CWD as the working directory. */
function verb(kind: 'allow' | 'revoke', argv: string[], rig: Rig, cwd = rig.root): Run {
  const sink = sinks();
  const status = kind === 'allow' ? allow(argv, rig.env, cwd, sink.out, sink.err) : revoke(argv, rig.env, cwd, sink.out, sink.err);
  return sink.run(status);
}

/** The report the CLI would print for hand-built views, keyed at ROOT's roots entry. */
const rendered = (views: CapabilityView[], root = '/work/satan', rootsEntry = root): string =>
  renderReport({ root, rootsEntry }, views);

// ── T1: the report is a pure render (EX-2, VT-3) ───────────────────────────

test('the report shows a capability identity, its approval state and the exact record command', () => {
  const form = usable('/nix/store/abc-quotient-write', '9f2c'.padEnd(64, '0'));
  const report = rendered([view({ observed: observed({ base: '/work/satan', probe: form }) })]);

  assert.ok(report.includes('root      /work/satan   (roots entry)'), report);
  assert.ok(report.includes('write     link      /work/satan/.quotient/forms/write'), report);
  assert.ok(report.includes('          resolves  /nix/store/abc-quotient-write'), report);
  assert.ok(report.includes(`          sha256    ${form.sha256}`), report);
  assert.ok(report.includes('          governed  no approval'), report);
  assert.ok(report.includes('          slot      confined, extensions []'), report);
  assert.ok(
    report.includes(`  quotient allow /work/satan write=/nix/store/abc-quotient-write@${form.sha256}`),
    report,
  );
});

test('the report names the machine form where a capability has no link, and its extensions where it has one', () => {
  const report = rendered([
    view({ capability: 'read', slot: confined('/nix/store/machine/bin/quotient-read', ['builtin:mcp']), observed: observed({ base: '/work/satan', probe: { kind: 'absent' } }) }),
  ]);

  assert.ok(report.includes('read      link      absent; machine form /nix/store/machine/bin/quotient-read'), report);
  assert.ok(report.includes('          governed  no approval'), report);
  assert.ok(report.includes('          slot      confined, extensions [builtin:mcp]'), report);
  assert.ok(report.includes('nothing to approve'), `an absent link suggests no command: ${report}`);
  assert.ok(!report.includes('quotient allow /work/satan read='), report);
});

test('the report shows an unusable link by its detail and leaves it out of the command', () => {
  const report = rendered([
    view({ observed: observed({ base: '/work/satan', probe: { kind: 'invalid', link: '/work/satan/.quotient/forms/write', detail: 'it is not executable' } }) }),
  ]);

  assert.ok(report.includes('write     link      unusable: it is not executable'), report);
  assert.ok(report.includes('nothing to approve'), report);
});

test('the report names the refusal admission would reach, from the same decision', () => {
  const unconfined: SlotSelection = { ok: true, form: { kind: 'unconfined', pi: '/nix/store/pi/bin/pi' } };
  const report = rendered([view({ slot: unconfined, observed: observed({ base: '/work/satan' }) })]);

  assert.ok(report.includes('admission calls at /work/satan are refused: form-invalid'), report);
  assert.ok(report.includes('nothing to approve: admission refuses these calls (form-invalid)'), report);
  assert.ok(!report.includes('quotient allow /work/satan write='), 'a refused capability is never suggested');
});

// ── T2: the report's two halves apart (RV-008 F-1, VT-3) ───────────────────

test('a shallower approval governs the report; its own link (adding revoke advice) and the candidate vary independently', () => {
  const shallower = approval({ root: '/work', path: '/nix/store/work/bin/quotient-write', sha256: 'b'.repeat(64) });
  const candidate = usable('/nix/store/satan/bin/quotient-write', 'c'.repeat(64), '/work/satan/.quotient/forms/write');
  const matching = usable(shallower.path, shallower.sha256, '/work/.quotient/forms/write');
  const view2 = (governingProbe: ProjectForm, candidateProbe: ProjectForm): CapabilityView =>
    view({ observed: observed({ governing: shallower, base: '/work', probe: governingProbe }), candidate: candidateProbe });

  const governed = rendered([view2(matching, candidate)]);
  const missing = rendered([view2({ kind: 'absent' }, candidate)]);
  const repointed = rendered([view2(matching, usable('/nix/store/other/bin/quotient-write', 'd'.repeat(64), candidate.link))]);

  // The governing half: a matching approval says nothing more; a missing link
  // says so and advises revoke, with the candidate's lines unchanged.
  assert.ok(governed.includes(`          governed  the approval for /work records ${shallower.path}@${shallower.sha256}`), governed);
  assert.ok(!governed.includes('advice'), governed);
  assert.ok(missing.includes(`          governed  the approval for /work records ${shallower.path}@${shallower.sha256}`), missing);
  assert.ok(missing.includes('its link /work/.quotient/forms/write is missing'), missing);
  assert.ok(missing.includes('          advice    quotient revoke /work'), missing);
  for (const line of ['          resolves  /nix/store/satan/bin/quotient-write', `  quotient allow /work/satan write=${candidate.path}@${candidate.sha256}`]) {
    assert.ok(missing.includes(line), `the candidate's half is unchanged: ${line}\n${missing}`);
  }

  // The candidate half: changing it moves its identity lines and the command,
  // and the governing status stays exactly as it was.
  const governedLine = `          governed  the approval for /work records ${shallower.path}@${shallower.sha256}`;
  assert.ok(repointed.includes(governedLine), repointed);
  assert.ok(repointed.includes(`          resolves  /nix/store/other/bin/quotient-write`), repointed);
  assert.ok(repointed.includes('  quotient allow /work/satan write=/nix/store/other/bin/quotient-write@'), repointed);
  assert.ok(!repointed.includes('/nix/store/satan/bin/quotient-write'), repointed);
});

// ── T3: `allow` reports what is there (EX-1, EX-2, VT-3) ────────────────────

/** The approvals the store at RIG holds, asserting it reads as a store. */
function stored(rig: Rig): Approval[] {
  const read = readApprovals(rigApprovalsPath(rig));
  assert.equal(read.ok, true, read.ok ? '' : read.detail);
  return read.approvals;
}

test('allow reports the roots entry\'s link and the machine form of a capability with none', (t) => {
  const rig = newRig(t);
  const form = rigForm(rig, 'approved');
  const link = plantProjectForm(rig, form);

  const run = verb('allow', [], rig);

  assert.equal(run.status, 0, run.err);
  assert.equal(run.err, '');
  assert.ok(run.out.includes(`root      ${rig.root}   (roots entry)`), run.out);
  assert.ok(run.out.includes(`write     link      ${link}`), run.out);
  assert.ok(run.out.includes(`          resolves  ${form.path}`), run.out);
  assert.ok(run.out.includes(`          sha256    ${form.sha256}`), run.out);
  assert.ok(run.out.includes('          governed  no approval'), run.out);
  assert.ok(run.out.includes(`read      link      absent; machine form ${rig.readLauncher}`), run.out);
  assert.ok(run.out.includes(`  quotient allow ${rig.root} write=${form.path}@${form.sha256}`), run.out);
  assert.ok(!run.out.includes(`quotient allow ${rig.root} read=`), 'an absent link is not suggested');
  assert.equal(existsSync(rigApprovalsPath(rig)), false, 'the report never writes');
});

test('allow refuses a path inside no roots entry, a path that is not there, and a policy it cannot read', (t) => {
  const rig = newRig(t);
  mkdirSync(join(rig.dir, 'elsewhere'));

  const outside = verb('allow', [join(rig.dir, 'elsewhere')], rig);
  assert.equal(outside.status, 1);
  assert.ok(outside.err.includes('not inside an allowlisted root'), outside.err);

  const missing = verb('allow', [join(rig.dir, 'no-such-directory')], rig);
  assert.equal(missing.status, 1);
  assert.ok(missing.err.includes('does not exist'), missing.err);

  // A relative path resolves against the working directory, the way a call does.
  const relative = verb('allow', ['elsewhere'], rig, rig.dir);
  assert.equal(relative.status, 1);
  assert.ok(relative.err.includes('elsewhere'), relative.err);

  rmSync(rig.policyPath);
  const unreadable = verb('allow', [], rig);
  assert.equal(unreadable.status, 1);
  assert.ok(unreadable.err.includes(rig.policyPath), unreadable.err);
});

test('allow reports what governs a root from a shallower approval, but records at the roots entry', (t) => {
  const rig = newRig(t);
  const deeper = join(rig.root, 'deeper');
  mkdirSync(deeper);
  // DEEPER is its own roots entry, so the roots entry and the governing approval
  // sit at different roots: the one case where the two lookups must differ.
  patchPolicy(rig, 'roots', [rig.root, deeper]);
  const parent = rigForm(rig, 'parent');
  const mine = rigForm(rig, 'mine');
  writeApprovals(rig, [{ root: rig.root, form: parent }]);
  plantProjectForm(rig, parent);
  plantProjectForm(rig, mine, { base: deeper });

  const run = verb('allow', [deeper], rig);

  assert.equal(run.status, 0, run.err);
  assert.ok(run.out.includes(`root      ${deeper}   (roots entry)`), run.out);
  assert.ok(run.out.includes(`          governed  the approval for ${rig.root} records ${parent.path}@${parent.sha256}`), run.out);
  assert.ok(!run.out.includes('advice'), 'the governing link still matches its approval');
  assert.ok(run.out.includes(`          resolves  ${mine.path}`), run.out);
  assert.ok(run.out.includes(`  quotient allow ${deeper} write=${mine.path}@${mine.sha256}`), run.out);

  // The report told the operator to record at the roots entry, so it must work
  // and store the approval under DEEPER, beside the parent's (which stays).
  const record = verb('allow', [deeper, `write=${mine.path}@${mine.sha256}`], rig);
  assert.equal(record.status, 0, record.err);
  assert.deepEqual(
    stored(rig).map((entry) => [entry.root, entry.path]),
    [[rig.root, parent.path], [deeper, mine.path]],
  );
});

test('allow reports a governing approval whose own link has gone, and advises revoke', (t) => {
  const rig = newRig(t);
  const deeper = join(rig.root, 'deeper');
  mkdirSync(deeper);
  // The roots entry is DEEPER, so the verdict is the governing approval's, not
  // the candidate's (RV-008 F-1).
  patchPolicy(rig, 'roots', [rig.root, deeper]);
  const parent = rigForm(rig, 'parent');
  writeApprovals(rig, [{ root: rig.root, form: parent }]);

  const run = verb('allow', [deeper], rig);

  assert.equal(run.status, 0, run.err);
  assert.ok(run.out.includes(`root      ${deeper}   (roots entry)`), run.out);
  assert.ok(run.out.includes(`its link ${rig.root}/.quotient/forms/write is missing`), run.out);
  assert.ok(run.out.includes(`advice    quotient revoke ${rig.root}`), run.out);
});

test('allow refuses a store it cannot read, naming it (A4)', (t) => {
  const rig = newRig(t);
  mkdirSync(join(rig.dir, 'config', 'quotient'), { recursive: true });
  const store = rigApprovalsPath(rig);
  writeFileSync(store, 'not json\n');

  const run = verb('allow', [], rig);

  assert.equal(run.status, 1);
  assert.ok(run.err.includes(store), run.err);
  assert.ok(run.err.includes('not valid JSON'), run.err);
});

test('the report says admission refuses these calls, instead of implying they are fine', (t) => {
  const rig = newRig(t);
  const form = rigForm(rig, 'approved');
  plantProjectForm(rig, form);
  patchPolicy(rig, 'forms', { read: rig.readLauncher, write: { unconfined: '/nix/store/pi/bin/pi' } });

  const run = verb('allow', [], rig);

  assert.equal(run.status, 0, run.err);
  assert.ok(run.out.includes(`admission calls at ${rig.root} are refused: form-invalid`), run.out);
  assert.ok(run.out.includes('nothing to approve: admission refuses these calls (form-invalid)'), run.out);
  assert.ok(!run.out.includes('quotient allow'), 'a refused capability contributes no command');
});

test('a deeper approval keeps governing: the report advises revoke and never prints an inert command', (t) => {
  const rig = newRig(t);
  const deeper = join(rig.root, 'deeper');
  mkdirSync(deeper);
  const form = rigForm(rig, 'approved');
  writeApprovals(rig, [{ root: deeper, form }]);
  plantProjectForm(rig, form, { base: deeper });
  const before = readFileSync(rigApprovalsPath(rig), 'utf8');

  const report = verb('allow', [deeper], rig);
  assert.equal(report.status, 0, report.err);
  assert.ok(report.out.includes(`root      ${rig.root}   (roots entry)`), report.out);
  assert.ok(report.out.includes(`the approval for ${deeper} governs calls at ${deeper}`), report.out);
  assert.ok(report.out.includes(`quotient revoke ${deeper}`), report.out);
  assert.ok(!report.out.includes(`quotient allow ${rig.root} write=`), 'the inert command is not printed');
  assert.ok(!report.out.includes('admission calls at'), 'the deeper approval still admits these calls');

  // Recording at the roots entry would change nothing while the deeper approval
  // governs, so it is refused rather than reported as a silent success.
  const record = verb('allow', [deeper, `write=${form.path}@${form.sha256}`], rig);
  assert.equal(record.status, 1, record.err);
  assert.ok(record.err.includes(`the approval for ${deeper} governs calls at ${deeper}`), record.err);
  assert.ok(record.err.includes(`quotient revoke ${deeper}`), record.err);
  assert.equal(readFileSync(rigApprovalsPath(rig), 'utf8'), before, 'nothing is written');
});

// ── T4: `allow` records only what was reviewed (EX-3, EX-4, VT-1, VT-2) ─────

test('allow records the reviewed identity at the roots entry, and a second record replaces it', (t) => {
  const rig = newRig(t);
  const first = rigForm(rig, 'first');
  const link = plantProjectForm(rig, first);
  mkdirSync(join(rig.root, 'sub'));

  // The cwd is inside the root, so the key proves it is the roots entry.
  const run = verb('allow', [rig.root, `write=${first.path}@${first.sha256}`], rig, join(rig.root, 'sub'));
  assert.equal(run.status, 0, run.err);
  assert.equal(run.out, `recorded write=${first.path}@${first.sha256} for ${rig.root}\n`);
  const [entry] = stored(rig);
  assert.deepEqual(
    { ...entry, approved_at: undefined },
    { root: rig.root, capability: 'write', path: first.path, sha256: first.sha256, approved_at: undefined },
  );
  assert.match(entry.approved_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, 'an ISO 8601 UTC timestamp');

  const second = rigForm(rig, 'second');
  rmSync(link);
  symlinkSync(second.path, link);
  const replaced = verb('allow', [rig.root, `write=${second.path}@${second.sha256}`], rig);
  assert.equal(replaced.status, 0, replaced.err);
  const after = stored(rig);
  assert.equal(after.length, 1, 'replacing a pair never adds a second entry');
  assert.equal(after[0].path, second.path);
});

test('the same bytes at another path after the review refuse to record, and leave the store byte-identical (RV-006 F-3)', (t) => {
  const rig = newRig(t);
  const reviewed = rigForm(rig, 'reviewed');
  const other = rigForm(rig, 'other');
  assert.equal(other.sha256, reviewed.sha256, 'the two forms hold identical bytes');
  const link = plantProjectForm(rig, reviewed);
  assert.equal(verb('allow', [rig.root, `write=${reviewed.path}@${reviewed.sha256}`], rig).status, 0);

  const before = readFileSync(rigApprovalsPath(rig), 'utf8');
  rmSync(link);
  symlinkSync(other.path, link);
  const run = verb('allow', [rig.root, `write=${reviewed.path}@${reviewed.sha256}`], rig);

  assert.equal(run.status, 1);
  assert.ok(run.err.includes(reviewed.path), run.err);
  assert.ok(run.err.includes(other.path), run.err);
  assert.ok(run.err.includes('nothing was recorded'), run.err);
  assert.equal(readFileSync(rigApprovalsPath(rig), 'utf8'), before, 'the store is byte-identical');
  assert.equal(stored(rig)[0].path, reviewed.path, 'the reviewed identity still governs');

  // The matching case records exactly the form that is there now, with these bytes.
  assert.equal(verb('allow', [rig.root, `write=${other.path}@${other.sha256}`], rig).status, 0);
  assert.deepEqual(stored(rig).map((entry) => [entry.path, entry.sha256]), [[other.path, other.sha256]]);
});

test('changed bytes refuse to record and write nothing', (t) => {
  const rig = newRig(t);
  const form = rigForm(rig, 'approved');
  plantProjectForm(rig, form);
  writeApprovals(rig, [{ form }]);
  const before = readFileSync(rigApprovalsPath(rig), 'utf8');
  const rebuilt = executableAt(form.path, '#!/usr/bin/env bash\nexit 0\n');

  const run = verb('allow', [rig.root, `write=${form.path}@${form.sha256}`], rig);

  assert.equal(run.status, 1);
  assert.ok(run.err.includes(form.sha256), run.err);
  assert.ok(run.err.includes(rebuilt.sha256), run.err);
  assert.equal(readFileSync(rigApprovalsPath(rig), 'utf8'), before);
});

test('one bad pair in a batch records none, and an unconfined slot or an absent link is refused', (t) => {
  const rig = newRig(t);
  const form = rigForm(rig, 'approved');

  const absent = verb('allow', [rig.root, `write=${form.path}@${form.sha256}`], rig);
  assert.equal(absent.status, 1);
  assert.ok(absent.err.includes('there is no form at'), absent.err);
  assert.equal(existsSync(rigApprovalsPath(rig)), false);

  const link = plantProjectForm(rig, form);
  const batch = verb('allow', [rig.root, `write=${form.path}@${form.sha256}`, `read=${form.path}@${form.sha256}`], rig);
  assert.equal(batch.status, 1);
  assert.ok(batch.err.includes('read'), batch.err);
  assert.equal(existsSync(rigApprovalsPath(rig)), false, 'a batch writes nothing when one pair fails');

  patchPolicy(rig, 'forms', { read: rig.readLauncher, write: { unconfined: '/nix/store/pi/bin/pi' } });
  const unconfined = verb('allow', [rig.root, `write=${form.path}@${form.sha256}`], rig);
  assert.equal(unconfined.status, 1);
  assert.ok(unconfined.err.includes('unconfined'), unconfined.err);
  assert.equal(existsSync(rigApprovalsPath(rig)), false);
  assert.ok(existsSync(link), 'nothing was moved');
});

test('a malformed identity argument exits 2', (t) => {
  const rig = newRig(t);
  const digest = 'a'.repeat(64);
  for (const argv of [
    [''],
    ['', `write=/nix/store/x@${digest}`],
    [`write=/nix/store/x@${digest}`],
    [rig.root, 'write'],
    [rig.root, `middle=/nix/store/x@${digest}`],
    [rig.root, 'write=/nix/store/x@not-a-digest'],
  ]) {
    const run = verb('allow', argv, rig);
    assert.equal(run.status, 2, `${argv.join(' ')}: ${run.err}`);
    assert.match(run.err, /^usage: quotient allow/m, run.err);
    assert.equal(run.out, '');
  }
});

test('a capability given twice in one record is a usage error naming it', (t) => {
  const rig = newRig(t);
  const form = rigForm(rig, 'approved');
  plantProjectForm(rig, form);
  const pair = `write=${form.path}@${form.sha256}`;

  const run = verb('allow', [rig.root, pair, pair], rig);

  assert.equal(run.status, 2, run.err);
  assert.ok(run.err.includes('write is given twice'), run.err);
  assert.match(run.err, /^usage: quotient allow/m);
  assert.equal(existsSync(rigApprovalsPath(rig)), false);
});

// ── T5: `quotient revoke` (EX-5, VT-4) ─────────────────────────────────────

/** The roots the store at RIG holds, in stored order. */
const storedRoots = (rig: Rig): string[] => stored(rig).map((entry) => entry.root);

test('revoke removes a stored root\'s entries, named or all, and never another root\'s', (t) => {
  const rig = newRig(t);
  const child = join(rig.root, 'child');
  const sibling = join(rig.dir, 'sibling');
  mkdirSync(child);
  mkdirSync(sibling);
  const form = rigForm(rig, 'approved');
  writeApprovals(rig, [
    { root: rig.root, capability: 'write', form },
    { root: rig.root, capability: 'read', form },
    { root: child, capability: 'write', form },
    { root: sibling, capability: 'write', form },
  ]);

  const named = verb('revoke', [child, 'write'], rig);
  assert.equal(named.status, 0, named.err);
  assert.equal(named.out, `revoked write for ${child}\n`);
  assert.deepEqual(storedRoots(rig), [rig.root, rig.root, sibling], 'revoking a child leaves the parent');

  const all = verb('revoke', [rig.root], rig);
  assert.equal(all.status, 0, all.err);
  assert.equal(all.out, `revoked write, read for ${rig.root}\n`);
  assert.deepEqual(storedRoots(rig), [sibling]);

  const twice = verb('revoke', [rig.root], rig);
  assert.equal(twice.status, 1);
  assert.ok(twice.err.includes(`no approval is recorded for ${rig.root}`), twice.err);
  assert.ok(twice.err.includes(`stored roots: ${sibling}`), twice.err);

  const unknownCapability = verb('revoke', [sibling, 'read'], rig);
  assert.equal(unknownCapability.status, 1);
  assert.ok(unknownCapability.err.includes(`no approval is recorded for read at ${sibling}`), unknownCapability.err);
  assert.deepEqual(storedRoots(rig), [sibling], 'a refused revoke removes nothing');
});

test('revoke addresses the stored root: relative arguments work, and a deleted root or a dropped roots entry is still revocable', (t) => {
  const rig = newRig(t);
  const form = rigForm(rig, 'approved');
  writeApprovals(rig, [{ root: rig.root, form }]);

  const relative = verb('revoke', ['.'], rig, rig.root);
  assert.equal(relative.status, 0, relative.err);
  assert.equal(relative.out, `revoked write for ${rig.root}\n`);

  writeApprovals(rig, [{ root: rig.root, form }]);
  patchPolicy(rig, 'roots', []);
  const withoutPolicy = verb('revoke', [rig.root], rig);
  assert.equal(withoutPolicy.status, 0, withoutPolicy.err);

  writeApprovals(rig, [{ root: rig.root, form }]);
  rmSync(rig.root, { recursive: true });
  const withoutDirectory = verb('revoke', [rig.root], rig);
  assert.equal(withoutDirectory.status, 0, withoutDirectory.err);
  assert.deepEqual(stored(rig), []);
});

test('revoke with no store refuses without creating one', (t) => {
  const rig = newRig(t);

  const run = verb('revoke', [rig.root], rig);

  assert.equal(run.status, 1, run.err);
  assert.ok(run.err.includes(`no approval is recorded for ${rig.root}`), run.err);
  assert.ok(run.err.includes('stored roots: none'), run.err);
  assert.equal(existsSync(rigApprovalsPath(rig)), false, 'no store is created');
  assert.equal(existsSync(`${rigApprovalsPath(rig)}.lock`), false, 'no lock is taken');
});

test('revoke refuses a malformed invocation and a store it cannot read', (t) => {
  const rig = newRig(t);
  for (const argv of [[], [rig.root, 'middle'], [rig.root, 'write', 'write']]) {
    const run = verb('revoke', argv, rig);
    assert.equal(run.status, 2, `${argv.join(' ')}: ${run.err}`);
    assert.match(run.err, /^usage: quotient revoke/m);
    if (argv.length === 3) {assert.ok(run.err.includes('write is given twice'), run.err);}
  }

  mkdirSync(join(rig.dir, 'config', 'quotient'), { recursive: true });
  const store = rigApprovalsPath(rig);
  writeFileSync(store, 'not json');
  const run = verb('revoke', [rig.root], rig);
  assert.equal(run.status, 1);
  assert.ok(run.err.includes(store), run.err);
  assert.equal(readFileSync(store, 'utf8'), 'not json', 'a malformed store is never overwritten');
});
