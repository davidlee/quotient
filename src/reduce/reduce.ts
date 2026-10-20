// pi-run-reduce — turn a pi `--mode json` event stream into the signal an
// orchestrator actually needs: a budgeted transcript, a status record, and alert
// lines for patterns the caller declared it cares about.
//
// Pure: lines in, { transcript, status } out. No I/O, no argv, no process. The
// shell entry point (`bin/pi-run-reduce` → `cli.ts`) and the future pi-agent MCP
// server both call this, so there is one reducer and one idea of what a run was.
//
// Fidelity rules, in order of importance:
//   1. The final assistant answer is always present and always last.
//   2. Assistant prose is verbatim; thinking is dropped.
//   3. Tool calls become one line each; tool results keep their first line only.
//   4. Context echo (system/user message replays) is dropped entirely — it is
//      ~72% of the raw stream and none of it is new information.
//   5. Whatever the budget cannot hold is elided from the MIDDLE, so both the
//      opening moves and the latest moves survive.

export const SCHEMA = 'pi-run-status/1';

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
  tokens: { input: number; output: number; cached: number };
  cost_usd: number | null;
  session_id: string | null;
  cwd: string | null;
  model: string | null;
  last_stop_reason: string | null;
  alerts: { pattern: string; text: string }[];
  transcript: { bytes: number; records: number; malformed: number; elided: number };
};

export type Reduced = { transcript: string; status: Status };

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
  const usage = { input: 0, output: 0, cached: 0 };
  let cost: number | null = null;

  const add = (entry: Entry): void => {
    entries.push(entry);
    for (const { pattern, re } of patterns) {
      if (alerts.length >= MAX_ALERTS) break;
      if (re.test(entry.text)) {
        alerts.push({ pattern, text: alertText(entry.text, re) });
      }
    }
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

    switch (event.type) {
      case 'session':
        sessionId = typeof event.id === 'string' ? event.id : null;
        cwd = typeof event.cwd === 'string' ? event.cwd : null;
        break;

      case 'message_end': {
        const message = event.message ?? {};
        if (message.role !== 'assistant') break; // context echo: system + user replays
        turns += 1;
        stopReason = typeof message.stopReason === 'string' ? message.stopReason : stopReason;
        model = typeof message.model === 'string' ? message.model : model;
        absorb(usage, message.usage);
        cost = (cost ?? 0) + (totalCost(message.usage) ?? 0);
        for (const block of message.content ?? []) {
          if (block?.type !== 'text' || !block.text?.trim()) continue; // thinking and toolCalls render elsewhere
          add({ kind: 'prose', line: block.text.trimEnd(), text: block.text });
        }
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

  // The final prose entry IS the result: render it once, at the end, not inline.
  let result: string | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === 'prose') {
      result = entries[i].line;
      entries.splice(i, 1);
      break;
    }
  }

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
      tokens: usage,
      cost_usd: cost,
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

/** Each assistant message reports its own turn's usage; the run total is the sum.
 *  `input` counts prompt tokens per turn, so a cache hit still shows as a write
 *  of the same size — the number is scale, not billing. */
function absorb(into: { input: number; output: number; cached: number }, usage: any): void {
  if (!usage) return;
  if (typeof usage.input === 'number') into.input += usage.input;
  if (typeof usage.output === 'number') into.output += usage.output;
  if (typeof usage.cacheRead === 'number') into.cached += usage.cacheRead;
}

function totalCost(usage: any): number | null {
  const total = usage?.cost?.total;
  return typeof total === 'number' ? total : null;
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
