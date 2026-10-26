// The wait's three pieces (design sec-5, sec-7): which runs a request targets, the
// condition it blocks on, and the envelope it answers with.
//
// `resolveTargets` reads sec-5's selection table off the registry, snapshotting a
// lane's membership at arrival; `awaitTargets` races the targets' own `settled`
// promises, a timer and the call's signal, polling the evidence of the only targets
// that have no promise in this process (foreign and unreadable ones); `waitEnvelope`
// re-resolves every target when it builds the answer, so `timed_out` is computed from
// the states the entries report and can never contradict them. A wait changes no
// state anyone can observe, which is what lets the tool declare `readOnlyHint: true`.
//
// Nothing here maps a quotient state to a Task status: entries are `runDocument`s
// (documents.ts) with the result arm hung off them, and the one state→status table
// stays `taskStatus`'s. Every resolution — live record, disk evidence, `unreadable`
// or no evidence at all — comes in through one `resolve` closure (D-4, D-5), so this
// module never reads a run directory itself.
import { runDocument, WAIT_SCHEMA, type WaitDocument, type WaitEntry } from './documents.ts';
import type { Maxima } from './policy.ts';
import type { Registry } from './runs.ts';
import type { Resolution, Resolved, RunView } from './views.ts';

/** The timeout a wait gets when it names none (sec-5): inside Codex's default 60 s
 *  tool timeout with margin, and far inside Claude Code's idle window (EVD-002, EVD-003). */
export const WAIT_TIMEOUT_DEFAULT_S = 45;

/** The timeout ceiling when the policy declares no `wall_clock_s` maximum (C1). */
export const WAIT_TIMEOUT_MAX_S = 900;

/** The byte budget a wait gets when it names none (sec-5). */
export const WAIT_BUDGET_DEFAULT = 65536;

/** The byte budget's ceiling: a larger request is clamped silently (sec-5). */
export const WAIT_BUDGET_MAX = 1048576;

/** The condition a wait blocks on (sec-5): every target, or any one of them. */
export type Until = WaitDocument['until'];

/** What a wait selects (sec-5): named runs, named lanes, or both. Both omitted means
 *  every unacknowledged `pi_agent_start` run this server holds. */
export type WaitSelectors = { runs?: string[]; lanes?: string[] };

/**
 * One run a wait is about (C8): its handle, the view it read at arrival — null for an
 * id no evidence names, `unreadable` for one whose result cannot be read now — and,
 * only for a record this server holds, the promise its settlement resolves.
 */
export type Target = { run: string; view: RunView | 'unreadable' | null; settled?: Promise<void> };

/** Something a wait must clear however it ends (C9): its timer, a poll handle, or its
 *  abort listener. */
type Cleanup = () => void;

/** One target re-resolved when the answer was built, with the id it names (C11). */
type Answered = { run: string; resolution: Resolution };

/** The byte budget's running state (C3, C4, C10): its ceiling, the bytes the included
 *  results took, whether a result has been included yet — the first is always whole —
 *  and whether a readable one was left out for want of room. */
type Budget = { limit: number; used: number; included: boolean; truncated: boolean };

/** The entries an answer carries, and whether the budget left a result out. */
type Layout = { entries: WaitEntry[]; truncated: boolean };

// ── Parameters (C1, C2) ───────────────────────────────────────────────────

/**
 * The millisecond timeout a request gets (C1): the default unless one was named, and
 * never more than the policy's `wall_clock_s` as read when the wait arrived. A null
 * `maxima` is a policy that could not be read, which leaves the contract maximum.
 */
export function waitTimeoutMs(requested: number | undefined, maxima: Maxima | null): number {
  const seconds = requested ?? WAIT_TIMEOUT_DEFAULT_S;
  return Math.min(seconds, maxima?.wall_clock_s ?? WAIT_TIMEOUT_MAX_S) * 1000;
}

/** The byte budget a request gets (C2): the default unless one was named, clamped at
 *  the ceiling without a word. A report bound, as the transcript budget is. */
export function waitBudgetBytes(requested: number | undefined): number {
  return Math.min(requested ?? WAIT_BUDGET_DEFAULT, WAIT_BUDGET_MAX);
}

// ── Selection (C8, sec-5's table) ─────────────────────────────────────────

/**
 * The targets a request names (C8): every selected id resolved through `resolve`, in
 * sec-5's order — named runs as given, then lanes lane by lane in start order,
 * duplicates dropped at their first position.
 */
export function resolveTargets(
  registry: Registry,
  request: WaitSelectors,
  resolve: (run: string) => Resolution,
): Target[] {
  return dedupe(selectRuns(registry, request)).map((run) => targetFor(registry, run, resolve(run)));
}

/** The ids a request selects (C8): both selectors omitted takes every implicit run;
 *  otherwise the named runs and then each named lane's implicit runs. An empty array
 *  selects nothing from its selector. */
function selectRuns(registry: Registry, request: WaitSelectors): string[] {
  if (request.runs === undefined && request.lanes === undefined) {
    return registry.implicit().map((record) => record.run);
  }
  return [...(request.runs ?? []), ...laneRuns(registry, request.lanes ?? [])];
}

/** Each lane's implicit runs, lane by lane, in start order within each: a snapshot
 *  read when the wait arrives, so a run started into a lane later is no target. */
function laneRuns(registry: Registry, lanes: string[]): string[] {
  const ids: string[] = [];
  for (const lane of lanes) {
    for (const record of registry.implicit([lane])) {
      ids.push(record.run);
    }
  }
  return ids;
}

/** The ids with duplicates dropped at their first position (C8), order preserved. */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** One target (C8): the view its resolution reports, and the record's own `settled`
 *  promise when this server holds it — a disk target has no promise in this process. */
function targetFor(registry: Registry, run: string, resolution: Resolution): Target {
  const view = viewOfResolution(resolution);
  const record = registry.get(run);
  return record === undefined ? { run, view } : { run, view, settled: record.settled };
}

// ── The condition (C6, C7) ────────────────────────────────────────────────

/** What a resolution says a target's view is: the view arm, `unreadable`, or null for
 *  an id no evidence names (D-5). */
function viewOfResolution(resolution: Resolution): RunView | 'unreadable' | null {
  if (resolution === null || resolution === 'unreadable') {
    return resolution;
  }
  return resolution.view;
}

/** The one done predicate (C6), read by both the wait and the answer: `settled`,
 *  `lost`, or an unknown id is done; `queued`, `running`, `foreign` and `unreadable`
 *  are not. */
function isDone(view: RunView | 'unreadable' | null): boolean {
  if (view === null) {
    return true;
  }
  if (view === 'unreadable') {
    return false;
  }
  return view.state === 'settled' || view.state === 'lost';
}

/** The one condition function (C7), read by both the wait and the answer: `all` needs
 *  every target done, `any` at least one, and a wait with no targets holds either way. */
function conditionHolds(done: boolean[], until: Until): boolean {
  if (done.length === 0) {
    return true;
  }
  return until === 'all' ? done.every((flag) => flag) : done.some((flag) => flag);
}

// ── Awaiting (C9) ─────────────────────────────────────────────────────────

/**
 * Block until the condition holds over what this call has observed, the timer fires,
 * or the signal aborts (C9). It never rejects and never reports which ending it was:
 * the answer is built from re-resolved states, so a target that turned done in the
 * last instant reports `timed_out: false` of its own accord. Every handle it takes —
 * the timer, a poll interval, the abort listener — is released on every path, so
 * nothing it started keeps the event loop alive.
 */
export async function awaitTargets(
  targets: Target[],
  until: Until,
  timeoutMs: number,
  signal: AbortSignal,
  reread: (run: string) => Resolution,
  pollMs: number,
): Promise<void> {
  const done = targets.map((target) => isDone(target.view));
  if (signal.aborted || conditionHolds(done, until)) {
    return;
  }
  const cleanups: Cleanup[] = [];
  try {
    await Promise.race([reached(targets, until, reread, pollMs, cleanups), fires(timeoutMs, cleanups), aborts(signal, cleanups)]);
  } finally {
    for (const cleanup of cleanups) {
      cleanup();
    }
  }
}

/** The condition being reached: every not-done target's own ending, raced or awaited
 *  together as `until` asks. No `reread` is made for a target that is already done, or
 *  that has a promise in this process. */
async function reached(
  targets: Target[],
  until: Until,
  reread: (run: string) => Resolution,
  pollMs: number,
  cleanups: Cleanup[],
): Promise<void> {
  const endings = targets
    .filter((target) => !isDone(target.view))
    .map((target) => ending(target, reread, pollMs, cleanups));
  await (until === 'all' ? Promise.all(endings) : Promise.race(endings));
}

/** How one target becomes done (C9): its record's `settled` promise, or — for a run
 *  this server does not hold — a poll of its evidence. */
function ending(target: Target, reread: (run: string) => Resolution, pollMs: number, cleanups: Cleanup[]): Promise<void> {
  return target.settled ?? polls(target.run, reread, pollMs, cleanups);
}

/** Re-read one target's evidence every poll interval until it reads done (C9): the
 *  only polling there is, and it exists only while such a target is waited on. */
function polls(run: string, reread: (run: string) => Resolution, pollMs: number, cleanups: Cleanup[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const handle = setInterval(() => {
      if (isDone(viewOfResolution(reread(run)))) {
        resolve();
      }
    }, pollMs);
    cleanups.push(() => {
      clearInterval(handle);
    });
  });
}

/** The wait's timer: the one ending that answers `timed_out: true` when the states
 *  still say so. Registered for clearing like every other handle. */
function fires(timeoutMs: number, cleanups: Cleanup[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, timeoutMs);
    cleanups.push(() => {
      clearTimeout(handle);
    });
  });
}

/** The call's own abort (C9): a cancel or an EOF ends the wait early, and the answer
 *  that follows reports whatever the states are then. */
function aborts(signal: AbortSignal, cleanups: Cleanup[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

// ── The answer (C3–C7, C10, C11) ──────────────────────────────────────────

/**
 * What a wait answers (sec-2): every target re-resolved once, exactly, and reported as
 * it is now (C11). A null resolution goes to `unknown` and an `unreadable` one to
 * `unreadable`; those that resolve become entries laid out under the byte budget, and
 * `timed_out` is the condition over those same states, so it never contradicts them.
 */
export function waitEnvelope(
  targets: Target[],
  resolve: (run: string) => Resolution,
  options: { until: Until; statusOnly: boolean; budgetBytes: number },
): WaitDocument {
  const answered: Answered[] = targets.map((target) => ({ run: target.run, resolution: resolve(target.run) }));
  const layout = layOut(answered, options);
  return {
    schema: WAIT_SCHEMA,
    until: options.until,
    timed_out: !conditionHolds(doneFlags(answered), options.until),
    truncated: layout.truncated,
    runs: layout.entries,
    unknown: idsWhere(answered, null),
    unreadable: idsWhere(answered, 'unreadable'),
  };
}

/** Every answered target's done-ness, in target order: the flags the condition is
 *  computed from. */
function doneFlags(answered: Answered[]): boolean[] {
  return answered.map((entry) => isDone(viewOfResolution(entry.resolution)));
}

/** The ids whose resolution reads KIND (an unknown id, or an unreadable run): the two
 *  lists a wait reports apart, because neither names a run with a status to report. */
function idsWhere(answered: Answered[], kind: null | 'unreadable'): string[] {
  return answered.filter((entry) => entry.resolution === kind).map((entry) => entry.run);
}

/** The entries an answer carries, in target order, each taking its result from its own
 *  resolution under the budget (sec-5). A target that resolves to nothing is no entry:
 *  it was listed apart already. */
function layOut(answered: Answered[], options: { statusOnly: boolean; budgetBytes: number }): Layout {
  let budget: Budget = { limit: options.budgetBytes, used: 0, included: false, truncated: false };
  const entries: WaitEntry[] = [];
  for (const entry of answered) {
    const resolution = entry.resolution;
    if (resolution !== null && resolution !== 'unreadable') {
      const placed = options.statusOnly ? { result: null, budget } : affordable(resolution, budget);
      budget = placed.budget;
      entries.push({ ...runDocument(resolution.view), status_only: placed.result === null, result: placed.result });
    }
  }
  return { entries, truncated: budget.truncated };
}

/**
 * One entry's result under the budget (C3, C4, C10): the document when the run is
 * settled, its result reads now and the running total allows it — or nothing, with
 * `truncated` set when the budget alone left a readable result out. The first readable
 * settled result is included whole whatever its size, so a wait that finds one always
 * makes progress; leaving out a result that could not be read now is never truncation.
 */
function affordable(resolution: Resolved, budget: Budget): { result: WaitEntry['result']; budget: Budget } {
  const document = resolution.result;
  if (resolution.view.state !== 'settled' || document === null) {
    return { result: null, budget };
  }
  const bytes = Buffer.byteLength(JSON.stringify(document));
  if (budget.included && budget.used + bytes > budget.limit) {
    return { result: null, budget: { ...budget, truncated: true } };
  }
  return { result: document, budget: { ...budget, used: budget.used + bytes, included: true } };
}
