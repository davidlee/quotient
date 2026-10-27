import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, isMember, isRecord } from './json.ts';

test('isRecord holds for objects only, never null, arrays or primitives', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  for (const value of [null, undefined, [], [1], 0, '', 'x', true]) {
    assert.equal(isRecord(value), false, JSON.stringify(value));
  }
});

test('at walks object keys and array indices to the value at the path', () => {
  const doc: unknown = JSON.parse('{"a":{"b":[10,{"c":"deep"}]},"n":0,"z":null}');
  assert.equal(at(doc, 'a', 'b', 0), 10);
  assert.equal(at(doc, 'a', 'b', 1, 'c'), 'deep');
  assert.equal(at(doc, 'n'), 0, 'a falsy value is a value');
  assert.equal(at(doc, 'z'), null, 'an explicit null is returned, not undefined');
  assert.equal(at(doc), doc, 'the empty path is the value itself');
});

test('at answers undefined for a path through a missing key, a primitive, null or the wrong container', () => {
  const doc: unknown = { a: { b: [1] }, s: 'text', z: null };
  assert.equal(at(doc, 'missing'), undefined);
  assert.equal(at(doc, 'missing', 'deeper'), undefined);
  assert.equal(at(doc, 's', 'length'), undefined, 'a string is not a container');
  assert.equal(at(doc, 'z', 'x'), undefined);
  assert.equal(at(doc, 'a', 0), undefined, 'an index into an object');
  assert.equal(at(doc, 'a', 'b', 'length'), undefined, 'a key into an array');
  assert.equal(at(doc, 'a', 'b', 5), undefined);
  assert.equal(at(null, 'a'), undefined);
});

test('at reads only own properties', () => {
  assert.equal(at({}, 'toString'), undefined);
  assert.equal(at({}, '__proto__'), undefined);
});

test('isMember holds for exactly the declared tokens', () => {
  const tokens: readonly ('read' | 'write')[] = ['read', 'write'];
  assert.equal(isMember(tokens, 'read'), true);
  assert.equal(isMember(tokens, 'write'), true);
  for (const value of ['', 'READ', 'admin', null, undefined, 0, ['read'], { read: true }]) {
    assert.equal(isMember(tokens, value), false, JSON.stringify(value));
  }
});
