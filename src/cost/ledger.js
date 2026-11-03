import { NANOS_PER_USD, priceNanos } from './price.js';

function emptyTotals() {
  return { nanos: 0, in: 0, cacheRead: 0, cacheWrite: 0, out: 0, requests: 0, unpriced: [] };
}

function add(totals, model, result) {
  totals.nanos += result.nanos;
  totals.in += result.tokens.in;
  totals.cacheRead += result.tokens.cacheRead;
  totals.cacheWrite += result.tokens.cacheWrite;
  totals.out += result.tokens.out;
  totals.requests += 1;
  if (!result.priced && !totals.unpriced.includes(model)) totals.unpriced.push(model);
}

function aggregate(totals) {
  return {
    usd: totals.nanos / NANOS_PER_USD,
    tokens: { in: totals.in, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite, out: totals.out },
    requests: totals.requests,
    unpriced: [...totals.unpriced],
  };
}

export function createLedger({ budgetUsd } = {}, deps) {
  const hasBudget = budgetUsd !== undefined && budgetUsd !== null;
  if (hasBudget && !(typeof budgetUsd === 'number' && Number.isFinite(budgetUsd) && budgetUsd >= 0)) {
    throw new RangeError(`budget must be a finite number of USD >= 0, got ${budgetUsd}`);
  }
  const budgetNanos = hasBudget ? Math.round(budgetUsd * NANOS_PER_USD) : 0;
  let turn = emptyTotals();
  const session = emptyTotals();
  let lastNanos = 0;

  return {
    record(model, usage) {
      const result = priceNanos(model, usage, deps);
      add(turn, model, result);
      add(session, model, result);
      lastNanos = result.nanos;
      return { usd: result.nanos / NANOS_PER_USD, tokens: result.tokens, priced: result.priced };
    },
    endTurn() {
      const done = aggregate(turn);
      turn = emptyTotals();
      return done;
    },
    session() {
      return aggregate(session);
    },
    check() {
      if (!hasBudget) return { ok: true };
      const spentUsd = session.nanos / NANOS_PER_USD;
      const nextEstimateUsd = lastNanos / NANOS_PER_USD;
      if (session.unpriced.length > 0) {
        return { ok: false, reason: 'unpriced', model: session.unpriced[0], spentUsd, nextEstimateUsd, budgetUsd };
      }
      if (session.nanos + lastNanos > budgetNanos) {
        return { ok: false, spentUsd, nextEstimateUsd, budgetUsd };
      }
      return { ok: true };
    },
  };
}
