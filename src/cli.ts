#!/usr/bin/env node
// The `quotient` bin: the one module with side effects at import. Bare, it
// serves MCP on stdio; the verbs are `reduce`, `help`, `allow`, `revoke` and
// `--version`.
//
//   quotient                 serve (exit 0 after shutdown)
//   quotient reduce …        the reducer (exit 0 completed, 1 failed or incomplete, 2 usage)
//   quotient help [SECTION]  one section, or the list (exit 2 for an unknown section,
//                            1 for an unreadable help layer)
//   quotient allow [ARGS]    report a project's form identities, or record them
//                            (exit 1 refused, 2 usage); never prompts (DEC-009)
//   quotient revoke [ARGS]   remove recorded approvals (exit 1 if nothing is stored)
//   quotient --version       the package version
import { serve, legacyLayerFailure } from './server/server.ts';
import { main as reduce } from './reduce/cli.ts';
import { allow, revoke } from './approve.ts';
import { packageVersion } from './root.ts';
import { resolveLocations, type Env } from './config.ts';
import { loadProfiles } from './server/profiles.ts';
import { HELP_SECTIONS, loadHelp, renderContext, sectionName, sectionText } from './help/help.ts';

const USAGE = `usage: quotient                 serve MCP on stdio
       quotient reduce [ARGS]   reduce a pi --mode json event stream
       quotient help [SECTION]  print a help section, or list them
       quotient allow [ARGS]    report a project's form identities, or record them
       quotient revoke [ARGS]   remove recorded approvals
       quotient --version`;

/** The two operator verbs' sinks: their text to the streams the bin owns. */
const out = (text: string): void => {process.stdout.write(text);};
const err = (text: string): void => {process.stderr.write(text);};

/**
 * One help section, or the list. It reads the same layers a server launched
 * here would, so it prints what that server would say. An unreadable help layer
 * is the server's start-up refusal and exits 1; a legacy launch-dir layer and a
 * profile snapshot that does not load are only warned about, so `quotient help
 * profiles` still explains the fix while an operator makes it.
 */
function help(section: string | undefined, env: Env, launchDir: string): number {
  if (section === undefined) {
    const aliases = (name: string): string => (name === 'result' ? ' (alias: refusals)' : '');
    process.stdout.write(`sections:\n${HELP_SECTIONS.map((name) => `  ${name}${aliases(name)}\n`).join('')}`);
    return 0;
  }
  const name = sectionName(section);
  if (name === null) {
    process.stderr.write(`quotient: no help section "${section}"\n`);
    return 2;
  }
  const locations = resolveLocations(env);
  /** A start-up failure only warned about: the path to fix, and what it stops. */
  const warn = (what: string, failure: { path: string; detail: string }): void => {
    process.stderr.write(`quotient: ${what}: ${failure.path}: ${failure.detail}\n`);
  };
  const legacy = legacyLayerFailure(locations, launchDir);
  if (legacy !== null) {warn('a server started here refuses every call', legacy);}
  const loaded = loadHelp(locations.helpLayers);
  if (!loaded.ok) {
    process.stderr.write(`quotient: ${loaded.path}: ${loaded.detail}\n`);
    return 1;
  }
  const profiles = loadProfiles(locations.profileLayers);
  if (!profiles.ok) {
    warn('the profile snapshot did not load, so a server started here refuses every call', profiles);
  }
  const text = sectionText(loaded.snapshot, name, renderContext(locations, profiles.ok ? [...profiles.snapshot.profiles.values()] : [], launchDir));
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  return 0;
}

/** SIGTERM and SIGINT shut the server down the way stdin EOF does (DEC-118), so
 *  a client's timeout cannot orphan a child group. Each is handled once: a second
 *  signal takes the default action, the operator's way out of a stuck shutdown. */
function shutdownSignal(): AbortSignal {
  const shutdown = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT'] as const) {process.once(name, () => { shutdown.abort(name); });}
  return shutdown.signal;
}

/** The bare invocation: serve this process's own stdin and stdout. A terminal is
 *  not an MCP client, so it gets a note first. */
async function serveStdio(): Promise<number> {
  if (process.stdin.isTTY) {process.stderr.write('quotient: speaks MCP on stdio; run it from an MCP client. Try `quotient help`. Ctrl-D exits.\n');}
  await serve(process.stdin, process.stdout, process.env, process.stderr, {
    launchDir: process.cwd(),
    signal: shutdownSignal(),
  });
  return 0;
}

async function run(argv: string[]): Promise<number> {
  // Spelled out rather than destructured: `argv` may be empty, and `case undefined`
  // is then the reading of no verb at all.
  const verb = argv.length > 0 ? argv[0] : undefined;
  const rest = argv.slice(1);
  switch (verb) {
    case undefined:
      return serveStdio();
    case 'reduce':
      return reduce(rest);
    case 'help':
      return help(rest[0], process.env, process.cwd());
    case 'allow':
      return allow(rest, process.env, process.cwd(), out, err);
    case 'revoke':
      return revoke(rest, process.env, process.cwd(), out, err);
    case '--version':
      process.stdout.write(`${packageVersion()}\n`);
      return 0;
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

process.exitCode = await run(process.argv.slice(2));
