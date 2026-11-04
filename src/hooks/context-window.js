// 200000 is unverified for these models; it is the conservative choice: a smaller window makes Clodex nudge a compact earlier, never later.
export const CONTEXT_WINDOW = Object.freeze({
  default: 200000,
  'claude-opus-5-5': 200000,
  'claude-sonnet-5-5': 200000,
  'claude-haiku-5-5': 200000,
  'claude-fable-5-1': 200000,
});

export function contextWindowFor(modelId) {
  return Object.hasOwn(CONTEXT_WINDOW, modelId) ? CONTEXT_WINDOW[modelId] : CONTEXT_WINDOW.default;
}
