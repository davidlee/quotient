// Drift tests: the shipped documents against the code they describe.
//
// Five checks, each a pure function from a document's text to its violations, so
// a negative control runs the very same function over a doctored copy and must
// see it fail:
//
//   refusal tokens     the refusal unions in the sources = the contract's Refusals table
//   keys and types     every fixture result, at every nesting level = the Fields table
//   result semantics   CAUSE_STATE, RESULT_STATES, TERMINATIONS = the contract's tables
//   policy             every accepted policy key and env var is documented; every
//                      ```json block is a policy validatePolicy admits
//   no doctrine ids    no shipped text cites an id from the repo it was extracted from
//
// The fixture results are built offline by the real reducer and the server's own
// builders (`resultFor`, `failedResult`, `refusedResult`): the functions every
// answer the server writes goes through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { reduce } from './reduce/reduce.ts';
import {
  CAUSE_STATE,
  failedResult,
  refusedResult,
  RESULT_REFUSAL_REASONS,
  RESULT_STATES,
  TERMINATIONS,
} from './server/result.ts';
import type { AgentResult } from './server/result.ts';
import {
  FORM_KEYS,
  MAXIMA_FIELDS,
  OPTIONAL_FIELDS,
  readPolicy,
  REQUIRED_FIELDS,
  STATIC_ONLY_FIELDS,
} from './server/policy.ts';
import { FILESYSTEMS } from './server/profiles.ts';
import { ARTIFACTS, buildResult, messageEnd, SETTLED_RECORD, workspace } from './server/test-rig.ts';

const repo = (path: string): string => new URL(`../${path}`, import.meta.url).pathname;
const read = (path: string): string => readFileSync(repo(path), 'utf8');

const RESULT_CONTRACT = 'docs/contract/pi-agent-result-1.md';
const POLICY_CONTRACT = 'docs/contract/quotient-policy-1.md';

// ── Reading the documents ──────────────────────────────────────────────────

/** The rows of the first markdown table under `## <heading>`, header and rule
 *  dropped, each cell trimmed and stripped of one pair of backticks. */
function table(text: string, heading: string): string[][] {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return [];
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  const section = end < 0 ? rest : rest.slice(0, end);
  const rows = section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .slice(1, line.endsWith('|') ? -1 : undefined)
        .split('|')
        .map((cell) => cell.trim().replace(/^`(.*)`$/, '$1')),
    );
  return rows.slice(2);
}

/** Set difference both ways, as violation lines. */
function bothWays(what: string, code: Iterable<string>, doc: Iterable<string>): string[] {
  const inCode = new Set(code);
  const inDoc = new Set(doc);
  return [
    ...[...inCode].filter((token) => !inDoc.has(token)).map((token) => `${what}: \`${token}\` is in the code, not the contract`),
    ...[...inDoc].filter((token) => !inCode.has(token)).map((token) => `${what}: \`${token}\` is in the contract, not the code`),
  ];
}

const backticked = (text: string, token: string): boolean => text.includes(`\`${token}\``);

// ── Refusal tokens ─────────────────────────────────────────────────────────

/**
 * The refusal reasons declared only as TypeScript unions (`RefusalReason`,
 * `FormRefusal`, `SessionRefusal`, …), erased at runtime, so read from the
 * sources' `export type …Refusal… =` declarations; plus the runtime list in
 * result.ts. A reason added to a union fails until the contract names it.
 */
function codeRefusals(): string[] {
  const dir = repo('src/server');
  const reasons: string[] = [...RESULT_REFUSAL_REASONS];
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))) {
    for (const [, union] of readFileSync(join(dir, name), 'utf8').matchAll(/export type \w*Refusal\w* =([^;]*);/g)) {
      for (const [, reason] of union.matchAll(/'([a-z-]+)'/g)) reasons.push(reason);
    }
  }
  return reasons;
}

function refusalViolations(contract: string, reasons: readonly string[]): string[] {
  return bothWays('refusal', reasons, table(contract, 'Refusals').map((row) => row[0]));
}

// ── Keys and types ─────────────────────────────────────────────────────────

type Field = { type: string; nullable: boolean };

/** The Fields table: path → JSON type and nullability. An array's elements are
 *  `<path>[]`, an object's members `<path>.<key>`. */
function fields(contract: string): Map<string, Field> {
  return new Map(table(contract, 'Fields').map((row) => [row[0], { type: row[1], nullable: row[2] === 'yes' }]));
}

const jsonType = (value: unknown): string => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

/** The documented children of PATH: `''` is the document itself. */
function childrenOf(table: Map<string, Field>, path: string): string[] {
  const prefix = path === '' ? '' : `${path}.`;
  return [...table.keys()]
    .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('.') && !key.slice(prefix.length).includes('[]'))
    .map((key) => key.slice(prefix.length));
}

/**
 * One fixture against the Fields table: at every object, the key set equals the
 * documented children both ways; every value's JSON type is the documented one;
 * `null` appears only where the field is nullable. Records each null it saw.
 */
function shapeViolations(doc: AgentResult, documented: Map<string, Field>, label: string, nulls: Set<string>): string[] {
  const violations: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (path !== '') {
      const field = documented.get(path);
      if (field === undefined) {
        violations.push(`${label}: \`${path}\` is not in the Fields table`);
        return;
      }
      if (value === null) {
        nulls.add(path);
        if (!field.nullable) violations.push(`${label}: \`${path}\` is null, and the Fields table says non-nullable`);
        return;
      }
      if (jsonType(value) !== field.type) {
        violations.push(`${label}: \`${path}\` is ${jsonType(value)}, and the Fields table says ${field.type}`);
        return;
      }
    }
    if (Array.isArray(value)) {
      for (const element of value) walk(element, `${path}[]`);
    } else if (typeof value === 'object' && value !== null) {
      violations.push(...bothWays(`${label}: keys of \`${path || '(document)'}\``, Object.keys(value), childrenOf(documented, path)));
      for (const [key, member] of Object.entries(value)) walk(member, path === '' ? key : `${path}.${key}`);
    }
  };
  walk(doc, '');
  return violations;
}

/** The whole check over a fixture set: each fixture's shape, plus every nullable
 *  field null in at least one fixture (else its null is never checked). */
function keysAndTypesViolations(contract: string, fixtures: Record<string, AgentResult>): string[] {
  const documented = fields(contract);
  if (documented.size === 0) return ['the contract has no Fields table'];
  const nulls = new Set<string>();
  const violations = Object.entries(fixtures).flatMap(([label, doc]) => shapeViolations(doc, documented, label, nulls));
  for (const [path, field] of documented) {
    if (field.nullable && !nulls.has(path)) violations.push(`nullable \`${path}\` is null in no fixture`);
  }
  return violations;
}

/** One result per state, and the arms that reach the same states another way. */
function fixtures(): Record<string, AgentResult> {
  const answering = [messageEnd('stop'), SETTLED_RECORD];
  const results: Record<string, AgentResult> = {
    completed: buildResult({ lines: answering, alerts: ['answer'] }).doc,
    failed: buildResult({ lines: [], exitCode: null, spawnFailed: true }).doc,
    'failed (server arm)': failedResult('error', ['error'], 'sess-1', reduce([], {}).status, ARTIFACTS),
    incomplete: buildResult({ lines: [] }).doc,
    timeout: buildResult({ lines: answering, causes: ['timeout'] }).doc,
    cancelled: buildResult({ lines: answering, causes: ['cancelled'] }).doc,
    ceiling_exceeded: buildResult({ lines: answering, causes: ['ceiling'] }).doc,
    accounting_unknown: buildResult({ lines: [messageEnd('stop', 'the answer', { input: undefined }), SETTLED_RECORD] }).doc,
    audit_failed: buildResult({ lines: answering, causes: ['audit'] }).doc,
    refused: refusedResult('disabled', 'the operator switch is off'),
  };
  return results;
}

// ── Result semantics ───────────────────────────────────────────────────────

function semanticsViolations(contract: string): string[] {
  const rows = table(contract, 'Terminations');
  const documented = new Map(rows.map((row) => [row[0], row[1]]));
  const violations = [
    ...bothWays('state', RESULT_STATES, table(contract, 'States').map((row) => row[0])),
    ...bothWays('termination', TERMINATIONS, documented.keys()),
  ];
  for (const [termination, state] of Object.entries(CAUSE_STATE)) {
    const row = documented.get(termination);
    if (row !== undefined && row !== state) {
      violations.push(`termination \`${termination}\`: the contract says ${row}, CAUSE_STATE says ${state}`);
    }
  }
  return violations;
}

// ── Policy ─────────────────────────────────────────────────────────────────

/** The environment variables `config.ts` reads: its quoted variable names and
 *  its `env.NAME` reads. */
function configVars(): string[] {
  const source = read('src/config.ts');
  return [...new Set([...source.matchAll(/'([A-Z][A-Z0-9_]+)'/g), ...source.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]))];
}

const POLICY_KEYS = [
  ...REQUIRED_FIELDS,
  ...OPTIONAL_FIELDS,
  ...STATIC_ONLY_FIELDS,
  ...MAXIMA_FIELDS.map((unit) => `maxima.${unit}`),
  ...FILESYSTEMS.map((capability) => `forms.${capability}`),
  ...FORM_KEYS,
];

/** Every ```json block in TEXT that `validatePolicy` (through `readPolicy`) refuses. */
function inadmissibleBlocks(text: string, label: string): string[] {
  return [...text.matchAll(/```json\n([\s\S]*?)```/g)].flatMap(([, block], index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch (error) {
      return [`${label} json block ${index + 1} is not JSON: ${(error as Error).message}`];
    }
    const loaded = readPolicy(workspace(parsed).policyPath);
    return loaded.ok ? [] : [`${label} json block ${index + 1}: ${loaded.reason}: ${loaded.detail}`];
  });
}

function policyViolations(contract: string): string[] {
  return [
    ...POLICY_KEYS.filter((key) => !backticked(contract, key)).map((key) => `policy key \`${key}\` is undocumented`),
    ...configVars().filter((name) => !backticked(contract, name)).map((name) => `env var \`${name}\` is undocumented`),
    ...inadmissibleBlocks(contract, 'contract'),
  ];
}

// ── No doctrine ids ────────────────────────────────────────────────────────

const DOCTRINE_ID = /\b(?:SL|DEC|RV|ADR|REQ|POL|IMP|ISS|SPEC)-\d{3}\b/g;

/** Every file under PATH (a file or a directory), recursively. */
function filesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
}

/** The shipped text: what a reader of the package sees. */
const SHIPPED_TEXT = ['docs', 'examples', 'README.md'];

function doctrineIdViolations(files: readonly string[]): string[] {
  return files.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(DOCTRINE_ID)].map((m) => `${file}: cites ${m[0]}`));
}

// ── The tests ──────────────────────────────────────────────────────────────

test('refusal tokens: the sources\' refusal unions equal the pi-agent-result-1.md Refusals table, both ways', () => {
  const reasons = codeRefusals();
  assert.ok(reasons.includes('session-busy') && reasons.includes('view-overlaps-protected'), 'the union scan finds the declared reasons');
  assert.deepEqual(refusalViolations(read(RESULT_CONTRACT), reasons), []);
});

test('result keys and types: every fixture matches the Fields table at every level, and each nullable field is null somewhere', () => {
  const results = fixtures();
  assert.deepEqual(
    new Set(Object.values(results).map((doc) => doc.state)),
    new Set(RESULT_STATES),
    'a fixture for every state',
  );
  assert.ok(results.completed.status && (results.completed.status.alerts as unknown[]).length > 0, 'an alert element is checked');
  assert.deepEqual(keysAndTypesViolations(read(RESULT_CONTRACT), results), []);
});

test('result semantics: the contract\'s tables equal CAUSE_STATE, RESULT_STATES and TERMINATIONS, both ways', () => {
  assert.deepEqual(semanticsViolations(read(RESULT_CONTRACT)), []);
});

test('policy: every key validatePolicy accepts and every env var config.ts reads is documented; every json block is admitted', () => {
  assert.ok(configVars().includes('HOME') && configVars().includes('QUOTIENT_POLICY'), 'the env scan finds the reads');
  assert.deepEqual(policyViolations(read(POLICY_CONTRACT)), []);
  assert.deepEqual(inadmissibleBlocks(`\`\`\`json\n${read('examples/policy.json')}\`\`\``, 'examples/policy.json'), []);
});

test('no doctrine ids: nothing under docs/, examples/ or the README cites one', () => {
  const files = SHIPPED_TEXT.flatMap((path) => filesUnder(repo(path)));
  assert.ok(files.some((file) => file.endsWith('design.md')), 'the scan reaches docs/');
  assert.deepEqual(doctrineIdViolations(files), []);
});

// ── Negative controls: each check fails on a doctored contract ─────────────

/** Replace exactly one occurrence, so a doctoring that matched nothing fails
 *  loudly instead of passing vacuously. */
function doctor(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `the doctoring anchor occurs exactly once: ${from}`);
  return text.replace(from, to);
}

test('negative control: a doctored Fields row with a wrong type fails result keys and types', () => {
  const doctored = doctor(read(RESULT_CONTRACT), '| `transcript` | string |', '| `transcript` | number |');
  const violations = keysAndTypesViolations(doctored, fixtures());
  assert.ok(violations.some((line) => line.includes('`transcript` is string, and the Fields table says number')), violations.join('\n'));
});

test('negative control: a nullable field doctored non-nullable fails result keys and types', () => {
  const doctored = doctor(read(RESULT_CONTRACT), '| `result` | string | yes |', '| `result` | string | no |');
  const violations = keysAndTypesViolations(doctored, fixtures());
  assert.ok(violations.some((line) => line.includes('`result` is null, and the Fields table says non-nullable')), violations.join('\n'));
});

test('negative control: a termination row doctored to the wrong state fails result semantics', () => {
  const doctored = doctor(read(RESULT_CONTRACT), '| `eof` | `incomplete` |', '| `eof` | `failed` |');
  const violations = semanticsViolations(doctored);
  assert.deepEqual(violations, ['termination `eof`: the contract says failed, CAUSE_STATE says incomplete']);
});
