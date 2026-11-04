import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBudgetStop, formatCost, formatTotal, formatUnpriced } from '../../src/cost/format.js';
import { createLedger } from '../../src/cost/ledger.js';

const tokens = { in: 1234567, cacheRead: 0, cacheWrite: 42, out: 7 };
const agg = (usd) => ({ usd, tokens, requests: 3, unpriced: [] });
const usdOf = (usd) => formatCost(agg(usd)).match(/\$(\S+)/)[1];

test('formatCost prints the per-turn line', () => {
  assert.equal(formatCost(agg(0.0646)), '[clodent:cost] $0.0646 (in 1234567, cache-read 0, cache-write 42, out 7)');
});

test('formatTotal prints the session total line', () => {
  assert.equal(
    formatTotal(agg(12.5)),
    '[clodent:cost] session total $12.5000 (in 1234567, cache-read 0, cache-write 42, out 7, requests 3)',
  );
});

test('amounts print exactly four decimals, rounded half-up', () => {
  assert.equal(usdOf(0), '0.0000');
  assert.equal(usdOf(0.00004999), '0.0000');
  assert.equal(usdOf(0.00005), '0.0001');
  assert.equal(usdOf(0.00015), '0.0002');
  assert.equal(usdOf(0.00095), '0.0010');
  assert.equal(usdOf(1.23455), '1.2346');
  assert.equal(usdOf(0.99995), '1.0000');
  assert.equal(usdOf(1234.56789), '1234.5679');
});

test('a ledger turn worth exactly $0.00015 prints $0.0002', () => {
  const ledger = createLedger();
  ledger.record('claude-haiku-5-5', { cache_read_input_tokens: 15000 });
  assert.equal(formatCost(ledger.endTurn()), '[clodent:cost] $0.0002 (in 0, cache-read 15000, cache-write 0, out 0)');
});

test('formatBudgetStop prints the overshoot line', () => {
  assert.equal(
    formatBudgetStop({ ok: false, spentUsd: 0.0646, nextEstimateUsd: 0.00015, budgetUsd: 0.1 }),
    '[clodent:budget] stopped: spent $0.0646, next request est. $0.0002, budget $0.1000',
  );
});

test('formatBudgetStop prints the unpriced line', () => {
  assert.equal(
    formatBudgetStop({ ok: false, reason: 'unpriced', model: 'mystery-1', spentUsd: 0, nextEstimateUsd: 0, budgetUsd: 5 }),
    '[clodent:budget] stopped: model mystery-1 has no price; --budget needs a priced model',
  );
});

test('formatUnpriced prints the warning line', () => {
  assert.equal(formatUnpriced('mystery-1'), '[clodent:cost] warning: no price for model mystery-1; cost not counted');
});

test('every formatter returns one line without a trailing newline', () => {
  const lines = [
    formatCost(agg(1)),
    formatTotal(agg(1)),
    formatBudgetStop({ ok: false, spentUsd: 1, nextEstimateUsd: 1, budgetUsd: 1 }),
    formatBudgetStop({ ok: false, reason: 'unpriced', model: 'm' }),
    formatUnpriced('m'),
  ];
  for (const line of lines) assert.doesNotMatch(line, /\n/);
});
