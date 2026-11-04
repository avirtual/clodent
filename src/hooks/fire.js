import { buildHookInput, runHooks } from './run.js';

export const PERMISSION_MODES = Object.freeze({ ask: 'default', yolo: 'bypassPermissions', 'read-only': 'plan' });

export function emptyOutcome() {
  return { additionalContext: [], decision: null, reason: null, updatedInput: null, warnings: [] };
}

export const NO_HOOKS = Object.freeze({ fire: async () => emptyOutcome() });

export function hookContextBlock(event, texts) {
  if (texts.length === 0) return null;
  return { type: 'text', text: `<hook-context event="${event}">\n${texts.join('\n\n')}\n</hook-context>` };
}

export function createHookFirer({ settings, env, cwd, sessionId, transcriptPath, permission }, deps = {}) {
  const base = { sessionId, transcriptPath, cwd, permissionMode: PERMISSION_MODES[permission] ?? permission };
  return {
    fire(event, extra = {}, signal) {
      return runHooks(event, buildHookInput(event, base, extra), { settings, env, cwd, signal }, deps);
    },
  };
}
