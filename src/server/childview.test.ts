// Tests for the child-view disjointness check (design sec-2 step 8 and sec-3's
// "Child-view disjointness") and for the one evidence layout it consumes
// (sec-6 "Evidence").
//
// Every case builds its own temp tree: the run dir, the session home and the
// policy file are siblings under one directory — the deployment the design
// describes — while the child's root sits wherever the case needs it. Nothing
// reads the ambient environment and nothing is spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { canonicalPath, checkChildView, protectedStores, within } from './childview.ts';
import type { ChildViewInput } from './childview.ts';
import { RUN_EVIDENCE_FILES, attemptsPath, evidenceStores, runLayout } from './evidence.ts';
import { serve } from './server.ts';

const REPO_ROOT = realpathSync(new URL('../..', import.meta.url).pathname);

type Tree = {
  /** The operator's state directory: the run dir, the session home and the policy. */
  state: string;
  /** `PI_MCP_RUN_DIR`. */
  runDir: string;
  /** `PI_MCP_SESSION_HOME`. */
  sessionHome: string;
  policyPath: string;
  /** The active session directory, as step 7 would lay it out (not created). */
  session: string;
  /** Another session's directory: exactly what the store protects. */
  otherSession: string;
  /** A directory the child may be rooted at, disjoint from the stores. */
  work: string;
};

function tree(): Tree {
  const state = mkdtempSync(join(tmpdir(), 'pi-mcp-childview-'));
  const runDir = join(state, 'evidence');
  const sessionHome = join(state, 'sessions');
  const policyPath = join(state, 'policy.json');
  const work = join(state, 'work');
  for (const dir of [runDir, sessionHome, work]) mkdirSync(dir, { recursive: true });
  writeFileSync(policyPath, JSON.stringify({ mode: 'per-call' }));
  return {
    state,
    runDir,
    sessionHome,
    policyPath,
    session: join(sessionHome, 'sess-a'),
    otherSession: join(sessionHome, 'sess-b'),
    work,
  };
}

/** The child view over `tree`, with the case's overrides. */
function view(t: Tree, overrides: Partial<ChildViewInput> = {}): ChildViewInput {
  return {
    root: t.work,
    capability: 'read',
    sessionDir: t.session,
    childBinds: [],
    sessionHome: t.sessionHome,
    runDir: t.runDir,
    policyPath: t.policyPath,
    ...overrides,
  };
}

/** The refusal's detail, for a check that must fail. */
function refusal(check: ReturnType<typeof checkChildView>): string {
  assert.equal(check.ok, false, 'the view must be refused');
  if (check.ok) throw new Error('unreachable');
  assert.equal(check.reason, 'view-overlaps-protected');
  return check.detail;
}

// ── Canonicalisation and containment (A2, DEC-095) ─────────────────────────

test('canonicalPath resolves through the longest existing ancestor, so a store that does not exist yet is canonical too (A2)', () => {
  const t = tree();
  // A symlinked ancestor with a tail that does not exist: the run dir and the
  // session home may be absent at check time, and a lexical comparison would
  // let the link's real target through.
  const link = join(t.state, 'link');
  symlinkSync(t.work, link);
  assert.equal(canonicalPath(join(link, 'not', 'yet')), join(realpathSync(t.work), 'not', 'yet'));
  // Nothing exists at all: the lexical form, which matches nothing on disk.
  assert.equal(canonicalPath('/no/such/pi-mcp-path'), '/no/such/pi-mcp-path');
});

test('containment is by path components: /work/one does not contain /work/one-2 (DEC-095)', () => {
  const t = tree();
  const one = join(t.state, 'one');
  const oneTwo = join(t.state, 'one-2');
  mkdirSync(one);
  mkdirSync(oneTwo);

  assert.equal(within(one, one), true);
  assert.equal(within(one, join(one, 'below')), true);
  assert.equal(within(one, oneTwo), false, 'a string prefix is not containment');
  assert.equal(within(oneTwo, one), false);

  // The check agrees: a root that merely shares a prefix with a store's parent
  // exposes nothing.
  const admitted = checkChildView(
    view(t, { root: one, capability: 'write', runDir: join(oneTwo, 'evidence') }),
  );
  assert.deepEqual(admitted, { ok: true });
});

// ── The alias case (EX-1, RV-043 F-1) ──────────────────────────────────────

test('a root containing the run evidence directory refuses view-overlaps-protected for a read and for a write capability (EX-1)', () => {
  const t = tree();
  const member = realpathSync(t.state);
  const store = realpathSync(t.runDir);

  for (const capability of ['read', 'write'] as const) {
    const detail = refusal(checkChildView(view(t, { root: t.state, capability })));
    assert.ok(detail.includes(JSON.stringify(member)), `the overlapping member is named: ${detail}`);
    assert.ok(detail.includes(JSON.stringify(store)), `the protected evidence directory is named: ${detail}`);
  }
});

test('a root that is the run evidence directory itself, or one of the run directories under it, refuses (EX-1)', () => {
  const t = tree();
  const store = realpathSync(t.runDir);

  const exact = refusal(checkChildView(view(t, { root: t.runDir, capability: 'write' })));
  assert.ok(exact.includes(JSON.stringify(store)));

  // The evidence store is every run's directory: a mount of one run's directory
  // lies inside it.
  const runDirectory = runLayout(t.runDir, 7).dir;
  mkdirSync(runDirectory, { recursive: true });
  const inside = refusal(checkChildView(view(t, { root: runDirectory, capability: 'read' })));
  assert.ok(inside.includes(JSON.stringify(store)));
});

// ── The protected stores (A3, EX-5: the layout, not a bind list) ───────────

test('the protected stores come from the evidence layout: the run evidence and the attempts ledger unreachable, the policy file never-writable, the session home unreachable (A3)', () => {
  const t = tree();
  const stores = protectedStores(view(t));
  assert.deepEqual(
    stores.map((store) => store.kind),
    ['run-evidence', 'attempts-ledger', 'session-home', 'policy-file'],
  );
  const byKind = new Map(stores.map((store) => [store.kind, store]));
  assert.equal(byKind.get('run-evidence')?.path, realpathSync(t.runDir));
  assert.equal(byKind.get('run-evidence')?.tolerance, 'unreachable');
  assert.equal(byKind.get('attempts-ledger')?.path, attemptsPath(realpathSync(t.runDir)));
  assert.equal(byKind.get('attempts-ledger')?.tolerance, 'unreachable');
  assert.equal(byKind.get('session-home')?.path, realpathSync(t.sessionHome));
  assert.equal(byKind.get('session-home')?.tolerance, 'unreachable');
  assert.equal(byKind.get('session-home')?.except, join(realpathSync(t.sessionHome), 'sess-a'));
  assert.equal(byKind.get('policy-file')?.path, realpathSync(t.policyPath));
  assert.equal(byKind.get('policy-file')?.tolerance, 'never-writable');
  // The tracked profile documents are not a store at all (design sec-3), so the
  // list has no entry for the checkout and no caller-supplied bind list.
  assert.equal(stores.length, 4);
});

// ── The session home (EX-2) ────────────────────────────────────────────────

test('the session home minus the active session directory, and the lock/binding metadata, are unreachable (EX-2)', () => {
  const t = tree();

  // A root that is an ancestor of the home, with the evidence store elsewhere.
  const childRoot = join(t.state, 'child-root');
  const home = join(childRoot, 'sessions');
  mkdirSync(home, { recursive: true });
  const aside = {
    sessionDir: join(home, 'sess-a'),
    sessionHome: home,
    runDir: t.runDir,
    policyPath: t.policyPath,
  };
  const rootDetail = refusal(checkChildView({ ...aside, root: childRoot, capability: 'read', childBinds: [] }));
  assert.ok(rootDetail.includes(JSON.stringify(realpathSync(childRoot))), rootDetail);
  assert.ok(rootDetail.includes(JSON.stringify(realpathSync(home))), rootDetail);

  // A fixed mount that contains the home exposes it just as surely.
  const bindDetail = refusal(
    checkChildView({ ...aside, root: t.work, capability: 'read', childBinds: [childRoot] }),
  );
  assert.ok(bindDetail.includes(JSON.stringify(realpathSync(home))), bindDetail);

  // The metadata directory holds the locks and bindings; another session's
  // directory holds that session's conversation. Neither is this call's.
  for (const member of [join(t.sessionHome, 'sessions'), t.otherSession, t.sessionHome]) {
    const detail = refusal(checkChildView(view(t, { childBinds: [member] })));
    assert.ok(detail.includes(JSON.stringify(realpathSync(t.sessionHome))), detail);
  }

  // The active session directory is the one session path the child is meant to
  // have — and is exempt even though it lies inside the home.
  assert.deepEqual(checkChildView(view(t, { childBinds: [t.session] })), { ok: true });
  assert.deepEqual(checkChildView(view(t, { childBinds: [join(t.session, 'state')] })), { ok: true });
});

// ── The policy file (EX-3) ─────────────────────────────────────────────────

test('the policy file is never writable: a write root containing it refuses, a read root containing it is allowed (EX-3)', () => {
  const t = tree();
  const authority = join(t.state, 'authority');
  const policyPath = join(authority, 'policy.json');
  mkdirSync(authority, { recursive: true });
  writeFileSync(policyPath, JSON.stringify({ mode: 'per-call' }));

  const shared = {
    root: authority,
    sessionDir: t.session,
    childBinds: [] as string[],
    sessionHome: t.sessionHome,
    runDir: t.runDir,
    policyPath,
  };

  const detail = refusal(checkChildView({ ...shared, capability: 'write' }));
  assert.ok(detail.includes(JSON.stringify(realpathSync(authority))), detail);
  assert.ok(detail.includes(JSON.stringify(realpathSync(policyPath))), detail);

  // Reading the policy is tolerated: it governs other calls, it is not a secret.
  assert.deepEqual(checkChildView({ ...shared, capability: 'read' }), { ok: true });

  // Every fixed child mount is writable (A1), so naming the policy file as one
  // is a writable exposure whatever the root's capability.
  const bindDetail = refusal(
    checkChildView({ ...shared, root: t.work, capability: 'read', childBinds: [policyPath] }),
  );
  assert.ok(bindDetail.includes(JSON.stringify(realpathSync(policyPath))), bindDetail);
});

// ── The tracked profile documents (EX-4) ───────────────────────────────────

test('the tracked profile documents are not protected as a store: a write root containing the checkout is legal (EX-4)', () => {
  const t = tree();
  // The repo-rooted writer: the documents it may edit are source, and the live
  // authority is the start-up snapshot (design sec-3, "Profiles are live
  // authority"), so protecting the checkout would kill the use case and buy
  // nothing.
  assert.deepEqual(checkChildView(view(t, { root: REPO_ROOT, capability: 'write' })), { ok: true });
  // …and the case is not vacuous: the documents really are inside that root.
  const documents = join(REPO_ROOT, 'pi', 'mcp', 'profiles');
  assert.equal(existsSync(documents), true);
  assert.equal(within(REPO_ROOT, documents), true);
});

// ── child_binds are part of the view (VT-3, EX-2) ──────────────────────────

test('a child_bind is part of the child view: a fixed mount exposing a protected store refuses (VT-3)', () => {
  const t = tree();
  const store = realpathSync(t.runDir);

  for (const member of [t.runDir, runLayout(t.runDir, 11).dir, attemptsPath(t.runDir)]) {
    const detail = refusal(checkChildView(view(t, { childBinds: [member] })));
    assert.ok(detail.includes(JSON.stringify(store)), detail);
  }

  // The fixed mounts that expose nothing are admitted, so the check is not a
  // blanket refusal of `child_binds`.
  assert.deepEqual(checkChildView(view(t, { childBinds: [join(t.state, 'dot-pi')] })), { ok: true });
});

// ── The one evidence layout (EX-5, VT-4) ───────────────────────────────────

test('the evidence layout is one directory per run under the run dir with its five files, plus attempts.jsonl at the run-dir root (EX-5)', () => {
  const t = tree();
  const layout = runLayout(t.runDir, 42);

  assert.equal(dirname(layout.dir), t.runDir, 'one level under the run dir');
  assert.equal(layout.events, join(layout.dir, 'events.jsonl'));
  assert.equal(layout.stderr, join(layout.dir, 'stderr.log'));
  assert.equal(layout.transcript, join(layout.dir, 'transcript.md'));
  assert.equal(layout.status, join(layout.dir, 'status.json'));
  assert.equal(layout.audit, join(layout.dir, 'audit.jsonl'));
  assert.deepEqual(Object.values(RUN_EVIDENCE_FILES).sort(), [
    'audit.jsonl',
    'events.jsonl',
    'status.json',
    'stderr.log',
    'transcript.md',
  ]);

  // One layout, one definition: the ledger is the run-dir-level attempts.jsonl
  // PHASE-02 fixed, and the check consumes those same paths rather than a bind
  // list of its own.
  assert.equal(attemptsPath(t.runDir), join(t.runDir, 'attempts.jsonl'));
  assert.deepEqual(evidenceStores(t.runDir), {
    runDir: t.runDir,
    attempts: join(t.runDir, 'attempts.jsonl'),
  });
  assert.deepEqual(Object.keys(evidenceStores(t.runDir)).sort(), ['attempts', 'runDir']);

  // Naming a run allocates nothing: PHASE-06 creates the directory.
  assert.equal(existsSync(layout.dir), false);
});

test('a run directory name is one safe path component, and every call gets a fresh one (EX-5)', () => {
  const t = tree();
  for (const callId of [42, 'call-7', null, '../../etc/passwd', '0']) {
    const layout = runLayout(t.runDir, callId);
    const name = basename(layout.dir);
    assert.equal(dirname(layout.dir), t.runDir);
    assert.equal(name.includes('/'), false);
    assert.equal(name.includes('..'), false);
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  }
  // Two calls never share a directory, even in the same millisecond with the
  // same id, so a run's evidence is never another run's.
  assert.notEqual(runLayout(t.runDir, 7).dir, runLayout(t.runDir, 7).dir);
});

// ── Refusal, never a mask (EX-6) ───────────────────────────────────────────

test('a refusal names the overlapping member and the protected path, and the admitted answer carries nothing else (EX-6)', () => {
  const t = tree();
  const detail = refusal(checkChildView(view(t, { root: t.state, capability: 'write' })));
  assert.ok(detail.includes(JSON.stringify(realpathSync(t.state))), 'the member is named');
  assert.ok(detail.includes(JSON.stringify(realpathSync(t.runDir))), 'the protected path is named');

  // Refusal, never a mask: an admitted view answers `ok` and nothing else, so no
  // caller can mistake this module for a producer of confinement arguments.
  assert.deepEqual(checkChildView(view(t)), { ok: true });
});

test('a view with two overlapping members names the same one every run (EX-6)', () => {
  const t = tree();
  const first = checkChildView(view(t, { root: t.state, capability: 'write', childBinds: [t.sessionHome] }));
  const second = checkChildView(view(t, { root: t.state, capability: 'write', childBinds: [t.sessionHome] }));
  assert.deepEqual(first, second);
  // The root is the first member checked, so the larger exposure is the one named.
  assert.ok(refusal(first).includes(JSON.stringify(realpathSync(t.state))));
});

// ── Step 8 in the call path (EX-1: refused before spawn) ───────────────────

test('validation step 8 precedes the seam: the refusal reaches the caller as a tool result and in attempts.jsonl (EX-1)', async () => {
  const t = tree();
  const policyPath = join(t.state, 'policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      mode: 'per-call',
      roots: [t.state],
      maxima: { requests: 20, tokens: 100000, cost_usd: 1.5, wall_clock_s: 600 },
      profiles: ['read', 'write'],
      forms: { read: '/nix/store/aaa/bin/pi-mcp-read', write: '/nix/store/aaa/bin/pi-mcp-write' },
      child_binds: [],
      enabled: true,
    }),
  );
  const env = {
    PI_MCP_POLICY: policyPath,
    PI_MCP_RUN_DIR: t.runDir,
    PI_MCP_SESSION_HOME: t.sessionHome,
  };

  for (const profile of ['read', 'write']) {
    const replies: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        replies.push(String(chunk));
        done();
      },
    });
    const input = Readable.from([
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'pi_agent', arguments: { prompt: 'hi', profile, cwd: t.state } },
      })}\n`,
    ]);
    await serve(input, output, env, new Writable({ write: (_chunk, _encoding, done) => done() }));

    const reply = JSON.parse(replies.join('').trim()) as Record<string, any>;
    assert.equal(reply.error, undefined);
    assert.equal(reply.result.isError, true);
    const doc = JSON.parse(reply.result.content[0].text) as Record<string, any>;
    assert.equal(doc.state, 'refused');
    assert.equal(doc.refusal.reason, 'view-overlaps-protected');
    assert.ok(String(doc.refusal.detail).includes(JSON.stringify(realpathSync(t.runDir))));
  }

  // Both refusals are evidence in the server-level ledger, and no run directory
  // was allocated for either: PHASE-06 allocates one, after step 8.
  const lines = readFileSync(attemptsPath(t.runDir), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => line.reason),
    ['view-overlaps-protected', 'view-overlaps-protected'],
  );
  assert.deepEqual(readdirSync(t.runDir), ['attempts.jsonl']);
});
