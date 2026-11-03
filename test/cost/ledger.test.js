import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLedger } from '../../src/cost/ledger.js';

const OPUS = 'claude-opus-5-5';
const opusUsage = {
  input_tokens: 1000,
  output_tokens: 2000,
  cache_read_input_tokens: 3000,
  cache_creation_input_tokens: 4000,
};
const empty = { usd: 0, tokens: { in: 0, cacheRead: 0, cacheWrite: 0, out: 0 }, requests: 0, unpriced: [] };

test('record returns the priceUsage result', () => {
  const ledger = createLedger();
  assert.deepEqual(ledger.record(OPUS, opusUsage), {
    usd: 0.0646,
    tokens: { in: 1000, cacheRead: 3000, cacheWrite: 4000, out: 2000 },
    priced: true,
  });
});

test('endTurn returns the turn aggregate and resets the turn but not the session', () => {
  const ledger = createLedger();
  ledger.record(OPUS, opusUsage);
  ledger.record('mystery-1', { input_tokens: 5 });
  const turn = {
    usd: 0.0646,
    tokens: { in: 1005, cacheRead: 3000, cacheWrite: 4000, out: 2000 },
    requests: 2,
    unpriced: ['mystery-1'],
  };
  assert.deepEqual(ledger.endTurn(), turn);
  assert.deepEqual(ledger.endTurn(), empty);
  assert.deepEqual(ledger.session(), turn);
  ledger.record(OPUS, opusUsage);
  ledger.record('mystery-1', {});
  assert.deepEqual(ledger.session(), {
    usd: 0.1292,
    tokens: { in: 2005, cacheRead: 6000, cacheWrite: 8000, out: 4000 },
    requests: 4,
    unpriced: ['mystery-1'],
  });
});

test('aggregates are copies, not live views', () => {
  const ledger = createLedger();
  ledger.record('mystery-1', {});
  const snapshot = ledger.session();
  snapshot.unpriced.push('x');
  snapshot.tokens.in = 99;
  assert.deepEqual(ledger.session().unpriced, ['mystery-1']);
  assert.equal(ledger.session().tokens.in, 0);
});

test('10000 requests of $0.00001234 sum to exactly $0.1234', () => {
  const ledger = createLedger();
  for (let i = 0; i < 10000; i++) {
    assert.equal(ledger.record('claude-haiku-5-5', { cache_read_input_tokens: 1234 }).usd, 0.00001234);
  }
  assert.equal(ledger.session().usd, 0.1234);
  assert.equal(ledger.endTurn().usd, 0.1234);
});

test('check without a budget is always ok', () => {
  const ledger = createLedger();
  assert.deepEqual(ledger.check(), { ok: true });
  ledger.record(OPUS, { output_tokens: 10000000 });
  ledger.record('mystery-1', {});
  assert.deepEqual(ledger.check(), { ok: true });
});

test('check before the first request estimates zero', () => {
  assert.deepEqual(createLedger({ budgetUsd: 0.01 }).check(), { ok: true });
  assert.deepEqual(createLedger({ budgetUsd: 0 }).check(), { ok: true });
});

test('check under budget is ok', () => {
  const ledger = createLedger({ budgetUsd: 1 });
  ledger.record(OPUS, opusUsage);
  assert.deepEqual(ledger.check(), { ok: true });
});

test('check projects spent plus the previous request against the budget', () => {
  const ledger = createLedger({ budgetUsd: 0.1 });
  ledger.record(OPUS, opusUsage);
  assert.deepEqual(ledger.check(), { ok: false, spentUsd: 0.0646, nextEstimateUsd: 0.0646, budgetUsd: 0.1 });
});

test('a projection landing exactly on the budget is ok', () => {
  const ledger = createLedger({ budgetUsd: 0.1292 });
  ledger.record(OPUS, opusUsage);
  assert.deepEqual(ledger.check(), { ok: true });
});

test('the estimate is the previous request, not the largest', () => {
  const ledger = createLedger({ budgetUsd: 0.075 });
  ledger.record(OPUS, opusUsage);
  ledger.record(OPUS, { input_tokens: 1000 });
  assert.deepEqual(ledger.check(), { ok: true });
  ledger.record(OPUS, { input_tokens: 1000 });
  assert.deepEqual(ledger.check(), { ok: false, spentUsd: 0.0726, nextEstimateUsd: 0.004, budgetUsd: 0.075 });
});

test('an unpriced request with a budget set stops the run', () => {
  const ledger = createLedger({ budgetUsd: 100 });
  ledger.record(OPUS, opusUsage);
  ledger.record('claude-opus-5-5-preview', { input_tokens: 10 });
  ledger.record('mystery-2', {});
  assert.deepEqual(ledger.check(), {
    ok: false,
    reason: 'unpriced',
    model: 'claude-opus-5-5-preview',
    spentUsd: 0.0646,
    nextEstimateUsd: 0,
    budgetUsd: 100,
  });
  ledger.endTurn();
  assert.equal(ledger.check().reason, 'unpriced');
});

test('a budget that is not a finite non-negative number throws', () => {
  for (const budgetUsd of [NaN, -1, Infinity, '5']) {
    assert.throws(() => createLedger({ budgetUsd }), RangeError, String(budgetUsd));
  }
  assert.deepEqual(createLedger({ budgetUsd: null }).check(), { ok: true });
});
