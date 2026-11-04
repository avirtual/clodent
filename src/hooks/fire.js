import { buildHookInput, runHooks } from './run.js';

export const PERMISSION_MODES = Object.freeze({ ask: 'default', yolo: 'bypassPermissions', 'read-only': 'plan', 'accept-edits': 'acceptEdits' });

export function emptyOutcome() {
  return { additionalContext: [], decision: null, reason: null, updatedInput: null, warnings: [], truncations: [] };
}

export const NO_HOOKS = Object.freeze({ fire: async () => emptyOutcome() });

const FRAME = /<(\/?hook-context)/gi;

export function hookContextBlock(event, texts) {
  if (texts.length === 0) return null;
  const body = texts.map((text) => text.replace(FRAME, '&lt;$1')).join('\n\n');
  return { type: 'text', text: `<hook-context event="${event}">\n${body}\n</hook-context>` };
}

export function createHookFirer({ settings, env, cwd, sessionId, transcriptPath, permission }, deps = {}) {
  const base = { sessionId, transcriptPath, cwd, permissionMode: PERMISSION_MODES[permission] ?? permission };
  return {
    fire(event, extra = {}, signal) {
      return runHooks(event, buildHookInput(event, base, extra), { settings, env, cwd, signal }, deps);
    },
  };
}
