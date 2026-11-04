const ALLOW = Object.freeze({ allow: true });
export const ASK_DENIAL = 'permission required: run clay without -p to approve it, or pass --yolo';

export function decide(tool, input, mode) {
  if (mode === 'yolo') return ALLOW;
  if (mode !== 'ask' && mode !== 'read-only') return { allow: false, reason: `unknown permission mode ${mode}` };
  if (tool.kind === 'read') return ALLOW;
  if (mode === 'read-only') return { allow: false, reason: `--read-only: ${tool.name} is not allowed` };
  return { allow: false, ask: true, reason: ASK_DENIAL };
}
