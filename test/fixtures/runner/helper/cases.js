import { it } from 'node:test';
import assert from 'node:assert/strict';

export function cases() {
  it('helper passes', () => assert.ok(true));
  it('helper fails', () => assert.equal(1, 2));
}

export async function subtests(t) {
  await t.test('helper child', () => assert.ok(true));
}
