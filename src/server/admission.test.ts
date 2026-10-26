// Tests for admission: the ladder between a request and a run — steps 1-8, the
// `tools` narrowing and the ledger probe — decided without spawning anything and
// without a wire. `admit` is the seam the server's `callTool` will call, so every
// case here is a refusal a wire test sees the outside of, seen from inside, plus
// the two rules a wire test cannot see: each refusal but `audit-unavailable` is
// recorded in `attempts.jsonl`, and each refusal after step 7 gives the session
// lock back (so the session is not left busy by a call that ran nothing).
//
// The policy is read per call, so a case breaks it after the context is built;
// profiles and help are the start-up snapshots, so they are read once here, as
// `serve` reads them once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLocations } from '../config.ts';
import { loadHelp } from '../help/help.ts';
import { admit, type AdmissionContext } from './admission.ts';
import type { CallId } from './evidence.ts';
import { loadProfiles } from './profiles.ts';
import { readHostIdentity } from './session.ts';
import { attempts, newRig, patchPolicy, plantProjectForm, rigForm, type Rig } from './test-rig.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────

/** The context a call is decided from, built the way `serve` builds its own:
 *  the deployment's resolved locations, one profile and help snapshot, and this
 *  host's identity. The policy is deliberately absent: steps 1-2 read it. */
function contextFor(rig: Rig): AdmissionContext {
  const locations = resolveLocations(rig.env);
  const profiles = loadProfiles(locations.profileLayers);
  if (!profiles.ok) {assert.fail(`the rig's profiles do not load: ${profiles.path}: ${profiles.detail}`);}
  const help = loadHelp(locations.helpLayers);
  if (!help.ok) {assert.fail(`the rig's help does not load: ${help.path}: ${help.detail}`);}
  return {
    startup: { ok: true, profiles: profiles.snapshot, help: help.snapshot },
    locations,
    launchDir: rig.launchDir,
    procDir: '/proc',
    here: readHostIdentity('/proc'),
  };
}

/** One `attempts.jsonl` line as this suite reads it. */
type LedgerLine = { callId: unknown; reason: unknown; detail: unknown; digest: unknown };

/** The server-level ledger under the rig's run dir, as records. */
function ledger(rig: Rig): LedgerLine[] {
  return attempts(rig.runDir).map((raw): LedgerLine => ({
    callId: raw.call_id,
    reason: raw.reason,
    detail: raw.detail,
    digest: raw.policy_digest,
  }));
}

/** The digest of the policy bytes on disk now; absent when there is no file to
 *  hash, as the ledger leaves it absent. */
function policyDigest(rig: Rig): string | undefined {
  if (!existsSync(rig.policyPath)) {return undefined;}
  return createHash('sha256').update(readFileSync(rig.policyPath)).digest('hex');
}

/** The ledger lines one call left, in order. */
function ledgerFor(rig: Rig, callId: CallId): LedgerLine[] {
  return ledger(rig).filter((line) => line.callId === callId);
}

/** The reason a call refused with; an admitted call is a failed expectation. */
function refusalReason(result: ReturnType<typeof admit>): string {
  if (result.ok) {assert.fail(`expected a refusal, got an admitted call (session ${result.admitted.session.session})`);}
  return result.reason;
}

/** The request every case starts from: the rig's read profile, rooted at the rig. */
function validRequest(rig: Rig): { prompt: string; profile: string; cwd: string } {
  return { prompt: 'work', profile: 'read', cwd: rig.root };
}

/** A refusal recorded once, against the call: the reason, the same detail the
 *  caller is told, and the digest of the policy it was decided under. Steps
 *  1-2's line is `admitCall`'s, the rest `admit`'s: either way there is one. */
function refused(rig: Rig, result: ReturnType<typeof admit>, callId: CallId, reason: string): void {
  assert.equal(refusalReason(result), reason);
  const detail = result.ok ? undefined : result.detail;
  assert.ok(detail !== undefined && detail.length > 0, 'the refusal says which value decided it');
  assert.deepEqual(
    ledgerFor(rig, callId).map(({ reason: recorded, detail: said, digest }) => ({ reason: recorded, detail: said, digest })),
    [{ reason, detail, digest: policyDigest(rig) }],
    'the refusal is recorded once, against the call, as it was answered',
  );
}

// ── Steps 1-2: the policy ─────────────────────────────────────────────────

test('step 1: a policy file that is gone refuses policy-unavailable and records the attempt', (t) => {
  const rig = newRig(t);
  const context = contextFor(rig);
  unlinkSync(rig.policyPath);
  refused(rig, admit(validRequest(rig), context, 'c-1'), 'c-1', 'policy-unavailable');
});

test('step 2: a disabled policy refuses disabled and records the attempt', (t) => {
  const rig = newRig(t);
  patchPolicy(rig, 'enabled', false);
  refused(rig, admit(validRequest(rig), contextFor(rig), 'c-1'), 'c-1', 'disabled');
});

// ── Steps 3-6: the profile, the root, the form, the ceilings ──────────────

test('step 3: an unknown profile refuses profile-unknown and records the attempt', (t) => {
  const rig = newRig(t);
  const request = { ...validRequest(rig), profile: 'nope' };
  refused(rig, admit(request, contextFor(rig), 'c-1'), 'c-1', 'profile-unknown');
});

test('step 4: a cwd outside the policy roots refuses root-not-allowlisted and records the attempt', (t) => {
  const rig = newRig(t);
  // The launch dir is a real directory outside the rig's one allowlisted root.
  const request = { ...validRequest(rig), cwd: rig.launchDir };
  refused(rig, admit(request, contextFor(rig), 'c-1'), 'c-1', 'root-not-allowlisted');
});

test('step 5: a project form with no approval refuses form-unapproved and records the attempt', (t) => {
  const rig = newRig(t);
  plantProjectForm(rig, rigForm(rig, 'unapproved'));
  refused(rig, admit({ prompt: 'work', profile: 'write', cwd: rig.root }, contextFor(rig), 'c-1'), 'c-1', 'form-unapproved');
});

test('step 6: a ceiling above the policy maximum refuses ceiling-above-maximum', (t) => {
  const rig = newRig(t);
  // The rig's policy maxima are `validPolicy`'s: 20 requests, 100k context tokens,
  // $1.50 and 600 s. A call may lower any of them and none of them may rise.
  const request = { ...validRequest(rig), ceilings: { requests: 21 } };
  refused(rig, admit(request, contextFor(rig), 'c-1'), 'c-1', 'ceiling-above-maximum');
});

test('the tools narrowing: a tool outside the profile\'s set refuses tools-not-allowed', (t) => {
  const rig = newRig(t);
  // The read profile grants `read, grep, find, ls, bash`; `write` is not its to give.
  const request = { ...validRequest(rig), tools: ['write'] };
  refused(rig, admit(request, contextFor(rig), 'c-1'), 'c-1', 'tools-not-allowed');
});

test('first failure wins: an unknown profile is refused before a bad root, ceiling, tool or session', (t) => {
  const rig = newRig(t);
  const request = { prompt: 'work', profile: 'nope', cwd: rig.launchDir, ceilings: { requests: 21 }, tools: ['write'], session: '-not-a-session' };
  refused(rig, admit(request, contextFor(rig), 'c-1'), 'c-1', 'profile-unknown');
});

test('first failure wins: a bad root is refused before a ceiling, tool or session', (t) => {
  const rig = newRig(t);
  const request = { prompt: 'work', profile: 'read', cwd: rig.launchDir, ceilings: { requests: 21 }, tools: ['write'], session: '-not-a-session' };
  refused(rig, admit(request, contextFor(rig), 'c-1'), 'c-1', 'root-not-allowlisted');
});

test('first failure wins: a ceiling is refused before a tool or session, and a tool before a session', (t) => {
  const rig = newRig(t);
  const context = contextFor(rig);
  const request = { ...validRequest(rig), ceilings: { requests: 21 }, tools: ['write'], session: '-not-a-session' };
  refused(rig, admit(request, context, 'c-1'), 'c-1', 'ceiling-above-maximum');
  refused(rig, admit({ ...request, ceilings: undefined }, context, 'c-2'), 'c-2', 'tools-not-allowed');
});

// ── Step 7: the session ───────────────────────────────────────────────────

test('step 7: a session id outside the grammar refuses session-invalid and records the attempt', (t) => {
  const rig = newRig(t);
  const request = { ...validRequest(rig), session: '-not-a-session' };
  refused(rig, admit(request, contextFor(rig), 'c-1'), 'c-1', 'session-invalid');
});

test('step 7: a second admit for a session this one holds refuses session-busy', (t) => {
  const rig = newRig(t);
  const context = contextFor(rig);
  const first = admit(validRequest(rig), context, 'c-1');
  if (!first.ok) {assert.fail(`the first call was refused: ${first.reason}: ${first.detail}`);}
  const session = first.admitted.session.session;
  refused(rig, admit({ ...validRequest(rig), session }, context, 'c-2'), 'c-2', 'session-busy');
  first.admitted.session.release();
});

// ── Step 8 and the probe: the refusals that must give the lock back ───────

test('step 8: an exposure overlapping a protected store refuses view-overlaps-protected, and the refusal releases the session', (t) => {
  const rig = newRig(t);
  // The run dir is evidence: no exposure may reach it, and the policy naming it
  // is the overlap step 8 exists to refuse.
  patchPolicy(rig, 'exposure', [rig.runDir]);
  const context = contextFor(rig);
  const request = { ...validRequest(rig), session: 'step-eight-trial' };
  refused(rig, admit(request, context, 'c-1'), 'c-1', 'view-overlaps-protected');
  // Step 8 runs after the session was taken, so the refusal must have released
  // it: the same session is refused for the view again, not reported busy.
  assert.equal(
    refusalReason(admit(request, context, 'c-2')),
    'view-overlaps-protected',
    'the same session must not be left busy by a refusal after step 7',
  );
});

test('the probe: an unwritable ledger refuses audit-unavailable, and the refusal releases the session', (t) => {
  const rig = newRig(t);
  // `attempts.jsonl` is a directory, so the probe cannot open it for append.
  mkdirSync(join(rig.runDir, 'attempts.jsonl'), { recursive: true });
  const context = contextFor(rig);
  const request = { ...validRequest(rig), session: 'probe-trial' };
  assert.equal(refusalReason(admit(request, context, 'c-1')), 'audit-unavailable');
  // The ledger is the thing that failed, so nothing was appended to it — and no
  // run directory was allocated beside it.
  assert.deepEqual(readdirSync(rig.runDir), ['attempts.jsonl'], 'no line could be written, so none was');
  // The probe is after step 7 too: the lock is given back, so the answer is the
  // same refusal rather than session-busy.
  assert.equal(
    refusalReason(admit(request, context, 'c-2')),
    'audit-unavailable',
    'the same session must not be left busy by a pre-run failure',
  );
});

// ── Admission ─────────────────────────────────────────────────────────────

test('success: a valid request is admitted with the session still held, until the caller releases it', (t) => {
  const rig = newRig(t);
  const context = contextFor(rig);
  const first = admit(validRequest(rig), context, 'c-1');
  if (!first.ok) {assert.fail(`the call was refused: ${first.reason}: ${first.detail}`);}
  const admitted = first.admitted;

  assert.equal(admitted.root, realpathSync(rig.root), 'the admitted root is the canonical rig root');
  assert.equal(admitted.callId, 'c-1');
  assert.equal(admitted.policyPath, rig.policyPath);
  assert.equal(admitted.policyDigest.length, 64, 'the admitted call names the policy bytes it was decided under');
  assert.equal(admitted.runDir, rig.runDir);
  assert.equal(admitted.transcriptBudget, 4096, 'the policy maximum is the budget an absent request gets');
  assert.deepEqual(admitted.tools, ['read', 'grep', 'find', 'ls', 'bash'], "the profile's whole tool set, when the call narrows nothing");

  // The session is held for the caller: a second call for it is busy until the
  // first releases, and admitted again afterwards.
  const session = admitted.session.session;
  assert.equal(refusalReason(admit({ ...validRequest(rig), session }, context, 'c-2')), 'session-busy');
  admitted.session.release();
  const after = admit({ ...validRequest(rig), session }, context, 'c-3');
  if (!after.ok) {assert.fail(`a released session is admitted again, but was refused: ${after.reason}`);}
  after.admitted.session.release();
});
