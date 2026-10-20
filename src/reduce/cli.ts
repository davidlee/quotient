// pi-run-reduce CLI — I/O, argv and exit codes for the reducer.
//
// Quiet by default: one status line on stdout, nothing else. Alerts are the only
// thing that may appear unprompted, on stderr, because the caller declared them.
//
//   pi-run-reduce [FILE]            FILE defaults to stdin
//     --out DIR                     artefact dir (default: FILE's dir, or cwd)
//     --budget-bytes N              transcript ceiling (default 8192, 0 = none)
//     --full                        alias for --budget-bytes 0
//     --alert RE                    warn on a match (repeatable, case-insensitive)
//     -v, --verbose                 transcript to stdout, status line to stderr
//     -q, --quiet                   no status line

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { reduce } from './reduce.ts';
import type { Status } from './reduce.ts';

type Args = {
  file: string;
  out: string | null;
  budget: number;
  alerts: string[];
  verbose: boolean;
  quiet: boolean;
};

const USAGE = `usage: pi-run-reduce [FILE] [--out DIR] [--budget-bytes N | --full]
                     [--alert RE]... [-v|--verbose] [-q|--quiet]

Reads a pi --mode json event stream (FILE or stdin) and writes <out>/transcript.md
and <out>/status.json. Prints one status line to stdout, or the transcript with -v.

exit: 0 completed · 1 failed or incomplete · 2 usage error`;

export function parseArgs(argv: string[]): Args {
  const args: Args = { file: '-', out: null, budget: 8192, alerts: [], verbose: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '-v' || arg === '--verbose') args.verbose = true;
    else if (arg === '-q' || arg === '--quiet') args.quiet = true;
    else if (arg === '--full') args.budget = 0;
    else if (arg === '--out') args.out = value();
    else if (arg === '--alert') args.alerts.push(value());
    else if (arg === '--budget-bytes') {
      const raw = value();
      if (!/^\d+$/.test(raw)) throw new Error('--budget-bytes needs a non-negative integer');
      args.budget = Number(raw);
    } else if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown flag: ${arg}`);
    else if (args.file === '-') args.file = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return args;
}

export function statusLine(status: Status, transcriptPath: string): string {
  const { tokens, cost_usd: cost } = status;
  const money = cost === null ? 'n/a' : cost.toFixed(4);
  return [
    status.state,
    `turns=${status.turns}`,
    `tools=${status.tool_calls}`,
    `tokens=${tokens.input}/${tokens.output}`,
    `cost=${money}`,
    `transcript=${transcriptPath}`,
  ].join(' ');
}

export function main(argv: string[]): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`pi-run-reduce: ${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }

  let input: string;
  try {
    input = args.file === '-' ? readFileSync(0, 'utf8') : readFileSync(args.file, 'utf8');
  } catch (error) {
    process.stderr.write(`pi-run-reduce: cannot read ${args.file}: ${(error as Error).message}\n`);
    return 2;
  }

  let reduced;
  try {
    reduced = reduce(input.split('\n'), { budgetBytes: args.budget, alerts: args.alerts });
  } catch (error) {
    process.stderr.write(`pi-run-reduce: ${(error as Error).message}\n`);
    return 2;
  }

  const outDir = args.out ?? (args.file === '-' ? process.cwd() : dirname(resolve(args.file)));
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const transcriptPath = join(outDir, 'transcript.md');
  writeFileSync(transcriptPath, reduced.transcript);
  writeFileSync(join(outDir, 'status.json'), `${JSON.stringify(reduced.status, null, 2)}\n`);

  for (const alert of reduced.status.alerts) {
    process.stderr.write(`alert ${alert.pattern} :: ${alert.text}\n`);
  }
  if (args.verbose) process.stdout.write(reduced.transcript);
  if (!args.quiet) {
    const stream = args.verbose ? process.stderr : process.stdout;
    stream.write(`${statusLine(reduced.status, transcriptPath)}\n`);
  }
  return reduced.status.state === 'completed' ? 0 : 1;
}

if (import.meta.main ?? process.argv[1]?.endsWith('cli.ts')) {
  process.exitCode = main(process.argv.slice(2));
}
