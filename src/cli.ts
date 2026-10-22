#!/usr/bin/env node
// The `quotient` bin: the one module with side effects at import. Bare, it
// serves MCP on stdio; the verbs are `reduce`, `help` and `--version`.
//
//   quotient                 serve (exit 0 after shutdown)
//   quotient reduce …        the reducer (exit 0 completed, 1 failed or incomplete, 2 usage)
//   quotient help [SECTION]  one section, or the list (exit 2 for an unknown section)
//   quotient --version       the package version
import { serve } from './server/server.ts';
import { main as reduce } from './reduce/cli.ts';
import { packageVersion } from './root.ts';

const USAGE = `usage: quotient                 serve MCP on stdio
       quotient reduce [ARGS]   reduce a pi --mode json event stream
       quotient help [SECTION]  print a help section, or list them
       quotient --version`;

// The help sections (design sec-2). Their text arrives with the help source.
const HELP_SECTIONS = ['agent', 'tool', 'result', 'policy', 'form', 'profiles', 'setup', 'clients', 'reduce'];

function help(section: string | undefined): number {
  if (section === undefined) {
    process.stdout.write(`sections:\n${HELP_SECTIONS.map((name) => `  ${name}\n`).join('')}`);
    return 0;
  }
  if (!HELP_SECTIONS.includes(section)) {
    process.stderr.write(`quotient: no help section "${section}"\n`);
    return 2;
  }
  process.stdout.write(`${section}: not yet written\n`);
  return 0;
}

async function run(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  switch (verb) {
    case undefined:
      if (process.stdin.isTTY) process.stderr.write('quotient: speaks MCP on stdio; run it from an MCP client\n');
      await serve(process.stdin, process.stdout, process.env, process.stderr, { launchDir: process.cwd() });
      return 0;
    case 'reduce':
      return reduce(rest);
    case 'help':
      return help(rest[0]);
    case '--version':
      process.stdout.write(`${packageVersion()}\n`);
      return 0;
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

process.exitCode = await run(process.argv.slice(2));
