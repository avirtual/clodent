import { PRICES, PROMPT_TIERS } from './prices.js';

export const NANOS_PER_USD = 1e9;

const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const nanosPerToken = (usdPerMillion) => Math.round(usdPerMillion * 1000);

export function usageTokens(usage) {
  const u = usage ?? {};
  const breakdown = u.cache_creation ?? {};
  const write1h = count(breakdown.ephemeral_1h_input_tokens);
  const cacheWrite = Math.max(
    count(u.cache_creation_input_tokens),
    count(breakdown.ephemeral_5m_input_tokens) + write1h,
  );
  return {
    in: count(u.input_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    cacheWrite,
    out: count(u.output_tokens),
    write5m: cacheWrite - write1h,
    write1h,
  };
}

export function priceNanos(model, usage, deps = {}) {
  const prices = deps.prices ?? PRICES;
  const tiers = deps.tiers ?? PROMPT_TIERS;
  const { write5m, write1h, ...tokens } = usageTokens(usage);
  if (typeof model !== 'string' || !Object.hasOwn(prices, model)) {
    return { nanos: 0, tokens, priced: false };
  }
  const promptTokens = tokens.in + tokens.cacheRead + tokens.cacheWrite;
  const tier = Object.hasOwn(tiers, model) ? tiers[model] : undefined;
  const rates = tier && promptTokens > tier.aboveTokens ? tier.rates : prices[model];
  const nanos =
    tokens.in * nanosPerToken(rates.input) +
    tokens.cacheRead * nanosPerToken(rates.cacheRead) +
    write5m * nanosPerToken(rates.cacheWrite5m) +
    write1h * nanosPerToken(rates.cacheWrite1h) +
    tokens.out * nanosPerToken(rates.output);
  return { nanos, tokens, priced: true };
}

export function priceUsage(model, usage, deps) {
  const { nanos, tokens, priced } = priceNanos(model, usage, deps);
  return { usd: nanos / NANOS_PER_USD, tokens, priced };
}
