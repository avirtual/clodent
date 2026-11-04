import { classifyBash } from '../tools/bash-readonly.js';

const ALLOW = Object.freeze({ allow: true });
export const ASK_DENIAL = 'permission required: rerun with --yolo (interactive approval lands in the REPL)';

export function decide(tool, input, mode) {
  if (mode === 'yolo') return ALLOW;
  if (mode !== 'ask' && mode !== 'read-only') return { allow: false, reason: `unknown permission mode ${mode}` };
  if (tool.kind === 'read') return ALLOW;
  if (tool.name === 'Bash' && (mode === 'ask' || mode === 'read-only') && classifyBash(input?.command ?? '').readOnly) return ALLOW;
  if (mode === 'read-only' && tool.name === 'Bash') return { allow: false, reason: `--read-only: Bash command is not read-only (${classifyBash(input?.command ?? '').reason})` };
  if (mode === 'read-only') return { allow: false, reason: `--read-only: ${tool.name} is not allowed` };
  return { allow: false, reason: ASK_DENIAL };
}
