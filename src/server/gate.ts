// The gate: design sec-4's retrospective enforcement, riding the spawn's reader.
//
// One accumulator counts the stream (`countRecord` in pi/reduce/reduce.ts); this
// module only reads it. Every record that increments a unit reaches `tick` (the
// spawn's `onRecord` seam), and an idle poll bounded to about a second evaluates
// the last tally as well — so a child that has gone quiet, which is exactly what a
// blocking result looks like, still reaches the switch and the wall clock, and a
// cancellation is never delayed by a pending read.
//
// A tick evaluates, in design sec-4's order:
//   - the ceilings (requests, context tokens, cost) against the ADMISSION SNAPSHOT —
//     what `clampCeilings` returned, for the run's whole life;
//   - the wall clock, the hard backstop;
//   - the switch — the policy file re-read and re-parsed. Absent, unreadable,
//     malformed or `enabled: false` aborts with cause `switch`, because a switch
//     whose source cannot be read is not evidence that it is off. The maxima in
//     that re-read are ignored: the snapshot judges the run;
//   - usage sanity — `accounting === 'unknown'` is the accumulator's own
//     statement that a usage-bearing record carried absent or invalid usage.
//
// The first crossing fires once: it stops the poll and hands the trigger to
// `abort`, which is the call's `AbortController.abort` — the one ladder, exactly
// as a cancellation reaches it. The whole trigger travels, not just its cause, so
// the abort's audit record can name which unit crossed, what it read and the bound
// it crossed. The gate keeps no usage of its own, so the numbers it judges and
// the numbers the result reports are the same accumulator's, and it never accounts
// anything itself.
import { createTally } from '../reduce/reduce.ts';
import type { Tally } from '../reduce/reduce.ts';
import { readPolicy, type Maxima } from './policy.ts';

/** The causes the gate aborts with: a subset of the spawn's `AbortCause`, so the
 *  ladder accepts one through the same signal as every other trigger. */
export type GateCause = 'ceiling' | 'timeout' | 'switch' | 'accounting';

/** The unit that crossed. `enabled` and `accounting` are verdicts, not numbers. */
export type GateUnit = 'requests' | 'context_tokens' | 'cost_usd' | 'wall_clock_s' | 'enabled' | 'accounting';

/** One fired evaluation: which unit crossed, what it read, and the bound it was
 *  judged against. The ceiling units carry the accumulator's number. */
export type GateTrigger = {
  cause: GateCause;
  unit: GateUnit;
  /** The accumulator's value at the crossing; null where there is no number. */
  observed: number | null;
  /** The clamped bound, or null where the unit has none. */
  limit: number | null;
};

export type GateConfig = {
  /** The clamped snapshot from `clampCeilings` — the run's judged bounds. */
  ceilings: Maxima;
  /** The policy file the switch re-reads every tick. */
  policyPath: string;
  /** The call's `AbortController.abort`: the ladder, reached the way a
   *  cancellation reaches it. The whole trigger, so the audit record the ladder
   *  writes can carry the crossing as well as the cause token. */
  abort: (trigger: GateTrigger) => void;
  /** Epoch ms the run's wall clock started; defaults to `Date.now()`. */
  startedAt?: number;
  /** The idle poll's period. Design sec-4: an idle poll bounded to about a
   *  second. A test injects less; there is no other way to reach it. */
  idleMs?: number;
};

export type Gate = {
  /** One evaluation over the accumulator as it now stands. */
  tick(tally: Tally): void;
  /** End the poll. Idempotent; a closed gate evaluates nothing. */
  close(): void;
  /** The triggers fired so far — at most one, because the first stops the gate. */
  triggers(): GateTrigger[];
  /** The first trigger's cause, or null when nothing crossed. */
  cause(): GateCause | null;
};

/** Design sec-4's "bounded to about a second". */
export const DEFAULT_IDLE_MS = 1000;

export function createGate(config: GateConfig): Gate {
  const idleMs = config.idleMs ?? DEFAULT_IDLE_MS;
  const startedAt = config.startedAt ?? Date.now();
  const fired: GateTrigger[] = [];
  // Primed with an empty accumulator, never null: the wall clock and the switch
  // bound a silent child from the gate's first poll, before any caller has handed
  // in a tally. The ceiling units read zero, which crosses nothing.
  let last: Tally = createTally();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const stop = (): void => {
    stopped = true;
    if (timer !== null) {clearInterval(timer);}
    timer = null;
  };

  /** A crossing is a value strictly above its bound: a value equal to the
   *  ceiling is within it. An absent bound leaves the unit unjudged. */
  const ceiling = (unit: GateUnit, observed: number | null, limit: number | undefined): GateTrigger | null => {
    if (limit === undefined || observed === null || observed <= limit) {return null;}
    return { cause: 'ceiling', unit, observed, limit };
  };

  /** The hard backstop. Seconds since the run started, against `wall_clock_s`. */
  const wallClock = (): GateTrigger | null => {
    const limit = config.ceilings.wall_clock_s;
    if (limit === undefined) {return null;}
    const observed = (Date.now() - startedAt) / 1000;
    return observed > limit ? { cause: 'timeout', unit: 'wall_clock_s', observed, limit } : null;
  };

  /** The switch and the policy source in one read: `enabled` comes from the
   *  re-parse, and a source that cannot be read fails closed. The re-read's
   *  maxima are ignored — the admission snapshot judges the run (EX-4). */
  const policySwitch = (): GateTrigger | null => {
    const reread = readPolicy(config.policyPath);
    if (!reread.ok || !reread.policy.enabled) {
      return { cause: 'switch', unit: 'enabled', observed: null, limit: null };
    }
    return null;
  };

  /** Usage sanity: the accumulator marks itself `unknown` when a usage-bearing
   *  record carried absent, non-finite or negative usage — never silently zero. */
  const usageSanity = (tally: Tally): GateTrigger | null => {
    if (tally.accounting !== 'unknown') {return null;}
    return { cause: 'accounting', unit: 'accounting', observed: null, limit: null };
  };

  const fire = (trigger: GateTrigger): void => {
    fired.push(trigger);
    stop();
    config.abort(trigger);
  };

  /** Design sec-4's order: ceilings, wall clock, switch, usage sanity. */
  const judge = (tally: Tally): void => {
    if (stopped) {return;}
    const ceilings = config.ceilings;
    const trigger =
      ceiling('requests', tally.requests, ceilings.requests) ??
      ceiling('context_tokens', tally.context.peak_tokens, ceilings.context_tokens) ??
      ceiling('cost_usd', tally.cost, ceilings.cost_usd) ??
      wallClock() ??
      policySwitch() ??
      usageSanity(tally);
    if (trigger !== null) {fire(trigger);}
  };

  const tick = (tally: Tally): void => {
    if (stopped) {return;}
    last = tally;
    judge(tally);
  };

  // The idle poll: the same evaluation, with no record and no caller needed. It
  // judges the last tally handed in — the empty accumulator until the spawn hands
  // the first one over — so the switch and the wall clock bound a silent child
  // from the first period on. Unref'd, so an interval a forgotten `close()` left
  // behind cannot hold the process open.
  timer = setInterval(() => {
    judge(last);
  }, idleMs);
  timer.unref();

  return {
    tick,
    close: stop,
    triggers: () => [...fired],
    cause: () => (fired.length > 0 ? fired[0].cause : null),
  };
}
