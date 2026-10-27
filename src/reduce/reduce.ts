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

import { at, isRecord } from '../json.ts';

export const SCHEMA = 'pi-run-status/3';

/** Whether every ordinary cost observation needed for the result was valid.
 *  Context completeness is reported independently in `Status.context`. */
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
  /** Legacy tolerated cost gaps: failed sends and scheduled summarization retries. */
  requests_unmeasured: number;
  context: { peak_tokens: number | null; requests_unmeasured: number };
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

/** A pi event, read loosely: the stream has no contract here, so every field is
 *  `unknown` and narrowed where it is used. */
type Event = Record<string, unknown>;

type Entry = {
  kind: 'prose' | 'call' | 'result' | 'error';
  /** Rendered line(s), no trailing newline. */
  line: string;
  /** Unrendered text, for alert matching only. Never persisted. */
  text: string;
};

/** The last assistant message seen and where its own prose landed. A later
 *  assistant `message_start` or `message_end` replaces it, so only a message
 *  with none after it can be the terminal one. */
type Candidate = {
  stopReason: string | null;
  texts: string[];
  entryIndices: number[];
};

/** What one reduction accumulates: the entries it will render, the alerts it has
 *  raised, and the stream-side facts the status and the answer come from. */
type Run = {
  entries: Entry[];
  alerts: Status['alerts'];
  patterns: { pattern: string; re: RegExp }[];
  tally: Tally;
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  settled: boolean;
  records: number;
  malformed: number;
  turns: number;
  toolCalls: number;
  stopReason: string | null;
  candidate: Candidate | null;
};

/** The transcript's byte ceiling when a caller names none. */
export const DEFAULT_BUDGET_BYTES = 8192;

const CALL_ARG_CHARS = 120;
const RESULT_CHARS = 200;
const ERROR_CHARS = 500;
const ALERT_TEXT_CHARS = 160;
const MAX_ALERTS = 50;

export function reduce(lines: string[], opts: ReduceOptions = {}): Reduced {
  const run = createRun(opts.alerts ?? []);
  for (const raw of lines) {applyLine(run, raw);}
  return finish(run, opts.budgetBytes ?? DEFAULT_BUDGET_BYTES);
}

/** The state a reduction starts from: nothing seen, nothing said. */
function createRun(alerts: string[]): Run {
  return {
    entries: [],
    alerts: [],
    patterns: alerts.map((pattern) => ({ pattern, re: new RegExp(pattern, 'i') })),
    tally: createTally(),
    sessionId: null,
    cwd: null,
    model: null,
    settled: false,
    records: 0,
    malformed: 0,
    turns: 0,
    toolCalls: 0,
    stopReason: null,
    candidate: null,
  };
}

/** Fold one raw line into RUN. A line that parses to anything but a JSON object
 *  (`null`, a boolean, a number, a string, an array) is a malformed line, not an
 *  event — the same rule the server's live observer applies. */
function applyLine(run: Run, raw: string): void {
  if (raw.trim() === '') {return;}
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    run.malformed += 1;
    return;
  }
  if (!isRecord(parsed)) {
    run.malformed += 1;
    return;
  }
  run.records += 1;
  countRecord(parsed, run.tally);
  applyEvent(run, parsed);
}

/** Render ENTRY, raise the alerts it matches, and answer the entry's index so the
 *  answer can be spliced back out of the body. */
function addEntry(run: Run, entry: Entry): number {
  run.entries.push(entry);
  for (const { pattern, re } of run.patterns) {
    if (run.alerts.length >= MAX_ALERTS) {break;}
    if (re.test(entry.text)) {run.alerts.push({ pattern, text: alertText(entry.text, re) });}
  }
  return run.entries.length - 1;
}

/** Route one event to its observer. An event type the reducer does not know is
 *  counted as a record and otherwise ignored. */
function applyEvent(run: Run, event: Event): void {
  switch (event.type) {
    case 'session':
      observeSession(run, event);
      return;

    case 'message_start':
      applyMessageStart(run, event);
      return;

    case 'message_end':
      applyMessageEnd(run, event);
      return;

    case 'tool_execution_start':
      applyToolStart(run, event);
      return;

    case 'tool_execution_end':
      applyToolEnd(run, event);
      return;

    case 'agent_end':
      observeAgentEnd(run, event);
      return;

    case 'agent_settled':
      run.settled = true;
      return;
  }
}

/** A message that has begun invalidates the earlier candidate: the answer is
 *  only known once the stream has no assistant message after it. */
function applyMessageStart(run: Run, event: Event): void {
  if (at(event, 'message', 'role') === 'assistant') {run.candidate = null;}
}

function observeSession(run: Run, event: Event): void {
  run.sessionId = stringOr(at(event, 'id'), null);
  run.cwd = stringOr(at(event, 'cwd'), null);
}

function applyMessageEnd(run: Run, event: Event): void {
  const message = at(event, 'message');
  if (at(message, 'role') !== 'assistant') {return;} // context echo: system + user replays
  run.turns += 1;
  run.stopReason = stringOr(at(message, 'stopReason'), run.stopReason);
  run.model = stringOr(at(message, 'model'), run.model);
  run.candidate = {
    stopReason: stringOr(at(message, 'stopReason'), null),
    ...renderProse(run, at(message, 'content')),
  };
}

/** The assistant message's prose, rendered as entries: thinking and tool calls
 *  render elsewhere. Only a text block with non-blank text is prose. */
function renderProse(run: Run, content: unknown): { texts: string[]; entryIndices: number[] } {
  const texts: string[] = [];
  const entryIndices: number[] = [];
  for (let index = 0; index < arrayLength(content); index++) {
    const block = at(content, index);
    if (at(block, 'type') !== 'text') {continue;}
    const text = at(block, 'text');
    if (typeof text !== 'string' || text.trim() === '') {continue;}
    texts.push(text.trimEnd());
    entryIndices.push(addEntry(run, { kind: 'prose', line: text.trimEnd(), text }));
  }
  return { texts, entryIndices };
}

function applyToolStart(run: Run, event: Event): void {
  run.toolCalls += 1;
  const name = at(event, 'toolName');
  const signature = describeCall(name, at(event, 'args'));
  addEntry(run, { kind: 'call', line: `→ ${signature}`, text: `${String(name)} ${signature}` });
}

function applyToolEnd(run: Run, event: Event): void {
  const result = at(event, 'result');
  const text = resultText(result);
  const exit = at(result, 'structuredContent', 'exit_code');
  if (Boolean(at(event, 'isError'))) {
    addEntry(run, { kind: 'error', line: `  ✗ ${clip(firstLine(text), ERROR_CHARS)}`, text });
    return;
  }
  const tag = typeof exit === 'number' && exit !== 0 ? `[exit ${String(exit)}] ` : '';
  addEntry(run, { kind: 'result', line: `  ↳ ${tag}${clip(firstLine(text), RESULT_CHARS)}`, text });
}

const PREFERRED_ARGUMENTS = ['command', 'path', 'file', 'query', 'pattern'];

function describeCall(name: unknown, args: unknown): string {
  const tool = typeof name === 'string' ? name : 'tool';
  return `${tool}(${clip(oneLine(callText(args)), CALL_ARG_CHARS)})`;
}

/** What a call was asked to do: the first preferred argument it names, else the
 *  first string it holds, else its whole shape. */
function callText(args: unknown): string {
  const named = PREFERRED_ARGUMENTS.map((key) => at(args, key)).find((value) => typeof value === 'string');
  if (typeof named === 'string') {return named;}
  const values = callArgumentValues(args);
  const spoken = values.find((value) => typeof value === 'string');
  if (typeof spoken === 'string') {return spoken;}
  return values.length > 0 ? JSON.stringify(args) : '';
}

/** The values a call's arguments hold, in key order: an object's own values, or
 *  an array's elements. */
function callArgumentValues(args: unknown): unknown[] {
  if (isRecord(args)) {return Object.keys(args).map((key) => at(args, key));}
  const values: unknown[] = [];
  for (let index = 0; index < arrayLength(args); index++) {values.push(at(args, index));}
  return values;
}

/** A tool result's text: its own text blocks, else its structured output. */
function resultText(result: unknown): string {
  const parts = textParts(at(result, 'content'));
  if (parts.length > 0) {return parts.join('\n');}
  const output = at(result, 'structuredContent', 'output');
  return typeof output === 'string' ? output : '';
}

/** Every text block's text, in order: a result's own words, blanks dropped. */
function textParts(content: unknown): string[] {
  const parts: string[] = [];
  for (let index = 0; index < arrayLength(content); index++) {
    const text = at(content, index, 'text');
    if (typeof text === 'string' && text !== '') {parts.push(text);}
  }
  return parts;
}

/** `messages` replays what `message_end` already delivered: usage here would
 *  double-count the run, so only the model is taken from it. */
function observeAgentEnd(run: Run, event: Event): void {
  const messages = at(event, 'messages');
  const model = at(messages, arrayLength(messages) - 1, 'model');
  if (typeof model === 'string') {run.model = model;}
}

/** The stream folded: the transcript, the status, and sec-5's answer. */
function finish(run: Run, budget: number): Reduced {
  const terminal = terminalMessage(run.candidate);
  const result = terminal === null ? null : takeAnswer(run, terminal);
  // The stream's verdict, in the reducer's three-way vocabulary. Precedence among
  // causes is the server's (design sec-5), so the stream-side facts it needs
  // travel beside this rather than being folded into it: `terminalReason`,
  // `settled`, `accounting`.
  const state = streamState(run.stopReason, run.settled);
  const header = `# pi run ${run.sessionId ?? 'unknown'} · ${String(run.records)} records\n\n`;
  const resultBlock = result === null || result === ''
    ? '\n## Result\n(no assistant answer)\n'
    : `\n## Result\n${result}\n`;
  // `budget <= 0` means unbounded; anything else budgets what is LEFT of the
  // header and the result block, both of which are mandatory. A budget smaller
  // than those two still elides (room floors at 1), and the status reports the
  // honest byte count rather than pretending the ceiling held.
  const overhead = Buffer.byteLength(header) + Buffer.byteLength(resultBlock);
  const room = budget <= 0 ? 0 : Math.max(1, budget - overhead);
  const { blocks, elided } = fit(run.entries, room);
  const transcript = header + blocks + resultBlock;
  const { tally } = run;
  return {
    transcript,
    status: {
      schema: SCHEMA,
      state,
      turns: run.turns,
      tool_calls: run.toolCalls,
      requests: tally.requests,
      requests_unmeasured: tally.requests_unmeasured,
      context: { ...tally.context },
      tokens: tally.tokens,
      cost_usd: tally.cost,
      accounting: tally.accounting,
      session_id: run.sessionId,
      cwd: run.cwd,
      model: run.model,
      last_stop_reason: run.stopReason,
      alerts: run.alerts,
      transcript: {
        bytes: Buffer.byteLength(transcript),
        records: run.records,
        malformed: run.malformed,
        elided,
      },
    },
    result,
    terminalReason: run.stopReason,
    settled: run.settled,
    truncated: run.stopReason === 'length',
    requests: tally.requests,
    requests_unmeasured: tally.requests_unmeasured,
    accounting: tally.accounting,
  };
}

/** sec-5's answer: the terminal message's prose, every block joined and spliced
 *  out of the body, descending so the earlier indices stay valid. An answerless
 *  terminal message yields no result rather than a backwards search for the last
 *  prose block. */
function takeAnswer(run: Run, terminal: Candidate): string | null {
  if (terminal.texts.length === 0) {return null;}
  for (const index of [...terminal.entryIndices].sort((a, b) => b - a)) {run.entries.splice(index, 1);}
  return terminal.texts.join('\n\n');
}

function streamState(stopReason: string | null, settled: boolean): Status['state'] {
  if (stopReason === 'error' || stopReason === 'aborted') {return 'failed';}
  return settled ? 'completed' : 'incomplete';
}

type Unit = { lines: string[]; kind: Entry['kind'] };

/** Fold each tool call together with the result that immediately followed it. */
function units(entries: Entry[]): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const next = entries.at(i + 1);
    if (entry.kind === 'call' && next !== undefined && (next.kind === 'result' || next.kind === 'error')) {
      out.push({ lines: [entry.line, next.line], kind: 'call' });
      i += 1;
    } else {
      out.push({ lines: [entry.line], kind: entry.kind });
    }
  }
  return out;
}

/** One rendered block, the identity it collapsed on, and how many identical
 *  units it stands for. */
type ActivityRun = { unit: Unit; key: string; count: number };

/** Group units into runs of identical activity, so a retried command folds. */
function activityRuns(sequence: Unit[]): ActivityRun[] {
  const runs: ActivityRun[] = [];
  for (const unit of sequence) {
    const key = activityKey(unit);
    const last = runs.at(-1);
    if (last?.key === key) {
      last.count += 1;
      continue;
    }
    runs.push({ unit, key, count: 1 });
  }
  return runs;
}

/** The identity two units must share to collapse: their rendered lines. */
function activityKey(unit: Unit): string {
  return unit.lines.join('\u0000');
}

/** One run rendered: the count belongs to the action, the output is shown once. */
function renderRun(run: ActivityRun): string {
  const [first, ...rest] = run.unit.lines;
  const head = run.count > 1 ? `${first} ×${String(run.count)}` : first;
  // Prose keeps a blank line after it so the transcript stays readable; tool
  // lines stack compactly.
  const suffix = run.unit.kind === 'prose' ? '\n\n' : '\n';
  return [head, ...rest].join('\n') + suffix;
}

/** Render entries to blocks, collapsing runs of identical ACTIVITY, then elide
 *  the middle until the rendered size fits `budget`.
 *
 *  A unit is a call plus the result that followed it, kept together so a retried
 *  command folds as a whole: `→ bash(cmd) ×3` above one representative output.
 *  Collapsing on single lines would never fire — call and result alternate. */
function fit(entries: Entry[], budget: number): { blocks: string; elided: number } {
  const rendered = activityRuns(units(entries)).map(renderRun);
  const sizes = rendered.map((block) => Buffer.byteLength(block));
  const total = totalBytes(sizes);
  if (budget <= 0 || total <= budget) {return { blocks: rendered.join(''), elided: 0 };}
  return elideMiddle(rendered, sizes, total, budget);
}

/** Drop blocks from the middle outward until the rendered total fits `budget`,
 *  leaving a marker where they were. */
function elideMiddle(
  rendered: string[],
  sizes: number[],
  total: number,
  budget: number,
): { blocks: string; elided: number } {
  const keep = rendered.map(() => true);
  let remaining = total;
  let elided = 0;
  for (const index of centreOutOrder(rendered.length)) {
    if (remaining + marker(elided + 1).length <= budget) {break;}
    remaining -= sizes[index];
    keep[index] = false;
    elided += 1;
  }

  const kept = rendered.filter((_, index) => keep[index]);
  if (elided > 0) {kept.splice(Math.floor(kept.length / 2), 0, marker(elided));}
  return { blocks: kept.join(''), elided };
}

/** The indices to drop, from the centre outward, so the first and last entries
 *  survive. */
function centreOutOrder(count: number): number[] {
  const order: number[] = [];
  const middle = Math.floor(count / 2);
  for (let step = 0; step < count; step++) {
    if (middle - step > 0) {order.push(middle - step);}
    if (step > 0 && middle + step < count - 1) {order.push(middle + step);}
  }
  return order;
}

/** The rendered size of every block, summed. */
function totalBytes(sizes: number[]): number {
  let total = 0;
  for (const size of sizes) {total += size;}
  return total;
}

function marker(count: number): string {
  return `… ${String(count)} entries elided\n`;
}

/** Stop reasons that accrue tokens; every other reason does not, though its cost
 *  still does. pi's tokens, verbatim (`docs/message-types.md`). */
const NO_TOKEN_STOP_REASONS = new Set(['error', 'aborted']);
/** Stop reasons that answer. Everything else — `toolUse`, `deferred`, `error`,
 *  `aborted`, `pending`, and any reason pi adds later — is counted and is not. */
const ANSWER_STOP_REASONS = new Set(['stop', 'length']);

/** Whether VALUE is one of TOKENS: pi's stop reasons are strings, and a
 *  non-string is never one of them. */
function isStopReason(value: unknown, tokens: Set<string>): boolean {
  return typeof value === 'string' && tokens.has(value);
}

/** The terminal assistant message, if the stream ended on one: the last assistant
 *  `message_end`, with no later assistant message, stopped for a reason that
 *  answers. `pending` is the in-flight marker, so it is not terminal; nor are
 *  `error`, `aborted`, `toolUse`, `deferred`, or any reason pi adds later. */
function terminalMessage(candidate: Candidate | null): Candidate | null {
  if (candidate === null) {return null;}
  const { stopReason } = candidate;
  if (stopReason === null || stopReason === 'pending') {return null;}
  return isStopReason(stopReason, ANSWER_STOP_REASONS) ? candidate : null;
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
export function countRecord(event: unknown, tally: Tally): void {
  switch (at(event, 'type')) {
    case 'message_end':
      countMessageEnd(event, tally);
      return;

    case 'compaction_end':
      countCompactionEnd(event, tally);
      return;

    case 'summarization_retry_scheduled':
      // A send returned an error; its retry is the next `compaction_end`. There is
      // no usage evidence for this one, so it is counted and disclosed.
      tally.requests += 1;
      tally.requests_unmeasured += 1;
      tally.context.requests_unmeasured += 1;
      return;
  }
}

/** One assistant send: a request whatever its stop reason, its usage observed for
 *  context, its tokens accrued only when the send did not fail. */
function countMessageEnd(event: unknown, tally: Tally): void {
  const message = at(event, 'message');
  if (at(message, 'role') !== 'assistant') {return;} // context echo, not a send
  tally.requests += 1;
  const usage = at(message, 'usage');
  const failedSend = isStopReason(at(message, 'stopReason'), NO_TOKEN_STOP_REASONS);
  observeContext(usage, tally, failedSend);
  if (failedSend) {
    countFailedSend(usage, tally);
    return;
  }
  accrue(usage, tally);
}

/** A summarization send that came back: counted, observed and accrued from its
 *  `result.usage`. No `result` at all means no send left the process. */
function countCompactionEnd(event: unknown, tally: Tally): void {
  const result = at(event, 'result');
  if (!isObjectLike(result)) {return;}
  tally.requests += 1;
  const usage = at(result, 'usage');
  observeContext(usage, tally);
  accrue(usage, tally);
}

/** Record the independent context observation for one already-classified send.
 *  Missing/invalid token components are gaps, never inferred from totalTokens.
 *  Failed sends with an all-zero vector carry provider placeholders, not a
 *  measured zero. This intentionally does not alter cost or cumulative tokens. */
function observeContext(usage: unknown, tally: Tally, failedSend = false): void {
  const tokens = readTokens(usage);
  if (tokens === null || (failedSend && isZeroTokens(tokens))) {
    tally.context.requests_unmeasured += 1;
    return;
  }

  const footprint = tokens.input + tokens.cached + tokens.cache_write + tokens.output;
  if (!Number.isFinite(footprint)) {
    tally.context.requests_unmeasured += 1;
    return;
  }
  tally.context.peak_tokens = Math.max(tally.context.peak_tokens ?? footprint, footprint);
}

/** Every component of a usage vector is zero: `EMPTY_USAGE`'s placeholder. */
function isZeroTokens(tokens: ObservedTokens): boolean {
  return tokens.input === 0 && tokens.output === 0 && tokens.cached === 0 && tokens.cache_write === 0;
}

/** Observe tokens and cost independently. A missing context vector never hides
 *  a valid price, and a missing price never discards valid cumulative tokens. */
function accrue(usage: unknown, tally: Tally): void {
  const tokens = readTokens(usage);
  if (tokens !== null) {
    tally.tokens.input += tokens.input;
    tally.tokens.output += tokens.output;
    tally.tokens.cached += tokens.cached;
    tally.tokens.cache_write += tokens.cache_write;
  }

  const price = readPrice(usage);
  if (price === null) {
    tally.accounting = 'unknown';
  } else {
    tally.cost = (tally.cost ?? 0) + price;
  }
}

/** A failed send was still paid for, so its cost accrues while its tokens do not —
 *  the asymmetry design sec-4 states and the tests assert. Its usage is usually
 *  `EMPTY_USAGE` — zeros, including `cost.total` — which is a placeholder rather
 *  than an observation: the request is counted, disclosed as
 *  `requests_unmeasured`, and contributes nothing (operator-accepted, DEC-097). */
function countFailedSend(usage: unknown, tally: Tally): void {
  const price = isEmptyUsage(usage) ? null : readPrice(usage);
  if (price === null) {
    tally.requests_unmeasured += 1;
    return;
  }
  tally.cost = (tally.cost ?? 0) + price;
}

type ObservedTokens = {
  input: number;
  output: number;
  cached: number;
  cache_write: number;
};

/** Read the cumulative token vector independently from cost validity. */
function readTokens(usage: unknown): ObservedTokens | null {
  const input = nonNegative(at(usage, 'input'));
  const output = nonNegative(at(usage, 'output'));
  const cached = nonNegative(at(usage, 'cacheRead'));
  const cache_write = nonNegative(at(usage, 'cacheWrite'));
  if (input === null || output === null || cached === null || cache_write === null) {return null;}
  return { input, output, cached, cache_write };
}

/** `EMPTY_USAGE`: every component zero, including `cost.total`. Reading it as
 *  spend would understate; reading it as an accounting failure would make every
 *  provider error and every retry fatal. */
function isEmptyUsage(usage: unknown): boolean {
  if (!isObjectLike(usage)) {return true;}
  const components = [
    at(usage, 'input'),
    at(usage, 'output'),
    at(usage, 'cacheRead'),
    at(usage, 'cacheWrite'),
    at(usage, 'totalTokens'),
    at(usage, 'cost', 'total'),
  ];
  return components.every(isAbsentOrZero);
}

/** A usage component that carries no observation: absent, nullish or zero. */
function isAbsentOrZero(value: unknown): boolean {
  return value === undefined || value === null || value === 0;
}

function readPrice(usage: unknown): number | null {
  return nonNegative(at(usage, 'cost', 'total'));
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Whatever the loose readers step into: any non-null object, arrays included —
 *  the reducer's rule, broader than `isRecord`'s by design. */
function isObjectLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/** The number of items VALUE holds when it is an array, else zero: the loop bound
 *  for a loose reader, with `at` answering undefined past it. */
function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** VALUE when pi wrote a string there, else FALLBACK: a stream field is never
 *  inferred from another type. */
function stringOr(value: unknown, fallback: string | null): string | null {
  return typeof value === 'string' ? value : fallback;
}

/** A snippet of an alert's context, centred on the match. Clipping from the
 *  front would drop the very token the caller asked to be warned about. */
function alertText(text: string, re: RegExp): string {
  const flat = oneLine(text);
  const match = re.exec(flat);
  if (match === null) {return clip(flat, ALERT_TEXT_CHARS);}
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

/** The verdict on a stream nothing wrote: a run that ended before any line was
 *  read still owes a status. Last in the module, so every constant `reduce`
 *  reads is initialised. */
export const EMPTY_STATUS = reduce([], {}).status;
