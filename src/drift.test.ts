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
//   nix examples       every ```nix block in docs/nix-forms.md is a file the
//                      test flake builds and checks
//
// The fixture results are built offline by the real reducer and the server's own
// builders (`resultFor`, `failedResult`, `refusedResult`): the functions every
// answer the server writes goes through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduce } from './reduce/reduce.ts';
import { readApprovals } from './server/approvals.ts';
import {
  CAUSE_STATE,
  failedResult,
  refusedResult,
  RESULT_REFUSAL_REASONS,
  RESULT_STATES,
  TERMINATIONS, type AgentResult 
} from './server/result.ts';
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

/** The message of a thrown value, without a type assertion. */
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const RESULT_CONTRACT = 'docs/contract/pi-agent-result-2.md';
const POLICY_CONTRACT = 'docs/contract/quotient-policy-2.md';
const HISTORICAL_RESULT_CONTRACT = 'docs/contract/pi-agent-result-1.md';
const HISTORICAL_POLICY_CONTRACT = 'docs/contract/quotient-policy-1.md';
const APPROVALS_CONTRACT = 'docs/contract/quotient-approvals-1.md';

// ── Reading the documents ──────────────────────────────────────────────────

/** The rows of the first markdown table under `## <heading>`, header and rule
 *  dropped, each cell trimmed and stripped of one pair of backticks. */
function table(text: string, heading: string): string[][] {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) {return [];}
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
 * `ProjectFormRefusal`, `SessionRefusal`, …), erased at runtime, so read from the
 * sources' `export type …Refusal… =` declarations; plus the runtime list in
 * result.ts. A reason added to a union fails until the contract names it.
 */
function codeRefusals(): string[] {
  const dir = repo('src/server');
  const reasons: string[] = [...RESULT_REFUSAL_REASONS];
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))) {
    for (const [, union] of readFileSync(join(dir, name), 'utf8').matchAll(/export type \w*Refusal\w* =([^;]*);/g)) {
      for (const [, reason] of union.matchAll(/'([a-z-]+)'/g)) {reasons.push(reason);}
    }
  }
  return reasons;
}

function refusalViolations(contract: string, reasons: readonly string[]): string[] {
  return bothWays('refusal', reasons, table(contract, 'Refusals').map((row) => row[0]));
}

// ── Keys and types ─────────────────────────────────────────────────────────

type Field = { type: string; nullable: boolean };

const JSON_TYPES = ['string', 'number', 'boolean', 'object', 'array'];

/** Rows of the Fields table that cannot be read as (path, type, nullable,
 *  meaning): a missing cell, a `|` inside a cell, or a value outside the
 *  vocabulary would otherwise be misread silently. */
function malformedFieldRows(contract: string): string[] {
  return table(contract, 'Fields').flatMap((row) => {
    if (row.length !== 4) {return [`Fields row \`${row[0]}\` has ${String(row.length)} cells, not 4`];}
    const problems: string[] = [];
    if (!JSON_TYPES.includes(row[1])) {problems.push(`Fields row \`${row[0]}\`: type ${row[1]} is not a JSON type`);}
    if (row[2] !== 'yes' && row[2] !== 'no') {problems.push(`Fields row \`${row[0]}\`: nullable is ${row[2]}, not yes or no`);}
    return problems;
  });
}

/** The Fields table: path → JSON type and nullability. An array's elements are
 *  `<path>[]`, an object's members `<path>.<key>`. */
function fields(contract: string): Map<string, Field> {
  return new Map(table(contract, 'Fields').map((row) => [row[0], { type: row[1], nullable: row[2] === 'yes' }]));
}

const jsonType = (value: unknown): string => {
  if (Array.isArray(value)) {return 'array';}
  return value === null ? 'null' : typeof value;
};

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

  /** Check one documented value; false where it cannot have documented children
   *  (undocumented, null, or the wrong JSON type). */
  function checkField(value: unknown, path: string): boolean {
    const field = documented.get(path);
    if (field === undefined) {
      violations.push(`${label}: \`${path}\` is not in the Fields table`);
      return false;
    }
    if (value === null) {
      nulls.add(path);
      if (!field.nullable) {violations.push(`${label}: \`${path}\` is null, and the Fields table says non-nullable`);}
      return false;
    }
    if (jsonType(value) !== field.type) {
      violations.push(`${label}: \`${path}\` is ${jsonType(value)}, and the Fields table says ${field.type}`);
      return false;
    }
    return true;
  }

  /** An object's documented children: key-set parity both ways, then each member. */
  function walkMembers(value: object, path: string): void {
    violations.push(...bothWays(`${label}: keys of \`${path === '' ? '(document)' : path}\``, Object.keys(value), childrenOf(documented, path)));
    for (const [key, member] of Object.entries(value)) {walk(member, path === '' ? key : `${path}.${key}`);}
  }

  function walk(value: unknown, path: string): void {
    if (path !== '' && !checkField(value, path)) {return;}
    if (Array.isArray(value)) {
      for (const element of value) {walk(element, `${path}[]`);}
    } else if (typeof value === 'object' && value !== null) {
      walkMembers(value, path);
    }
  }

  walk(doc, '');
  return violations;
}

/** The whole check over a fixture set: each fixture's shape, plus every nullable
 *  field null in at least one fixture (else its null is never checked). */
function keysAndTypesViolations(contract: string, fixtures: Record<string, AgentResult>): string[] {
  const documented = fields(contract);
  if (documented.size === 0) {return ['the contract has no Fields table'];}
  const nulls = new Set<string>();
  const violations = [...malformedFieldRows(contract)];
  violations.push(...Object.entries(fixtures).flatMap(([label, doc]) => shapeViolations(doc, documented, label, nulls)));
  for (const [path, field] of documented) {
    if (field.nullable && !nulls.has(path)) {violations.push(`nullable \`${path}\` is null in no fixture`);}
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
    accounting_unknown: buildResult({ lines: [messageEnd('stop', 'the answer', { cost: {} }), SETTLED_RECORD] }).doc,
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
      return [`${label} json block ${String(index + 1)} is not JSON: ${errorMessage(error)}`];
    }
    const loaded = readPolicy(workspace(parsed).policyPath);
    return loaded.ok ? [] : [`${label} json block ${String(index + 1)}: ${loaded.reason}: ${loaded.detail}`];
  });
}

function policyViolations(contract: string): string[] {
  return [
    ...POLICY_KEYS.filter((key) => !backticked(contract, key)).map((key) => `policy key \`${key}\` is undocumented`),
    ...configVars().filter((name) => !backticked(contract, name)).map((name) => `env var \`${name}\` is undocumented`),
    ...inadmissibleBlocks(contract, 'contract'),
  ];
}

/** Every ```json block in TEXT, verbatim. */
function jsonBlocks(text: string): string[] {
  return [...text.matchAll(/```json\n([\s\S]*?)```/g)].map(([, block]) => block);
}

/** Every ```json block in TEXT that `readApprovals` refuses. The reader takes a
 *  path, so each block is written to a temp file and read by the real reader. */
function malformedApprovalsBlocks(text: string, label: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'quotient-approvals-contract-'));
  return jsonBlocks(text).flatMap((block, index) => {
    const path = join(dir, `approvals-${String(index + 1)}.json`);
    writeFileSync(path, block);
    const read = readApprovals(path);
    return read.ok ? [] : [`${label} json block ${String(index + 1)}: ${read.detail}`];
  });
}

/** Validate policy-shaped JSON examples embedded in general guidance text. */
function embeddedPolicyViolations(text: string, label: string): { found: number; violations: string[] } {
  const policies: unknown[] = [];
  for (const [, block] of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch (error) {
      return { found: policies.length, violations: [`${label} has invalid JSON: ${errorMessage(error)}`] };
    }
    if (typeof parsed === 'object' && parsed !== null && 'schema' in parsed && String(parsed.schema).startsWith('quotient-policy/')) {
      policies.push(parsed);
    }
  }
  return {
    found: policies.length,
    violations: policies.flatMap((policy, index) =>
      inadmissibleBlocks(`\`\`\`json\n${JSON.stringify(policy)}\n\`\`\``, `${label} policy ${String(index + 1)}`),
    ),
  };
}

// ── No doctrine ids ────────────────────────────────────────────────────────

const NIX_FORMS = 'docs/nix-forms.md';
const NIX_EXAMPLES = 'nix/checks/examples';

/** Every ```nix block in TEXT that is not tagged `<!-- example: NAME -->` on the
 *  line before it, or whose text — dedented by its fence's indent — is not the
 *  file NAME.nix that EXAMPLE returns. The test flake builds and checks each of
 *  those files, so a docs example the reader copies is one the gate ran. */
function exampleViolations(text: string, example: (name: string) => string | undefined): string[] {
  const lines = text.split('\n');
  const violations: string[] = [];
  lines.forEach((line, index) => {
    const fence = /^( *)```nix$/.exec(line);
    if (fence === null) {return;}
    const indent = fence[1].length;
    const tag = /^ *<!-- example: ([a-z-]+) -->$/.exec(lines[index - 1] ?? '');
    if (tag === null) {
      violations.push(`line ${String(index + 1)}: a nix block with no example tag`);
      return;
    }
    const end = lines.findIndex((candidate, at) => at > index && candidate === `${' '.repeat(indent)}\`\`\``);
    const block = lines.slice(index + 1, end).map((body) => body.slice(indent)).join('\n') + '\n';
    const file = example(tag[1]);
    if (file === undefined) {
      violations.push(`example ${tag[1]}: no ${NIX_EXAMPLES}/${tag[1]}.nix`);
    } else if (file !== block) {
      violations.push(`example ${tag[1]}: the docs block differs from ${NIX_EXAMPLES}/${tag[1]}.nix`);
    }
  });
  return violations;
}

const exampleFile = (name: string): string | undefined => {
  const path = `${NIX_EXAMPLES}/${name}.nix`;
  return existsSync(repo(path)) ? read(path) : undefined;
};

const DOCTRINE_ID = /\b(?:SL|DEC|RV|ADR|REQ|POL|IMP|ISS|SPEC|RFC|REV|CHR|IDE|RSK)-\d{3}\b/g;

/** Every file under PATH (a file or a directory), recursively. */
function filesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) {return [path];}
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
}

/** The shipped text: what a reader of the package sees, plus the flake's own
 *  text, which ships through the flake rather than `npm pack`. */
const SHIPPED_TEXT = ['docs', 'examples', 'help', 'README.md', 'flake.nix', 'nix'];

function doctrineIdViolations(files: readonly string[]): string[] {
  return files.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(DOCTRINE_ID)].map((m) => `${file}: cites ${m[0]}`));
}

// ── The tests ──────────────────────────────────────────────────────────────

test('refusal tokens: the sources\' refusal unions equal the active pi-agent-result/2 Refusals table, both ways', () => {
  const reasons = codeRefusals();
  assert.ok(reasons.includes('session-busy') && reasons.includes('view-overlaps-protected'), 'the union scan finds the declared reasons');
  assert.deepEqual(refusalViolations(read(RESULT_CONTRACT), reasons), []);
});

test('result keys and types: every fixture matches the Fields table at every level, and each nullable field is null somewhere', () => {
  const results = fixtures();
  for (const [label, doc] of Object.entries(results)) {assert.equal(doc.state, label.split(' ')[0], `the ${label} fixture`);}
  assert.deepEqual(new Set(Object.values(results).map((doc) => doc.state)), new Set(RESULT_STATES), 'a fixture for every state');
  const { status } = results.completed;
  assert.ok(status !== null && Array.isArray(status.alerts) && status.alerts.length > 0, 'an alert element is checked');
  assert.deepEqual(keysAndTypesViolations(read(RESULT_CONTRACT), results), []);
});

test('result semantics: the contract\'s tables equal CAUSE_STATE, RESULT_STATES and TERMINATIONS, both ways', () => {
  assert.deepEqual(semanticsViolations(read(RESULT_CONTRACT)), []);
});

test('policy: every key validatePolicy accepts and every env var config.ts reads is documented; every json block is admitted', () => {
  assert.ok(configVars().includes('HOME') && configVars().includes('QUOTIENT_POLICY'), 'the env scan finds the reads');
  assert.deepEqual(policyViolations(read(POLICY_CONTRACT)), []);
  assert.deepEqual(inadmissibleBlocks(`\`\`\`json\n${read('examples/policy.json')}\`\`\``, 'examples/policy.json'), []);
  const readmePolicies = embeddedPolicyViolations(read('README.md'), 'README.md');
  assert.ok(readmePolicies.found > 0, 'README includes a detectable policy example');
  assert.deepEqual(readmePolicies.violations, []);
});

test('approvals contract: every json block is a store readApprovals admits, and a doctored one is reported', () => {
  const contract = read(APPROVALS_CONTRACT);
  assert.ok(jsonBlocks(contract).length > 0, 'the contract carries a store example');
  assert.deepEqual(malformedApprovalsBlocks(contract, 'contract'), []);
});

test('active contracts migrate explicitly while historical /1 references remain available', () => {  const result = read(RESULT_CONTRACT);
  const policy = read(POLICY_CONTRACT);
  assert.ok(result.includes('`pi-agent-result/2`'));
  assert.ok(result.includes('`pi-run-status/3`'));
  assert.ok(policy.includes('`quotient-policy/2`'));
  assert.ok(policy.includes('`maxima.context_tokens`'));
  assert.ok(policy.includes('No automatic conversion'));
  assert.ok(read(HISTORICAL_RESULT_CONTRACT).includes('`pi-agent-result/1`'));
  assert.ok(read(HISTORICAL_POLICY_CONTRACT).includes('`quotient-policy/1`'));
});

test('result contract defines the two unmeasured populations and their non-additivity', () => {
  const result = read(RESULT_CONTRACT).replace(/\s+/g, ' ');
  for (const phrase of [
    'legacy accounting-gap count',
    'every counted request that lacks a valid context footprint',
    'not a partition',
    'not context completeness',
    'not establish that behavior',
  ]) {
    assert.ok(result.includes(phrase), `active result contract explains ${phrase}`);
  }
});

test('no doctrine ids: nothing under docs/, examples/, help/, the README, flake.nix or nix/ cites one', () => {
  // A shipped path that does not exist yet (nix/, until the builder lands) has
  // no text to scan, so it is skipped rather than failing on ENOENT.
  const files = SHIPPED_TEXT.filter((path) => existsSync(repo(path))).flatMap((path) => filesUnder(repo(path)));
  assert.ok(files.some((file) => file.endsWith('design.md')), 'the scan reaches docs/');
  assert.ok(files.some((file) => file.endsWith('help/agent.md')), 'the scan reaches help/');
  assert.ok(files.some((file) => file.endsWith('flake.nix')), 'the scan reaches flake.nix');
  assert.ok(files.some((file) => file.endsWith('nix/form-family.nix')), 'the scan reaches nix/');
  assert.deepEqual(doctrineIdViolations(files), []);
});

test('nix examples: every nix block in docs/nix-forms.md is tagged and equals its file under nix/checks/examples', () => {
  const doc = read(NIX_FORMS);
  assert.ok((doc.match(/^ *```nix$/gm) ?? []).length >= 3, 'the scan finds the doc\'s nix blocks');
  assert.deepEqual(exampleViolations(doc, exampleFile), []);
});

// ── Negative controls: each check fails on a doctored contract ─────────────

test('negative control: a docs nix example doctored away from its file fails the nix examples check', () => {
  const doctored = doctor(read(NIX_FORMS), 'inherit pkgs jail-nix;', 'inherit pkgs jail-nix; prefix = "doctored";');
  const violations = exampleViolations(doctored, exampleFile);
  assert.ok(violations.some((line) => line.includes('the docs block differs')), violations.join('\n'));
});

test('negative control: an approvals block doctored with an unknown key fails the approvals contract check', () => {
  const doctored = doctor(
    read(APPROVALS_CONTRACT),
    '"capability": "write"',
    '"capability": "write",\n      "comment": "mine"',
  );
  const violations = malformedApprovalsBlocks(doctored, 'contract');
  assert.ok(violations.some((line) => line.includes('unknown key "comment"')), violations.join('\n'));
});

test('negative control: a Fields row that lost its nullable cell fails result keys and types', () => {
  const doctored = doctor(read(RESULT_CONTRACT), '| `status.model` | string | yes |', '| `status.model` | string |');
  const violations = keysAndTypesViolations(doctored, fixtures());
  assert.ok(violations.includes('Fields row `status.model` has 3 cells, not 4'), violations.join('\n'));
});

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
