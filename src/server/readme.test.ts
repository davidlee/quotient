// Tests for the operator README (`pi/mcp/README.md`): the launch environment,
// the policy schema, and the refusal vocabulary it documents.
//
// Every fenced ```json block must itself be a policy this build admits, and
// every field, launch variable and refusal reason the code declares must appear
// as a backticked token. A field added to the schema without a row in the doc
// therefore fails here rather than being discovered on an operator's host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  FORM_FIELDS,
  MAXIMA_FIELDS,
  OPTIONAL_FIELDS,
  POLICY_VAR,
  REQUIRED_FIELDS,
  RUN_DIR_VAR,
  SESSION_HOME_VAR,
  STATIC_ONLY_FIELDS,
  readPolicy,
} from './policy.ts';
import { RESULT_REFUSAL_REASONS } from './result.ts';
import { readText, workspace } from './test-rig.ts';

const README = new URL('./README.md', import.meta.url).pathname;

const doc = (): string => readText(README);

/** Every fenced ```json block's contents, in document order. */
function jsonBlocks(text: string): string[] {
  return [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]);
}

const backticked = (text: string, token: string): boolean => text.includes(`\`${token}\``);

/**
 * The refusal reasons declared only as TypeScript unions (`RefusalReason`,
 * `FormRefusal`, `ProfileRefusal`, …), which are erased at runtime. Read from
 * the sources' `export type …Refusal… =` declarations, so a reason added to a
 * union fails this suite until the README names it. The rest are the runtime
 * list in result.ts.
 */
function unionRefusals(): string[] {
  const dir = new URL('.', import.meta.url).pathname;
  const reasons: string[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))) {
    for (const [, union] of readText(join(dir, name)).matchAll(/export type \w*Refusal\w* =([^;]*);/g)) {
      for (const [, reason] of union.matchAll(/'([a-z-]+)'/g)) reasons.push(reason);
    }
  }
  return reasons;
}

const REFUSALS = [...unionRefusals(), ...RESULT_REFUSAL_REASONS];

test('every ```json block in the README is a valid policy', () => {
  const blocks = jsonBlocks(doc());
  assert.ok(blocks.length >= 1, 'the README must show at least one policy block');

  for (const [index, block] of blocks.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.fail(`README json block ${index + 1} is not JSON: ${message}`);
    }
    const loaded = readPolicy(workspace(parsed).policyPath);
    if (!loaded.ok) {
      assert.fail(`README json block ${index + 1} is not a valid policy: ${loaded.reason}: ${loaded.detail}`);
    }
  }
});

test('every policy field the schema declares appears backticked', () => {
  const text = doc();
  const fields = [
    ...REQUIRED_FIELDS,
    ...OPTIONAL_FIELDS,
    ...STATIC_ONLY_FIELDS,
    ...MAXIMA_FIELDS.map((unit) => `maxima.${unit}`),
    ...FORM_FIELDS.map((capability) => `forms.${capability}`),
  ];
  for (const field of fields) {
    assert.ok(backticked(text, field), `the README must name \`${field}\``);
  }
});

test('the three launch-environment variables appear backticked', () => {
  const text = doc();
  for (const name of [POLICY_VAR, RUN_DIR_VAR, SESSION_HOME_VAR]) {
    assert.ok(backticked(text, name), `the README must name \`${name}\``);
  }
});

test('every refusal reason the server can produce appears backticked', () => {
  const text = doc();
  assert.ok(
    REFUSALS.includes('session-busy') && REFUSALS.includes('view-overlaps-protected'),
    'the union scan finds the declared reasons',
  );
  for (const reason of REFUSALS) {
    assert.ok(backticked(text, reason), `the README must name \`${reason}\``);
  }
});
