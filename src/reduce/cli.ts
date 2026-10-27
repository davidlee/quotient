// `quotient reduce` — I/O, argv and exit codes for the reducer. src/cli.ts
// dispatches here; this module has no side effects at import.
//
// Quiet by default: one status line on stdout, nothing else. Alerts are the only
// thing that may appear unprompted, on stderr, because the caller declared them.
//
//   quotient reduce [FILE]          FILE defaults to stdin
//     --out DIR                     artefact dir (default: FILE's dir, or cwd)
//     --budget-bytes N              transcript ceiling (default 8192, 0 = none)
//     --full                        alias for --budget-bytes 0
//     --alert RE                    warn on a match (repeatable, case-insensitive)
//     -v, --verbose                 transcript to stdout, status line to stderr
//     -q, --quiet                   no status line

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { messageOf } from '../errors.ts';
import { DEFAULT_BUDGET_BYTES, reduce, type Reduced, type Status } from './reduce.ts';

type Args = {
  file: string;
  out: string | null;
  budget: number;
  alerts: string[];
  verbose: boolean;
  quiet: boolean;
};

export const USAGE = `usage: quotient reduce [FILE] [--out DIR] [--budget-bytes N | --full]
                       [--alert RE]... [-v|--verbose] [-q|--quiet]

Reads a pi --mode json event stream (FILE or stdin) and writes <out>/transcript.md
and <out>/status.json. Prints one status line to stdout, or the transcript with -v.

exit: 0 completed · 1 failed or incomplete · 2 usage error`;

/** argv read left to right: `index` is the token most recently taken, so a flag
 *  can consume the value that follows it. */
type Cursor = {
  readonly argv: readonly string[];
  index: number;
};

/** The next token, consuming it; undefined past the end of argv. */
function take(cursor: Cursor): string | undefined {
  cursor.index += 1;
  return cursor.argv.at(cursor.index);
}

/** The token after FLAG, consuming it: a flag with no value is a usage error. */
function takeValue(cursor: Cursor, flag: string): string {
  const next = take(cursor);
  if (next === undefined) {throw new Error(`${flag} needs a value`);}
  return next;
}

/** The switches: no value of their own, each only turns one thing on. */
const SWITCHES = new Map<string, (args: Args) => void>([
  ['-v', (args): void => {args.verbose = true;}],
  ['--verbose', (args): void => {args.verbose = true;}],
  ['-q', (args): void => {args.quiet = true;}],
  ['--quiet', (args): void => {args.quiet = true;}],
  ['--full', (args): void => {args.budget = 0;}],
]);

/** The flags that take a value, and what each one does with it. */
const SETTINGS = new Map<string, (args: Args, given: string) => void>([
  ['--out', (args, given): void => {args.out = given;}],
  ['--alert', (args, given): void => {args.alerts.push(given);}],
  ['--budget-bytes', (args, given): void => {args.budget = budgetBytes(given);}],
]);

/** --budget-bytes: a non-negative integer, or the usage error that says so. */
function budgetBytes(raw: string): number {
  if (!/^\d+$/.test(raw)) {throw new Error('--budget-bytes needs a non-negative integer');}
  return Number(raw);
}

/** The one positional FILE: `-` is stdin, and a second name is a usage error. */
function acceptFile(args: Args, arg: string): void {
  if (arg.startsWith('-') && arg !== '-') {throw new Error(`unknown flag: ${arg}`);}
  if (args.file !== '-') {throw new Error(`unexpected argument: ${arg}`);}
  args.file = arg;
}

/** One argv token: a switch, a value flag, the positional file, or a usage error. */
function step(args: Args, cursor: Cursor, arg: string): void {
  const toggle = SWITCHES.get(arg);
  if (toggle !== undefined) {toggle(args); return;}
  const setting = SETTINGS.get(arg);
  if (setting !== undefined) {setting(args, takeValue(cursor, arg)); return;}
  acceptFile(args, arg);
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { file: '-', out: null, budget: DEFAULT_BUDGET_BYTES, alerts: [], verbose: false, quiet: false };
  const cursor: Cursor = { argv, index: -1 };
  for (let arg = take(cursor); arg !== undefined; arg = take(cursor)) {
    step(args, cursor, arg);
  }
  return args;
}

export function statusLine(status: Status, transcriptPath: string): string {
  const { tokens } = status;
  const money = status.cost_usd?.toFixed(4) ?? 'n/a';
  const peak = status.context.peak_tokens ?? 'n/a';
  return [
    status.state,
    `turns=${String(status.turns)}`,
    `requests=${String(status.requests)}`,
    `unmeasured=${String(status.requests_unmeasured)}`,
    `accounting=${status.accounting}`,
    `context_peak=${String(peak)}`,
    `context_unmeasured=${String(status.context.requests_unmeasured)}`,
    `tools=${String(status.tool_calls)}`,
    `tokens=${String(tokens.input)}/${String(tokens.output)}`,
    `cost=${money}`,
    `transcript=${transcriptPath}`,
  ].join(' ');
}

/** A thrown value's message: an `Error` carries one, anything else is printed
 *  as it is, so a failure never reports `undefined`. */

/** FILE as text: `-` is stdin. */
function readInput(file: string): string {
  return file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
}

/** Where this run's artefacts belong: `--out`, else the input's own directory. */
function outDir(args: Args): string {
  if (args.out !== null) {return args.out;}
  return args.file === '-' ? process.cwd() : dirname(resolve(args.file));
}

/** Write transcript.md and status.json under DIR, making DIR if it is missing;
 *  the transcript path the status line prints. */
function writeArtefacts(dir: string, reduced: Reduced): string {
  if (!existsSync(dir)) {mkdirSync(dir, { recursive: true });}
  const transcriptPath = join(dir, 'transcript.md');
  writeFileSync(transcriptPath, reduced.transcript);
  writeFileSync(join(dir, 'status.json'), `${JSON.stringify(reduced.status, null, 2)}\n`);
  return transcriptPath;
}

/** The alerts on stderr: the caller declared them, so they may appear unprompted. */
function reportAlerts(alerts: Status['alerts']): void {
  for (const alert of alerts) {
    process.stderr.write(`alert ${alert.pattern} :: ${alert.text}\n`);
  }
}

/** The transcript (with -v) and the one status line, each on the stream it
 *  belongs to; `-q` writes no line at all. */
function print(args: Args, reduced: Reduced, transcriptPath: string): void {
  if (args.verbose) {process.stdout.write(reduced.transcript);}
  if (args.quiet) {return;}
  const stream = args.verbose ? process.stderr : process.stdout;
  stream.write(`${statusLine(reduced.status, transcriptPath)}\n`);
}

export function main(argv: string[]): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`quotient reduce: ${messageOf(error)}\n${USAGE}\n`);
    return 2;
  }

  let input: string;
  try {
    input = readInput(args.file);
  } catch (error) {
    process.stderr.write(`quotient reduce: cannot read ${args.file}: ${messageOf(error)}\n`);
    return 2;
  }

  let reduced: Reduced;
  try {
    reduced = reduce(input.split('\n'), { budgetBytes: args.budget, alerts: args.alerts });
  } catch (error) {
    process.stderr.write(`quotient reduce: ${messageOf(error)}\n`);
    return 2;
  }

  const transcriptPath = writeArtefacts(outDir(args), reduced);
  reportAlerts(reduced.status.alerts);
  print(args, reduced, transcriptPath);
  return reduced.status.state === 'completed' ? 0 : 1;
}
