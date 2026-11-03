import { test } from 'node:test';
import assert from 'node:assert/strict';

test('parent', async (t) => {
  await t.test('child passes', () => assert.ok(true));
  await t.test('child fails', () => assert.equal(1, 2));
});
