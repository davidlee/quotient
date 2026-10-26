// The run: the ladder's outcome, the evidence and the run's result.
//
// Everything here happened after admission decided that this call MAY run: the
// gate is built over the clamped ceilings, the launcher is spawned, the ladder
// owns the ending, and the evidence directory is the only place the outcome is
// recorded. Only a published run reaches this module.
//
// `executeRun` never throws and never releases the session: the caller holds the
// lock and releases it after this resolves (design sec-4, sec-6).
import { writeFileSync } from 'node:fs';
import type { Writable } from 'node:stream';
import { EMPTY_STATUS, reduce, type Reduced } from '../reduce/reduce.ts';
import type { Admitted } from './admission.ts';
import { appendAttempt, type RunLayout } from './evidence.ts';
import { createGate, type Gate } from './gate.ts';
import { createLatch, failedResult, refusedResult, resultFor, type AgentResult } from './result.ts';
import { runChild, type RunOutcome, type SpawnPlan } from './spawn.ts';

/** What the run reads from the server's own start-up and its options. */
export type ExecuteDeps = {
  env: Record<string, string | undefined>;
  graceMs: number;
  gateIdleMs: number;
  diagnostics: Writable;
  profileDigest: string;
  helpDigest: string;
};

/** Write the run's reduced transcript and status beside the stream they came
 *  from. An evidence write that fails is reported as a failed append: a run whose
 *  own evidence cannot be written must not be answered as a clean success. */
function writeRunFiles(layout: RunLayout, reduced: Reduced): boolean {
  try {
    writeFileSync(layout.transcript, reduced.transcript);
    writeFileSync(layout.status, `${JSON.stringify(reduced.status, null, 2)}\n`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`quotient: could not write ${layout.transcript} / ${layout.status}: ${message}\n`);
    return false;
  }
}

/** What the spawn consumes, exactly as admission decided it. */
const spawnPlan = (admitted: Admitted, layout: RunLayout, deps: ExecuteDeps): SpawnPlan => ({
  form: admitted.form,
  formSource: admitted.formSource,
  profile: admitted.profile,
  session: admitted.session.session,
  sessionDir: admitted.session.sessionDir,
  root: admitted.root,
  runDir: admitted.runDir,
  callId: admitted.callId,
  tools: admitted.tools,
  prompt: admitted.request.prompt,
  policyDigest: admitted.policyDigest,
  profileDigest: deps.profileDigest,
  helpDigest: deps.helpDigest,
  layout,
});

/**
 * Nothing ran: the run's `spawn` record could not be written, so nothing was
 * launched and the call is a refusal (EX-6), recorded in the ledger that is still
 * writable. The run directory stays.
 */
function auditFailed(admitted: Admitted, run: RunOutcome): AgentResult {
  const detail = `the spawn record could not be written, so nothing was launched: ${run.layout.audit}`;
  appendAttempt(admitted.runDir, { callId: admitted.callId, reason: 'audit-failed', detail, policyDigest: admitted.policyDigest });
  return refusedResult('audit-failed', detail);
}

/** The gate over the clamped ceilings, and the run it guards. */
export async function executeRun(
  admitted: Admitted,
  layout: RunLayout,
  controller: AbortController,
  onAudit: (ts: string) => void,
  deps: ExecuteDeps,
): Promise<AgentResult> {
  // The gate (design sec-4, PHASE-07): one tick evaluator over the clamped
  // snapshot, aborting through this call's own controller so a crossing reaches
  // the ladder exactly as a cancellation does. Created first, inside the
  // exception boundary, so its idle poll never outlives a call and a failure to
  // build it is still a `failed` envelope rather than a throw.
  let gate: Gate | undefined;
  try {
    gate = createGate({
      ceilings: admitted.ceilings,
      policyPath: admitted.policyPath,
      // The cause token stays the ladder's input; the trigger rides along
      // additively, so the abort's audit record can name the crossing.
      abort: (trigger) => { controller.abort({ cause: trigger.cause, trigger }); },
      idleMs: deps.gateIdleMs,
    });
    return await runToResult(admitted, layout, controller, onAudit, deps, gate);
  } catch (error) {
    // The run was established (a session, a run directory) and the server threw
    // while running it: the answer is a conforming `failed` envelope over the
    // layout, with the reducer's verdict on an unread stream. The detail is
    // diagnostics, not reduced markdown, so it never enters the envelope.
    const detail = error instanceof Error ? error.message : String(error);
    deps.diagnostics.write(`quotient: call ${String(admitted.callId)} failed while running: ${detail}\n`);
    return failedResult('error', ['error'], admitted.session.session, EMPTY_STATUS, layout);
  } finally {
    gate?.close();
  }
}

/** The run itself: the latch, the spawn, the reduction and the result document. */
async function runToResult(
  admitted: Admitted,
  layout: RunLayout,
  controller: AbortController,
  onAudit: (ts: string) => void,
  deps: ExecuteDeps,
  gate: Gate,
): Promise<AgentResult> {
  // The abort latch (design sec-5, DEC-093): the causes this call discovers are
  // recorded here, in discovery order, and read once at the commit point below.
  // The result is derived from it in one place, `resultFor` — the server holds no
  // cause → state map of its own (EX-8).
  const latch = createLatch();

  const run = await runChild(spawnPlan(admitted, layout, deps), {
    signal: controller.signal,
    graceMs: deps.graceMs,
    env: deps.env,
    onRecord: (tally) => { gate.tick(tally); },
    onAudit,
  });

  // Nothing was launched: the call is a refusal.
  if (run.auditFailedBeforeSpawn) {return auditFailed(admitted, run);}

  // The one reader (design sec-4): the stream this run captured, reduced by the
  // reducer that owns the accounting, with the transcript budget admission
  // clamped against the policy's maximum.
  const reduced = reduce(run.lines, { budgetBytes: admitted.transcriptBudget });
  const wrote = writeRunFiles(run.layout, reduced);

  // The three causes the server discovers, in the order it discovers them: the
  // ladder's own cause, a launch that never ran, then an evidence append that
  // failed. `!wrote` is the same failure as a failed audit append — the run's own
  // evidence cannot be written — so it is the same cause, recorded once.
  if (run.abort !== null) {latch.record(run.abort);}
  if (run.spawnFailed) {latch.record('spawn');}
  if (run.auditFailed || !wrote) {latch.record('audit');}

  // The commit point: after the ladder, the reap, the drain, the final accounting
  // (the reduction above) and the `exit`/abort evidence appends (inside the
  // spawn). Nothing that can fail is left, because the return is the last step.
  return resultFor({
    reduced,
    outcome: run,
    causes: latch.commit(),
    session: admitted.session.session,
  });
}
