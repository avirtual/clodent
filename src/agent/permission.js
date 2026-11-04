import { classifyBash } from '../tools/bash-readonly.js';

const ALLOW = Object.freeze({ allow: true });
export const ASK_DENIAL = 'permission required: run clodent without -p to approve it, or pass --yolo';

const MODES = new Set(['ask', 'read-only', 'accept-edits']);

export function asksInMode(mode) {
  return mode === 'ask' || mode === 'accept-edits';
}

export function decide(tool, input, mode) {
  if (mode === 'yolo') return ALLOW;
  if (!MODES.has(mode)) return { allow: false, reason: `unknown permission mode ${mode}` };
  if (tool.kind === 'read') return ALLOW;
  if (mode === 'accept-edits' && tool.kind === 'write') return ALLOW;
  if (tool.name === 'Bash' && classifyBash(input?.command ?? '').readOnly) return ALLOW;
  if (mode === 'read-only' && tool.name === 'Bash') return { allow: false, reason: `--read-only: Bash command is not read-only (${classifyBash(input?.command ?? '').reason})` };
  if (mode === 'read-only') return { allow: false, reason: `--read-only: ${tool.name} is not allowed` };
  return { allow: false, ask: true, reason: ASK_DENIAL };
}
