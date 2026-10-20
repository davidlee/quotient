// The server-level evidence sinks. Design sec-6 names two: `attempts.jsonl` here
// (one line per attempt that spawned nothing) and the per-run directory laid out
// by `runLayout` under the same run dir.
//
// The attempts path is defined ONCE, in this module, so no writer invents a
// second location, and the per-run layout is defined once for the same reason:
// the child-view check consumes these paths rather than a bind list of its own.
// A refusal is evidence, and evidence that cannot be written is reported on
// stderr without changing the refusal the caller receives.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

/** The JSON-RPC id a call carried, or null when the call had none. */
export type CallId = string | number | null;

/**
 * A reclaim's audit trail (design sec-6, EX-8): the stale ownership record that
 * was replaced, the claim that serialised the reclaim, and the record installed
 * over `<lock>`. Recorded so a recovery is auditable after the fact rather than
 * inferred from a lock file's contents.
 */
export type ReclaimRecord = {
  /** The lock path that was replaced. */
  lock: string;
  /** The `<lock>.claim` the reclaimer won. */
  claim: string;
  /** The ownership record the successor replaced, verbatim. */
  stale: Record<string, unknown>;
  /** The ownership record the reclaimer installed. */
  successor: Record<string, unknown>;
};

/** One `attempts.jsonl` line: what was refused or failed, and why. */
export type AttemptRecord = {
  /** The JSON-RPC id of the call, verbatim. */
  callId: CallId;
  /** The refusal token, or the termination cause of a pre-spawn failure. */
  reason: string;
  detail: string;
  /** sha256 of the policy bytes; absent when nothing was readable. */
  policyDigest?: string | null;
  /** Present on a stale-lock reclaim: one line per reclaim, never inferred. */
  reclaim?: ReclaimRecord;
};

/** The server-level attempts ledger, under the operator's `PI_MCP_RUN_DIR`. */
export function attemptsPath(runDir: string): string {
  return join(runDir, 'attempts.jsonl');
}

/**
 * The five files one run's evidence directory holds (design sec-6, EX-5). They
 * are named once here so a reader, a writer and the child-view check cannot
 * disagree about the layout.
 */
export const RUN_EVIDENCE_FILES = {
  events: 'events.jsonl',
  stderr: 'stderr.log',
  transcript: 'transcript.md',
  status: 'status.json',
  audit: 'audit.jsonl',
} as const;

/** One run's evidence: its own directory and the five files inside it. */
export type RunLayout = {
  /** The run's directory, exactly one level under `PI_MCP_RUN_DIR`. */
  dir: string;
  events: string;
  stderr: string;
  transcript: string;
  status: string;
  audit: string;
};

/**
 * A run directory's name: a UTC stamp, the call id reduced to a safe component
 * and a fresh token. `../` and `/` cannot survive it, so a caller-controlled id
 * cannot name a path outside the run dir, and two calls never share a run.
 */
function runName(callId: CallId): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const id = String(callId ?? 'call')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32);
  const slug = id.length > 0 ? id : 'call';
  return `run-${stamp}-${slug}-${randomBytes(6).toString('hex')}`;
}

/**
 * Name one run's evidence directory and its five files (design sec-6, EX-5).
 * Pure naming: nothing is created here, because the run directory is allocated
 * only after validation step 8 and its allocation is PHASE-06's.
 */
export function runLayout(runDir: string, callId: CallId): RunLayout {
  const dir = join(runDir, runName(callId));
  return {
    dir,
    events: join(dir, RUN_EVIDENCE_FILES.events),
    stderr: join(dir, RUN_EVIDENCE_FILES.stderr),
    transcript: join(dir, RUN_EVIDENCE_FILES.transcript),
    status: join(dir, RUN_EVIDENCE_FILES.status),
    audit: join(dir, RUN_EVIDENCE_FILES.audit),
  };
}

/**
 * The server-owned evidence stores, as paths: the run dir every run's evidence
 * directory lives under, and the attempts ledger beside them. The child-view
 * check refuses a child view that reaches either (design sec-3).
 */
export type EvidenceStores = {
  /** `PI_MCP_RUN_DIR` itself. */
  runDir: string;
  /** `attemptsPath(runDir)` — the same ledger, named once. */
  attempts: string;
};

export function evidenceStores(runDir: string): EvidenceStores {
  return { runDir, attempts: attemptsPath(runDir) };
}

/**
 * Append one attempt. Never throws and never alters the caller's verdict: an
 * unwritable ledger is reported on stderr, because a refusal is still the answer
 * the client must receive (`audit-unavailable` is PHASE-06's token, not this
 * module's).
 */
export function appendAttempt(runDir: string | null, attempt: AttemptRecord): void {
  if (runDir === null) {
    process.stderr.write(`pi-mcp: not recording ${attempt.reason}: no absolute PI_MCP_RUN_DIR\n`);
    return;
  }
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    call_id: attempt.callId,
    reason: attempt.reason,
    detail: attempt.detail,
  };
  if (attempt.policyDigest !== undefined && attempt.policyDigest !== null) {
    line.policy_digest = attempt.policyDigest;
  }
  if (attempt.reclaim !== undefined) {
    line.reclaim = attempt.reclaim;
  }
  try {
    mkdirSync(runDir, { recursive: true });
    appendFileSync(attemptsPath(runDir), `${JSON.stringify(line)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pi-mcp: could not append ${attemptsPath(runDir)}: ${message}\n`);
  }
}

/** sha256 hex over the policy bytes as read — the audit's identity for the file. */
export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
