import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('suite with a broken after hook', () => {
  it('passes', () => assert.ok(true));
  after(() => {
    throw new Error('after hook breaks');
  });
});
