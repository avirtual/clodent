export const PRICES_SOURCE =
  'wirescope proxy-lab proxylab/billing.py PRICES @ee3917a (v0.6.85), from platform.claude.com pricing read 2026-09/10';

const row = (input, output, cacheRead, cacheWrite5m, cacheWrite1h) =>
  Object.freeze({ input, output, cacheRead, cacheWrite5m, cacheWrite1h });

export const PRICES = Object.freeze({
  'claude-opus-5-5': row(4.0, 20.0, 0.2, 5.0, 8.0),
  // cacheRead 0.10 is wirescope's figure; the pricing page showed a stale 0.20 — re-check the page before changing it.
  'claude-sonnet-5-5': row(2.0, 10.0, 0.1, 2.5, 4.0),
  'claude-haiku-5-5': row(0.1, 0.5, 0.01, 0.125, 0.2),
  'claude-fable-5-1': row(10.0, 50.0, 0.25, 12.5, 20.0),
});

export const PROMPT_TIERS = Object.freeze({
  'claude-haiku-5-5': Object.freeze({
    aboveTokens: 100000,
    rates: row(0.5, 2.5, 0.05, 0.625, 1.0),
  }),
});
