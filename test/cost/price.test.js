import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceUsage } from '../../src/cost/price.js';

const mixed = {
  input_tokens: 1000,
  output_tokens: 2000,
  cache_read_input_tokens: 3000,
  cache_creation_input_tokens: 4000,
};
const mixedTokens = { in: 1000, cacheRead: 3000, cacheWrite: 4000, out: 2000 };

for (const [model, usd] of [
  ['claude-opus-5-5', 0.0646],
  ['claude-sonnet-5-5', 0.0323],
  ['claude-haiku-5-5', 0.00163],
  ['claude-fable-5-1', 0.16075],
  ['claude-fable-5-2', 0.1286],
  ['claude-mythos-5-2', 0.1286],
]) {
  test(`${model} prices a mixed usage at its row`, () => {
    assert.deepEqual(priceUsage(model, mixed), { usd, tokens: mixedTokens, priced: true });
  });
}

test('the cache_creation breakdown prices 5m and 1h writes at their own rates', () => {
  const usage = {
    cache_creation_input_tokens: 3000,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
  };
  assert.deepEqual(priceUsage('claude-opus-5-5', usage), {
    usd: 0.021,
    tokens: { in: 0, cacheRead: 0, cacheWrite: 3000, out: 0 },
    priced: true,
  });
});

test('without a breakdown every cache write prices at the 5m rate', () => {
  assert.deepEqual(priceUsage('claude-opus-5-5', { cache_creation_input_tokens: 3000 }), {
    usd: 0.015,
    tokens: { in: 0, cacheRead: 0, cacheWrite: 3000, out: 0 },
    priced: true,
  });
});

test('missing and null usage fields count as zero', () => {
  const zero = { usd: 0, tokens: { in: 0, cacheRead: 0, cacheWrite: 0, out: 0 }, priced: true };
  assert.deepEqual(priceUsage('claude-opus-5-5', {}), zero);
  assert.deepEqual(priceUsage('claude-opus-5-5', undefined), zero);
  assert.deepEqual(
    priceUsage('claude-opus-5-5', {
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      cache_creation: null,
    }),
    zero,
  );
});

test('haiku at exactly 100000 prompt tokens prices at the base rates', () => {
  const usage = {
    input_tokens: 99000,
    cache_read_input_tokens: 999,
    cache_creation_input_tokens: 1,
    output_tokens: 1000,
  };
  assert.equal(priceUsage('claude-haiku-5-5', usage).usd, 0.010410115);
});

test('haiku at 100001 prompt tokens prices the whole request at the tier rates', () => {
  const usage = {
    input_tokens: 99000,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 1,
    output_tokens: 1000,
  };
  assert.equal(priceUsage('claude-haiku-5-5', usage).usd, 0.052050625);
});

test('an unknown model is unpriced and does not throw', () => {
  assert.deepEqual(priceUsage('gpt-9', mixed), { usd: 0, tokens: mixedTokens, priced: false });
  assert.equal(priceUsage(undefined, mixed).priced, false);
});

test('model ids match exactly, never by prefix or prototype key', () => {
  for (const model of ['claude-opus-5-5-preview', 'claude-opus-5', 'CLAUDE-OPUS-5-5', 'toString', '__proto__']) {
    assert.equal(priceUsage(model, mixed).priced, false, model);
  }
});

test('a dated id is unpriced even when a priced id is its prefix', () => {
  assert.equal(priceUsage('claude-fable-5-20260601', mixed).priced, false);
});

test('deps can supply another price table', () => {
  const prices = { 'm-1': { input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } };
  assert.equal(priceUsage('m-1', { input_tokens: 1000000 }, { prices, tiers: {} }).usd, 1);
  assert.equal(priceUsage('claude-opus-5-5', mixed, { prices, tiers: {} }).priced, false);
});
