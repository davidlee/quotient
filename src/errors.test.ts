import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageOf } from './errors.ts';

test('messageOf is an Error\'s message, any other value as a string, and never throws', () => {
  assert.equal(messageOf(new Error('boom')), 'boom');
  assert.equal(messageOf('plain'), 'plain');
  assert.equal(messageOf(7), '7');
  assert.equal(messageOf(Object.create(null)), 'a value that cannot be printed');
});
