import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRICES, PRICES_SOURCE, PROMPT_TIERS } from '../../src/cost/prices.js';

test('the table holds exactly the four priced model ids', () => {
  assert.deepEqual(Object.keys(PRICES).sort(), [
    'claude-fable-5-1',
    'claude-haiku-5-5',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
  ]);
});

test('the table and its rows are frozen', () => {
  assert.ok(Object.isFrozen(PRICES));
  for (const row of Object.values(PRICES)) assert.ok(Object.isFrozen(row));
  assert.ok(Object.isFrozen(PROMPT_TIERS));
  assert.ok(Object.isFrozen(PROMPT_TIERS['claude-haiku-5-5'].rates));
});

test('the haiku tier starts above 100000 prompt tokens', () => {
  assert.deepEqual(PROMPT_TIERS, {
    'claude-haiku-5-5': {
      aboveTokens: 100000,
      rates: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1.0 },
    },
  });
});

test('every rate is a whole number of nano-dollars per token', () => {
  const rows = [...Object.values(PRICES), ...Object.values(PROMPT_TIERS).map((t) => t.rates)];
  for (const row of rows) {
    for (const rate of Object.values(row)) assert.ok(Number.isInteger(rate * 1000), `rate ${rate}`);
  }
});

test('the source names the wirescope table and the read date', () => {
  assert.match(PRICES_SOURCE, /billing\.py/);
  assert.match(PRICES_SOURCE, /ee3917a/);
  assert.match(PRICES_SOURCE, /2026-09\/10/);
});
