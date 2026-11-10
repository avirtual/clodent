import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRICES, PRICES_SOURCE, PROMPT_TIERS } from '../../src/cost/prices.js';

test('the table holds exactly the six priced model ids', () => {
  assert.deepEqual(Object.keys(PRICES).sort(), [
    'claude-fable-5-1',
    'claude-fable-5-2',
    'claude-haiku-5-5',
    'claude-mythos-5-2',
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

test('claude-fable-5-2 and claude-mythos-5-2 carry the v0.6.87 standard rates', () => {
  for (const model of ['claude-fable-5-2', 'claude-mythos-5-2']) {
    assert.deepEqual(
      PRICES[model],
      { input: 8.0, output: 40.0, cacheRead: 0.2, cacheWrite5m: 10.0, cacheWrite1h: 16.0 },
      model,
    );
  }
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
  assert.match(PRICES_SOURCE, /fdaf6d2/);
  assert.match(PRICES_SOURCE, /2026-09\/11/);
});
