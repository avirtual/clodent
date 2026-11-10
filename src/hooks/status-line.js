import { CRED_ENV } from '../tools/clodex.js';
import { toolEnv } from '../tools/env.js';
import { commandLabel, failureOf, runCommand } from './command.js';
import { CONTEXT_WINDOW } from './context-window.js';

export const STATUS_LINE_TIMEOUT_MS = 5000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function usedPercentage(usedTokens, windowSize) {
  if (!(windowSize > 0) || !(usedTokens > 0)) return 0;
  return Math.min(100, Math.round((usedTokens / windowSize) * 1000) / 10);
}

export function statusLineInput(state, ctx) {
  const size = state.contextWindow ?? CONTEXT_WINDOW.default;
  const used = state.usedTokens ?? 0;
  return {
    session_id: state.sessionId,
    transcript_path: state.transcriptPath,
    cwd: ctx.cwd,
    version: ctx.version,
    model: { id: state.modelId, display_name: state.modelId },
    workspace: { current_dir: ctx.cwd },
    context_window: {
      used_tokens: used,
      total_input_tokens: state.totalInputTokens ?? 0,
      context_window_size: size,
      used_percentage: usedPercentage(used, size),
    },
    cost: { total_cost_usd: state.totalCostUsd ?? 0 },
  };
}

export function createStatusLine(ctx, deps = {}) {
  const settings = ctx.settings ?? {};
  const command = settings.statusLine?.command;
  if (typeof command !== 'string' || command === '') {
    return { update() {}, flush: () => Promise.resolve() };
  }
  const warn = deps.warn ?? (() => {});
  const env = { ...toolEnv({ ...ctx.env, ...settings.env }, [...(settings.envDeny ?? []), CRED_ENV]), CLODENT_PROJECT_DIR: ctx.cwd };
  let queued = null;
  let running = null;
  let warned = false;
  const drain = async () => {
    while (queued) {
      const state = queued;
      queued = null;
      const stdin = `${JSON.stringify(statusLineInput(state, ctx))}\n`;
      const res = await runCommand(command, { cwd: ctx.cwd, env, stdin, timeoutMs: STATUS_LINE_TIMEOUT_MS }, deps);
      const failure = failureOf(res);
      if (failure && !warned) {
        warned = true;
        warn(`statusLine "${commandLabel(command)}": ${failure}`);
      }
    }
    running = null;
  };
  return {
    update(state) {
      if (!isObject(state)) return;
      queued = state;
      if (!running) running = drain();
    },
    flush() {
      return running ?? Promise.resolve();
    },
  };
}
