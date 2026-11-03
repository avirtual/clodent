import { test } from 'node:test';
import assert from 'node:assert/strict';

test('passes', () => assert.ok(true));
test('fails on purpose', () => assert.equal(1, 2));
test('skipped', { skip: true }, () => assert.fail('never runs'));
