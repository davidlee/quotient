// The reducer — turn a pi `--mode json` event stream into the signal an
// orchestrator actually needs: a budgeted transcript, a status record, and alert
// lines for patterns the caller declared it cares about.
//
// Pure: lines in, `Reduced` out. No I/O, no argv, no process. `quotient reduce`
// (`cli.ts`) and the MCP server (`src/server`) both call this, so there is one
// reducer and one idea of what a run was.
//
// Fidelity rules, in order of importance:
//   1. The final assistant answer is always present and always last.
//   2. Assistant prose is verbatim; thinking is dropped.
//   3. Tool calls become one line each; tool results keep their first line only.
//   4. Context echo (system/user message replays) is dropped entirely — it is
//      ~72% of the raw stream and none of it is new information.
//   5. Whatever the budget cannot hold is elided from the MIDDLE, so both the
//      opening moves and the latest moves survive.
//
// Two contracts travel with that transcript, both from the slice-029 design:
// sec-4's accounting (one request per provider send, one unit path, and
// `unmeasured` / `unknown` never silently zero) and sec-5's answer (the terminal
// assistant message, or nothing). `final` is NOT decided here — the reducer
// never sees the child's exit — so it reports the stream-side inputs the server
// derives it from: `terminalReason`, `settled`, and the accounting signal.

export const SCHEMA = 'pi-run-status/2';

/** Whether every counted request's usage was observed. A consumer must read this
 *  rather than infer completeness from a zero: a cached read priced at zero is a
 *  price, and a failed send's placeholder zeros are not. */
export type Accounting = 'known' | 'unknown';

export type ReduceOptions = {
  /** Byte ceiling for the transcript. 0 disables the ceiling. Default 8192. */
  budgetBytes?: number;
  /**
   * Patterns the caller wants warned about. Matched case-insensitively against
   * UNTRUNCATED entry text — tool results included — so a budget or a 200-char
   * snippet can never hide an alert.
   */
  alerts?: string[];
};

export type Status = {
  schema: typeof SCHEMA;
  state: 'completed' | 'failed' | 'incomplete';
  turns: number;
  tool_calls: number;
  /** Provider sends this run made — one per counting record (design sec-4). */
  requests: number;
  /** Requests whose usage could not be measured: counted, disclosed, never zeroed. */
  requests_unmeasured: number;
  tokens: { input: number; output: number; cached: number; cache_write: number };
  /** Sum of observed `usage.cost.total`; null when no cost was observed. */
  cost_usd: number | null;
  accounting: Accounting;
  session_id: string | null;
  cwd: string | null;
  model: string | null;
  last_stop_reason: string | null;
  alerts: { pattern: string; text: string }[];
  transcript: { bytes: number; records: number; malformed: number; elided: number };
};

export type Reduced = {
  transcript: string;
  status: Status;
  /** The terminal assistant message's text, every block joined; null when it has
   *  no text or its stop reason is not answer-bearing (design sec-5). */
  result: string | null;
  /** The last assistant message's `stopReason`, verbatim — pi's token, never
   *  normalised. `result` is the narrower claim. */
  terminalReason: string | null;
  settled: boolean;
  truncated: boolean;
  requests: number;
  requests_unmeasured: number;
  accounting: Accounting;
};

/** The single usage accumulator. One instance per run; `countRecord` is the only
 *  writer of its units.
 *
 *  Exported so a second reader of the same stream can drive the same accumulator
 *  instead of copying the arithmetic: the server's gate (PHASE-07) counts each
 *  record as it arrives to enforce ceilings, and the returned status must be the
 *  same arithmetic, not a lookalike. */
export type Tally = {
  requests: number;
  requests_unmeasured: number;
  context: { peak_tokens: number | null; requests_unmeasured: number };
  tokens: { input: number; output: number; cached: number; cache_write: number };
  cost: number | null;
  accounting: Accounting;
};

/** The accumulator's one constructor: the state a `Tally` has before its first
 *  record. The reducer, the spawn and the gate's idle poll all start here, so an
 *  empty accumulator is spelled once. */
export function createTally(): Tally {
  return {
    requests: 0,
    requests_unmeasured: 0,
    context: { peak_tokens: null, requests_unmeasured: 0 },
    tokens: { input: 0, output: 0, cached: 0, cache_write: 0 },
    cost: null,
    accounting: 'known',
  };
}

type Entry = {
  kind: 'prose' | 'call' | 'result' | 'error';
  /** Rendered line(s), no trailing newline. */
  line: string;
  /** Unrendered text, for alert matching only. Never persisted. */
  text: string;
};

const CALL_ARG_CHARS = 120;
const RESULT_CHARS = 200;
const ERROR_CHARS = 500;
const ALERT_TEXT_CHARS = 160;
const MAX_ALERTS = 50;

export function reduce(lines: string[], opts: ReduceOptions = {}): Reduced {
  const budget = opts.budgetBytes ?? 8192;
  const patterns = (opts.alerts ?? []).map((pattern) => ({
    pattern,
    re: new RegExp(pattern, 'i'),
  }));

  const entries: Entry[] = [];
  const alerts: Status['alerts'] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let settled = false;
  let records = 0;
  let malformed = 0;
  let turns = 0;
  let toolCalls = 0;
  let stopReason: string | null = null;
  const tally: Tally = createTally();
  /** The last assistant message seen and where its own prose landed. A later
   *  assistant `message_start` or `message_end` replaces it, so only a message
   *  with none after it can be the terminal one. */
  let candidate: { stopReason: string | null; texts: string[]; entryIndices: number[] } | null = null;

  const add = (entry: Entry): number => {
    entries.push(entry);
    for (const { pattern, re } of patterns) {
      if (alerts.length >= MAX_ALERTS) break;
      if (re.test(entry.text)) {
        alerts.push({ pattern, text: alertText(entry.text, re) });
      }
    }
    return entries.length - 1;
  };

  for (const raw of lines) {
    if (!raw.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      malformed += 1;
      continue;
    }
    records += 1;
    countRecord(event, tally);

    switch (event.type) {
      case 'session':
        sessionId = typeof event.id === 'string' ? event.id : null;
        cwd = typeof event.cwd === 'string' ? event.cwd : null;
        break;

      case 'message_start': {
        // A message that has begun invalidates the earlier candidate: the answer
        // is only known once the stream has no assistant message after it.
        if (event.message?.role === 'assistant') candidate = null;
        break;
      }

      case 'message_end': {
        const message = event.message ?? {};
        if (message.role !== 'assistant') break; // context echo: system + user replays
        turns += 1;
        stopReason = typeof message.stopReason === 'string' ? message.stopReason : stopReason;
        model = typeof message.model === 'string' ? message.model : model;
        const texts: string[] = [];
        const entryIndices: number[] = [];
        for (const block of message.content ?? []) {
          if (block?.type !== 'text' || !block.text?.trim()) continue; // thinking and toolCalls render elsewhere
          texts.push(block.text.trimEnd());
          entryIndices.push(add({ kind: 'prose', line: block.text.trimEnd(), text: block.text }));
        }
        candidate = {
          stopReason: typeof message.stopReason === 'string' ? message.stopReason : null,
          texts,
          entryIndices,
        };
        break;
      }

      case 'tool_execution_start': {
        toolCalls += 1;
        const signature = describeCall(event.toolName, event.args);
        add({ kind: 'call', line: `→ ${signature}`, text: `${event.toolName} ${signature}` });
        break;
      }

      case 'tool_execution_end': {
        const text = resultText(event.result);
        const exit = event.result?.structuredContent?.exit_code;
        if (event.isError) {
          add({ kind: 'error', line: `  ✗ ${clip(firstLine(text), ERROR_CHARS)}`, text });
        } else {
          const tag = typeof exit === 'number' && exit !== 0 ? `[exit ${exit}] ` : '';
          add({ kind: 'result', line: `  ↳ ${tag}${clip(firstLine(text), RESULT_CHARS)}`, text });
        }
        break;
      }

      case 'agent_end': {
        // `messages` replays what `message_end` already delivered: usage here would
        // double-count the run, so only the model is taken from it.
        const last = Array.isArray(event.messages) ? event.messages.at(-1) : undefined;
        if (typeof last?.model === 'string') model = last.model;
        break;
      }

      case 'agent_settled':
        settled = true;
        break;
    }
  }

  // sec-5's answer: the terminal assistant message — the last one, with none
  // after it, that stopped for a reason the contract calls terminal. Its text
  // blocks are joined, and null is an answer too: an answerless terminal message
  // yields no result rather than a backwards search for the last prose block.
  const terminal = terminalMessage(candidate);
  let result: string | null = null;
  if (terminal && terminal.texts.length > 0) {
    result = terminal.texts.join('\n\n');
    // Rendered once, in `## Result`: splice the terminal message's prose out of
    // the body, descending so the earlier indices stay valid.
    for (const index of [...terminal.entryIndices].sort((a, b) => b - a)) entries.splice(index, 1);
  }

  // The stream's verdict, in the reducer's three-way vocabulary. Precedence among
  // causes is the server's (design sec-5), so the stream-side facts it needs
  // travel beside this rather than being folded into it: `terminalReason`,
  // `settled`, `accounting`.
  const state: Status['state'] =
    stopReason === 'error' || stopReason === 'aborted'
      ? 'failed'
      : settled
        ? 'completed'
        : 'incomplete';

  const header = `# pi run ${sessionId ?? 'unknown'} · ${records} records\n\n`;
  const resultBlock = result ? `\n## Result\n${result}\n` : '\n## Result\n(no assistant answer)\n';
  // `budget <= 0` means unbounded; anything else budgets what is LEFT of the
  // header and the result block, both of which are mandatory. A budget smaller
  // than those two still elides (room floors at 1), and the status reports the
  // honest byte count rather than pretending the ceiling held.
  const overhead = Buffer.byteLength(header) + Buffer.byteLength(resultBlock);
  const room = budget <= 0 ? 0 : Math.max(1, budget - overhead);
  const { blocks, elided } = fit(entries, room);
  const transcript = header + blocks + resultBlock;

  return {
    transcript,
    status: {
      schema: SCHEMA,
      state,
      turns,
      tool_calls: toolCalls,
      requests: tally.requests,
      requests_unmeasured: tally.requests_unmeasured,
      tokens: tally.tokens,
      cost_usd: tally.cost,
      accounting: tally.accounting,
      session_id: sessionId,
      cwd,
      model,
      last_stop_reason: stopReason,
      alerts,
      transcript: {
        bytes: Buffer.byteLength(transcript),
        records,
        malformed,
        elided,
      },
    },
    result,
    terminalReason: stopReason,
    settled,
    truncated: stopReason === 'length',
    requests: tally.requests,
    requests_unmeasured: tally.requests_unmeasured,
    accounting: tally.accounting,
  };
}

type Unit = { lines: string[]; kind: Entry['kind'] };

/** Fold each tool call together with the result that immediately followed it. */
function units(entries: Entry[]): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const next = entries[i + 1];
    if (entry.kind === 'call' && next && (next.kind === 'result' || next.kind === 'error')) {
      out.push({ lines: [entry.line, next.line], kind: 'call' });
      i += 1;
    } else {
      out.push({ lines: [entry.line], kind: entry.kind });
    }
  }
  return out;
}

/** Render entries to blocks, collapsing runs of identical ACTIVITY, then elide
 *  the middle until the rendered size fits `budget`.
 *
 *  A unit is a call plus the result that followed it, kept together so a retried
 *  command folds as a whole: `→ bash(cmd) ×3` above one representative output.
 *  Collapsing on single lines would never fire — call and result alternate. */
function fit(entries: Entry[], budget: number): { blocks: string; elided: number } {
  const rendered: string[] = [];
  let previous: string | null = null;
  let repeats = 0;
  const flush = (unit: Unit | null): void => {
    if (!unit) return;
    const [first, ...rest] = unit.lines;
    const head = repeats > 1 ? `${first} ×${repeats}` : first;
    // Prose keeps a blank line after it so the transcript stays readable; tool
    // lines stack compactly.
    const suffix = unit.kind === 'prose' ? '\n\n' : '\n';
    rendered.push([head, ...rest].join('\n') + suffix);
  };
  let pending: Unit | null = null;
  for (const unit of units(entries)) {
    const key = unit.lines.join('\u0000');
    if (key === previous) {
      repeats += 1;
      continue;
    }
    flush(pending);
    pending = unit;
    previous = key;
    repeats = 1;
  }
  flush(pending);

  const sizes = rendered.map((block) => Buffer.byteLength(block));
  let total = sizes.reduce((sum, n) => sum + n, 0);
  if (budget <= 0 || total <= budget) return { blocks: rendered.join(''), elided: 0 };

  // Middle-out: drop inward from the centre so the first and last entries survive.
  const keep = rendered.map(() => true);
  const order: number[] = [];
  const middle = Math.floor(rendered.length / 2);
  for (let step = 0; step < rendered.length; step++) {
    const before = middle - step;
    if (before > 0) order.push(before);
    const after = middle + step;
    if (step > 0 && after < rendered.length - 1) order.push(after);
  }

  let elided = 0;
  for (const index of order) {
    if (total + marker(elided + 1).length <= budget) break;
    total -= sizes[index];
    keep[index] = false;
    elided += 1;
  }

  const kept = rendered.filter((_, index) => keep[index]);
  if (elided > 0) kept.splice(Math.floor(kept.length / 2), 0, marker(elided));
  const blocks = kept.join('');
  return { blocks, elided };
}

function marker(count: number): string {
  return `… ${count} entries elided\n`;
}

function describeCall(name: unknown, args: unknown): string {
  const tool = typeof name === 'string' ? name : 'tool';
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const preferred = ['command', 'path', 'file', 'query', 'pattern'];
  let value: unknown = preferred.map((key) => record[key]).find((v) => typeof v === 'string');
  if (value === undefined) value = Object.values(record).find((v) => typeof v === 'string');
  const text = typeof value === 'string' ? value : Object.keys(record).length ? JSON.stringify(record) : '';
  return `${tool}(${clip(oneLine(text), CALL_ARG_CHARS)})`;
}

function resultText(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) {
    const parts = content.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  if (typeof result?.structuredContent?.output === 'string') return result.structuredContent.output;
  return '';
}

/** Stop reasons that accrue tokens; every other reason does not, though its cost
 *  still does. pi's tokens, verbatim (`docs/message-types.md`). */
const NO_TOKEN_STOP_REASONS = new Set(['error', 'aborted']);
/** Stop reasons that answer. Everything else — `toolUse`, `deferred`, `error`,
 *  `aborted`, `pending`, and any reason pi adds later — is counted and is not. */
const ANSWER_STOP_REASONS = new Set(['stop', 'length']);

/** The terminal assistant message, if the stream ended on one: the last assistant
 *  `message_end`, with no later assistant message, stopped for a reason that
 *  answers. `pending` is the in-flight marker, so it is not terminal; nor are
 *  `error`, `aborted`, `toolUse`, `deferred`, or any reason pi adds later. */
function terminalMessage(
  candidate: { stopReason: string | null; texts: string[]; entryIndices: number[] } | null,
): { texts: string[]; entryIndices: number[] } | null {
  if (!candidate || candidate.stopReason === null) return null;
  if (candidate.stopReason === 'pending') return null;
  return ANSWER_STOP_REASONS.has(candidate.stopReason) ? candidate : null;
}

/** Design sec-4's counting table, and the only code that decides what counts as a
 *  request, a token or a cost. Counting units are defined per record so two
 *  readers of one stream count the same run the same way.
 *
 *  Assistant sends need no state: the agent loop emits exactly one `message_end`
 *  per send, on its `done` and its `error` path alike, and `auto_retry_start`
 *  marks the retry of an already-counted send. Summarization sends are counted
 *  only on positive evidence — `result.usage`, a `result` without usage, or
 *  `summarization_retry_scheduled` — because a credential or model failure, a
 *  declined summarization and the overflow diagnostic all emit `compaction_end`
 *  with no `result` at all, never having reached a provider. */
export function countRecord(event: any, tally: Tally): void {
  switch (event.type) {
    case 'message_end': {
      const message = event.message ?? {};
      if (message.role !== 'assistant') return; // context echo, not a send
      tally.requests += 1;
      const failedSend = NO_TOKEN_STOP_REASONS.has(message.stopReason);
      observeContext(message.usage, tally, failedSend);
      if (failedSend) {
        countFailedSend(message.usage, tally);
        return;
      }
      accrue(readUsage(message.usage), tally);
      return;
    }

    case 'compaction_end': {
      if (!event.result || typeof event.result !== 'object') return;
      tally.requests += 1;
      observeContext(event.result.usage, tally);
      accrue(readUsage(event.result.usage), tally);
      return;
    }

    case 'summarization_retry_scheduled':
      // A send returned an error; its retry is the next `compaction_end`. There is
      // no usage evidence for this one, so it is counted and disclosed.
      tally.requests += 1;
      tally.requests_unmeasured += 1;
      tally.context.requests_unmeasured += 1;
      return;
  }
}

/** Record the independent context observation for one already-classified send.
 *  Missing/invalid token components are gaps, never inferred from totalTokens.
 *  Failed sends with an all-zero vector carry provider placeholders, not a
 *  measured zero. This intentionally does not alter cost or cumulative tokens. */
function observeContext(usage: any, tally: Tally, failedSend = false): void {
  const input = nonNegative(usage?.input);
  const output = nonNegative(usage?.output);
  const cacheRead = nonNegative(usage?.cacheRead);
  const cacheWrite = nonNegative(usage?.cacheWrite);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) {
    tally.context.requests_unmeasured += 1;
    return;
  }

  if (failedSend && input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) {
    tally.context.requests_unmeasured += 1;
    return;
  }

  const footprint = input + cacheRead + cacheWrite + output;
  if (!Number.isFinite(footprint)) {
    tally.context.requests_unmeasured += 1;
    return;
  }
  tally.context.peak_tokens = Math.max(tally.context.peak_tokens ?? footprint, footprint);
}

/** The one accrual path: observed usage adds tokens and cost; absent or invalid
 *  usage marks the run's accounting unknown rather than adding a zero. */
function accrue(usage: ObservedUsage | null, tally: Tally): void {
  if (!usage) {
    tally.accounting = 'unknown';
    return;
  }
  tally.tokens.input += usage.input;
  tally.tokens.output += usage.output;
  tally.tokens.cached += usage.cached;
  tally.tokens.cache_write += usage.cache_write;
  tally.cost = (tally.cost ?? 0) + usage.cost;
}

/** A failed send was still paid for, so its cost accrues while its tokens do not —
 *  the asymmetry design sec-4 states and the tests assert. Its usage is usually
 *  `EMPTY_USAGE` — zeros, including `cost.total` — which is a placeholder rather
 *  than an observation: the request is counted, disclosed as
 *  `requests_unmeasured`, and contributes nothing (operator-accepted, DEC-097). */
function countFailedSend(usage: any, tally: Tally): void {
  const price = isEmptyUsage(usage) ? null : readPrice(usage);
  if (price === null) {
    tally.requests_unmeasured += 1;
    return;
  }
  tally.cost = (tally.cost ?? 0) + price;
}

type ObservedUsage = {
  input: number;
  output: number;
  cached: number;
  cache_write: number;
  cost: number;
};

/** One reader for a usage record, so nothing else can accrue a unit. Missing data
 *  is never headroom: absent, non-finite or negative components, or an absent
 *  `cost.total`, return null and the caller marks the run's accounting unknown. */
function readUsage(usage: any): ObservedUsage | null {
  const input = nonNegative(usage?.input);
  const output = nonNegative(usage?.output);
  const cached = nonNegative(usage?.cacheRead);
  const cache_write = nonNegative(usage?.cacheWrite);
  const cost = readPrice(usage);
  if (input === null || output === null || cached === null || cache_write === null || cost === null) return null;
  return { input, output, cached, cache_write, cost };
}

/** `EMPTY_USAGE`: every component zero, including `cost.total`. Reading it as
 *  spend would understate; reading it as an accounting failure would make every
 *  provider error and every retry fatal. */
function isEmptyUsage(usage: any): boolean {
  if (!usage || typeof usage !== 'object') return true;
  const components = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens, usage.cost?.total];
  return components.every((value) => value === undefined || value === null || value === 0);
}

function readPrice(usage: any): number | null {
  return nonNegative(usage?.cost?.total);
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A snippet of an alert's context, centred on the match. Clipping from the
 *  front would drop the very token the caller asked to be warned about. */
function alertText(text: string, re: RegExp): string {
  const flat = oneLine(text);
  const match = re.exec(flat);
  if (!match) return clip(flat, ALERT_TEXT_CHARS);
  const start = Math.max(0, match.index - 40);
  const end = Math.min(flat.length, match.index + match[0].length + 40);
  const head = start > 0 ? '…' : '';
  const tail = end < flat.length ? '…' : '';
  return clip(`${head}${flat.slice(start, end)}${tail}`, ALERT_TEXT_CHARS);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** First non-empty line only: a result line is a pointer, not a dump. */
function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
