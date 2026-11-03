import { NANOS_PER_USD } from './price.js';

const NANOS_PER_DISPLAY_UNIT = NANOS_PER_USD / 10000;

function formatUsd(usd) {
  const nanos = Math.round(usd * NANOS_PER_USD);
  const units = Math.floor((nanos + NANOS_PER_DISPLAY_UNIT / 2) / NANOS_PER_DISPLAY_UNIT);
  return `$${Math.floor(units / 10000)}.${String(units % 10000).padStart(4, '0')}`;
}

const tokenList = (tokens) =>
  `in ${tokens.in}, cache-read ${tokens.cacheRead}, cache-write ${tokens.cacheWrite}, out ${tokens.out}`;

export function formatCost(agg) {
  return `[clay:cost] ${formatUsd(agg.usd)} (${tokenList(agg.tokens)})`;
}

export function formatTotal(agg) {
  return `[clay:cost] session total ${formatUsd(agg.usd)} (${tokenList(agg.tokens)}, requests ${agg.requests})`;
}

export function formatBudgetStop(result) {
  if (result.reason === 'unpriced') {
    return `[clay:budget] stopped: model ${result.model} has no price; --budget needs a priced model`;
  }
  return `[clay:budget] stopped: spent ${formatUsd(result.spentUsd)}, next request est. ${formatUsd(result.nextEstimateUsd)}, budget ${formatUsd(result.budgetUsd)}`;
}

export function formatUnpriced(model) {
  return `[clay:cost] warning: no price for model ${model}; cost not counted`;
}
