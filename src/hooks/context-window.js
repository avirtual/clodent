// The API serves a 1M window to every 5.x model with no beta header (measured 2026-11-10), but this window drives Clodex's compact nudge, so a seat gets 1M only when its host asked for it with a [1m] model suffix.
export const CONTEXT_WINDOW = Object.freeze({ default: 200000, large: 1000000 });

export function contextWindowFor(suffix) {
  return typeof suffix === 'string' && suffix.toLowerCase() === '[1m]' ? CONTEXT_WINDOW.large : CONTEXT_WINDOW.default;
}
