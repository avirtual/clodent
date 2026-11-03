import { test } from 'node:test';
import assert from 'node:assert/strict';

test('passing parent', async (t) => {
  await t.test('first child', () => assert.ok(true));
  await t.test('second child', () => assert.ok(true));
});
