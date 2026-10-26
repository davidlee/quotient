// The server-level evidence sinks. Design sec-6 names two: `attempts.jsonl` here
// (one line per attempt that spawned nothing) and the per-run directory laid out
// by `runLayout` under the same run dir.
//
// The attempts path is defined ONCE, in this module, so no writer invents a
// second location, and the per-run layout is defined once for the same reason:
// the child-view check consumes these paths rather than a bind list of its own.
// A refusal is evidence, and evidence that cannot be written is reported on
// stderr without changing the refusal the caller receives.
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isRecord } from '../json.ts';
import { absent } from './paths.ts';
import { isAgentResult, type AgentResult } from './result.ts';

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

/** The server-level attempts ledger, under the operator's `QUOTIENT_RUN_DIR`. */
export function attemptsPath(runDir: string): string {
  return join(runDir, 'attempts.jsonl');
}

/**
 * The six files one run's evidence directory holds (design sec-6, EX-5). They
 * are named once here so a reader, a writer and the child-view check cannot
 * disagree about the layout.
 */
export const RUN_EVIDENCE_FILES = {
  events: 'events.jsonl',
  stderr: 'stderr.log',
  transcript: 'transcript.md',
  status: 'status.json',
  audit: 'audit.jsonl',
  result: 'result.json',
} as const;

/** One run's evidence: its own directory and the six files inside it. */
export type RunLayout = {
  /** The run's directory, exactly one level under `QUOTIENT_RUN_DIR`. */
  dir: string;
  events: string;
  stderr: string;
  transcript: string;
  status: string;
  audit: string;
  /** The run's `pi-agent-result/2` document, landed by a rename (sec-7). */
  result: string;
};

/**
 * The one grammar a run directory's name obeys (design sec-7): a UTC stamp, a
 * safe slug and a 12-hex token. A name outside it names no run, so a reader
 * consults a run directory only through a name it can prove was minted here.
 */
export const RUN_NAME_GRAMMAR = /^run-[0-9TZ]+-[A-Za-z0-9_-]{1,32}-[0-9a-f]{12}$/;

/**
 * A run directory's name: a UTC stamp, the call id reduced to a safe component
 * and a fresh token. `../` and `/` cannot survive it, so a caller-controlled id
 * cannot name a path outside the run dir, and two calls never share a run.
 */
export function runName(callId: CallId): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const id = String(callId ?? 'call')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32);
  const slug = id.length > 0 ? id : 'call';
  return `run-${stamp}-${slug}-${randomBytes(6).toString('hex')}`;
}

/**
 * Name one run's evidence directory and its six files (design sec-7). Pure
 * naming: nothing is created here, because the run directory is allocated only
 * after validation step 8 and its allocation is PHASE-06's.
 */
export function layoutFor(runDir: string, run: string): RunLayout {
  const dir = join(runDir, run);
  return {
    dir,
    events: join(dir, RUN_EVIDENCE_FILES.events),
    stderr: join(dir, RUN_EVIDENCE_FILES.stderr),
    transcript: join(dir, RUN_EVIDENCE_FILES.transcript),
    status: join(dir, RUN_EVIDENCE_FILES.status),
    audit: join(dir, RUN_EVIDENCE_FILES.audit),
    result: join(dir, RUN_EVIDENCE_FILES.result),
  };
}

/** One run's layout, named from the call it answers (design sec-7). */
export function runLayout(runDir: string, callId: CallId): RunLayout {
  return layoutFor(runDir, runName(callId));
}

/**
 * The server-owned evidence stores, as paths: the run dir every run's evidence
 * directory lives under, and the attempts ledger beside them. The child-view
 * check refuses a child view that reaches either (design sec-3).
 */
export type EvidenceStores = {
  /** `QUOTIENT_RUN_DIR` itself. */
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
 * the client must receive. The boolean says whether the line landed, which is
 * what an `audit-unavailable` decision is made of (PHASE-06); the callers that
 * only record a refusal they have already decided ignore it.
 */
export function appendAttempt(runDir: string | null, attempt: AttemptRecord): boolean {
  if (runDir === null) {
    process.stderr.write(`quotient: not recording ${attempt.reason}: no usable run dir\n`);
    return false;
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
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`quotient: could not append ${attemptsPath(runDir)}: ${message}\n`);
    return false;
  }
}

/**
 * Whether the server-level ledger can be appended to at all: open-append-close,
 * no line written, so the probe leaves `attempts.jsonl` exactly as it found it.
 * A run whose refusals could not be recorded must not start (design sec-6's
 * `audit-unavailable`).
 */
export function writeAttemptProbe(runDir: string): boolean {
  const ledger = attemptsPath(runDir);
  try {
    mkdirSync(runDir, { recursive: true });
    closeSync(openSync(ledger, 'a'));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`quotient: ${ledger} cannot be appended to: ${message}\n`);
    return false;
  }
}

/** The control decisions a run's audit records (design sec-6, sec-7). */
export type AuditKind =
  | 'spawn'
  | 'abort'
  | 'exit'
  | 'admitted'
  | 'refused'
  | 'cancelled'
  | 'dropped'
  | 'lost';

/**
 * One `<run>/audit.jsonl` line. A record rather than a closed union: the phases
 * that add causes (PHASE-07's gate) add fields, not new files, and the audit is
 * read by an operator rather than by a parser that would need the union.
 */
export type AuditRecord = Record<string, unknown> & { record: AuditKind };

/**
 * The file at PATH may end mid-record: its last byte is not a newline, or it
 * could not be inspected. Only absence proves there is nothing to step over; an
 * unneeded newline costs a blank line, which a reader skips.
 */
function mayEndMidLine(path: string): boolean {
  try {
    const fd = openSync(path, 'r');
    try {
      const { size } = fstatSync(fd);
      if (size === 0) {return false;}
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return !absent(path, error);
  }
}

/**
 * Append one control decision to a run's audit and report the `ts` it wrote, or
 * null when nothing landed. An audit that cannot be written fails the run closed
 * (design sec-6): the caller decides what that means before spawn (a refusal, the
 * directory discarded) and after (an `audit_failed` state), so this function only
 * reports the fact. A record whose predecessor ended mid-line is prefixed with a
 * newline in the same append, so a torn write never glues two records together
 * (design sec-7); one writer per run, so there is no race here.
 */
export function appendAudit(layout: RunLayout, record: AuditRecord): string | null {
  const ts = new Date().toISOString();
  try {
    mkdirSync(layout.dir, { recursive: true });
    const lead = mayEndMidLine(layout.audit) ? '\n' : '';
    // The server stamps the record: `ts` leads the line and a caller's cannot replace it.
    const line = { ts, ...record };
    line.ts = ts;
    appendFileSync(layout.audit, `${lead}${JSON.stringify(line)}\n`);
    return ts;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`quotient: could not append ${layout.audit}: ${message}\n`);
    return null;
  }
}

/** TEXT parsed as JSON and accepted by IS, or null when it is neither — or when
 *  either throws: a reader of untrusted bytes answers, it does not throw. */
function parseAs<T>(text: string, is: (value: unknown) => value is T): T | null {
  try {
    const value: unknown = JSON.parse(text);
    return is(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * VALUE is a non-null, non-array object carrying a string `record`. That field is
 * the only member the trail claims on: the audit is read by an operator rather
 * than by a closed-union parser, so a kind this build does not name is still a
 * record, not a torn line.
 */
function isAuditRecord(value: unknown): value is AuditRecord {
  return isRecord(value) && typeof value.record === 'string';
}

/**
 * Read a run's audit (design sec-7). A line that does not parse, or parses to
 * something that is not a record, is skipped and marks the trail torn — a reader
 * learns that the evidence has a hole rather than silently losing a record. An
 * audit that cannot be read at all is null: the run left no trail.
 */
export function readAudit(layout: RunLayout): { records: AuditRecord[]; torn: boolean } | null {
  let text: string;
  try {
    text = readFileSync(layout.audit, 'utf8');
  } catch {
    return null;
  }
  const records: AuditRecord[] = [];
  let torn = false;
  for (const line of text.split('\n')) {
    if (line.length === 0) {continue;}
    const record = parseAs(line, isAuditRecord);
    if (record !== null) {
      records.push(record);
      continue;
    }
    torn = true;
    process.stderr.write(`quotient: skipped a torn line in ${layout.audit}\n`);
  }
  return { records, torn };
}

/** The temp the result is written to before it is renamed into place (sec-7). */
const RESULT_TMP = '.result.json.tmp';

/**
 * Land one run's result document (design sec-7). The document is written to a
 * temp inside the run directory, timed, then renamed over `result.json`: a reader
 * never sees a partial document, and a failure before the rename leaves no
 * residue. Null means no `result.json` was written. Once the rename lands the
 * answer is the time, never null: a rename keeps the mtime read before it.
 */
export function writeResult(layout: RunLayout, document: AgentResult): string | null {
  const tmp = join(layout.dir, RESULT_TMP);
  try {
    mkdirSync(layout.dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`);
    const writtenAt = statSync(tmp).mtime.toISOString();
    renameSync(tmp, layout.result);
    return writtenAt;
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best-effort: a temp that cannot be removed is not the caller's problem.
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`quotient: could not write ${layout.result}: ${message}\n`);
    return null;
  }
}

/**
 * Read a run's result (design sec-7). Only absence is evidence that no result was
 * written: `absent` when there is no entry at all, `unreadable` for everything else that
 * stops the document being a conforming `pi-agent-result/2`. The document and the
 * moment it landed come back together, so a reader can judge both.
 */
export function readResult(
  layout: RunLayout,
): { found: AgentResult; writtenAt: string } | 'absent' | 'unreadable' {
  let text: string;
  try {
    text = readFileSync(layout.result, 'utf8');
  } catch (error) {
    return absent(layout.result, error) ? 'absent' : 'unreadable';
  }
  const found = parseAs(text, isAgentResult);
  if (found === null) {return 'unreadable';}
  try {
    return { found, writtenAt: statSync(layout.result).mtime.toISOString() };
  } catch {
    return 'unreadable';
  }
}

/**
 * Discard a run directory: nothing ran in it, so its evidence would be a run that
 * never happened. Best-effort — a directory that cannot be removed is reported
 * on stderr, and the caller has already decided to refuse.
 */
export function removeRun(layout: RunLayout): void {
  try {
    rmSync(layout.dir, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`quotient: could not discard ${layout.dir}: ${message}\n`);
  }
}

/** sha256 hex over the policy bytes as read — the audit's identity for the file. */
export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
