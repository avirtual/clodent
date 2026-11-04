import { commandLabel, failureOf, runCommand } from './command.js';

export const HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'PreCompact',
  'Stop',
]);
export const DEFAULT_HOOK_TIMEOUT_S = 60;

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const PLAIN_TEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
const DECISIONS = new Set(['allow', 'deny', 'ask']);
const BLOCKED = 'blocked by hook';
const TRUNCATED = 'stdout over 1 MiB truncated';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function buildHookInput(event, base = {}, extra = {}) {
  return {
    session_id: base.sessionId,
    transcript_path: base.transcriptPath,
    cwd: base.cwd,
    hook_event_name: event,
    permission_mode: base.permissionMode,
    ...extra,
  };
}

function matcherSubject(event, input) {
  if (TOOL_EVENTS.has(event)) return input?.tool_name;
  if (event === 'SessionStart') return input?.source;
  if (event === 'PreCompact') return input?.trigger;
  return undefined;
}

function groupMatches(event, matcher, input, warnings) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  if (!TOOL_EVENTS.has(event) && event !== 'SessionStart' && event !== 'PreCompact') return true;
  let re;
  try {
    re = new RegExp(`^(?:${matcher})$`);
  } catch {
    warnings.push(`hook ${event} matcher "${matcher}": invalid regex; never matches`);
    return false;
  }
  return re.test(String(matcherSubject(event, input) ?? ''));
}

function textOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function readJsonOutput(event, parsed) {
  const result = {};
  const output = isObject(parsed.hookSpecificOutput) ? parsed.hookSpecificOutput : {};
  if (typeof output.additionalContext === 'string' && output.additionalContext.trim() !== '') {
    result.context = output.additionalContext;
  }
  if (event !== 'PreToolUse') return result;
  if (DECISIONS.has(output.permissionDecision)) {
    result.decision = output.permissionDecision;
    result.reason = textOrNull(output.permissionDecisionReason) ?? (result.decision === 'deny' ? BLOCKED : null);
  }
  if (parsed.decision === 'block' && result.decision !== 'deny') {
    result.decision = 'deny';
    result.reason = textOrNull(parsed.reason) ?? BLOCKED;
  }
  if (isObject(output.updatedInput)) result.updatedInput = output.updatedInput;
  return result;
}

function interpret(event, entry, res) {
  const label = `hook ${event} "${commandLabel(entry.command)}"`;
  const result = interpretOutput(event, entry, res, label);
  if (!res.truncated) return result;
  return { ...result, warnings: [`${label}: ${TRUNCATED}`, ...(result.warnings ?? [])] };
}

function parseObject(text) {
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function interpretOutput(event, entry, res, label) {
  const failure = failureOf(res);
  if (failure === 'exit 2' && res.code === 2) {
    if (event === 'PreToolUse') return { decision: 'deny', reason: res.stderr.trim() || BLOCKED };
    return { warnings: [`${label}: exit 2`] };
  }
  if (failure) {
    if (event === 'PreToolUse' && entry.onFailure === 'block') return { decision: 'deny', reason: `hook failed: ${failure}` };
    return { warnings: [`${label}: ${failure}`] };
  }
  const text = res.stdout.trim();
  const parsed = text === '' ? null : parseObject(text);
  if (event === 'PreToolUse' && entry.onFailure === 'block' && (res.truncated || (text !== '' && !parsed))) {
    return { decision: 'deny', reason: `hook failed: ${res.truncated ? TRUNCATED : 'invalid JSON'}` };
  }
  if (text === '') return {};
  if (parsed) return readJsonOutput(event, parsed);
  if (PLAIN_TEXT_EVENTS.has(event)) return { context: res.stdout.trimEnd() };
  return { warnings: [`${label}: invalid JSON ignored`] };
}

function timeoutMsFor(entry) {
  const seconds = typeof entry.timeout === 'number' && Number.isFinite(entry.timeout) && entry.timeout > 0 ? entry.timeout : DEFAULT_HOOK_TIMEOUT_S;
  return seconds * 1000;
}

function mergeDuplicate(kept, duplicate) {
  return {
    ...kept,
    onFailure: kept.onFailure === 'block' || duplicate.onFailure === 'block' ? 'block' : kept.onFailure,
    timeout: timeoutMsFor(duplicate) > timeoutMsFor(kept) ? duplicate.timeout : kept.timeout,
  };
}

export async function runHooks(event, input, ctx, deps = {}) {
  if (!HOOK_EVENTS.includes(event)) throw new Error(`unknown hook event: ${event}`);
  const settings = ctx.settings ?? {};
  const warnings = [];
  const entries = new Map();
  for (const group of settings.hooks?.[event] ?? []) {
    if (!groupMatches(event, group.matcher, input, warnings)) continue;
    for (const entry of group.hooks ?? []) {
      if (entry?.type !== 'command' || typeof entry.command !== 'string') continue;
      const seen = entries.get(entry.command);
      entries.set(entry.command, seen ? mergeDuplicate(seen, entry) : entry);
    }
  }
  const env = { ...ctx.env, ...settings.env, CLODENT_PROJECT_DIR: ctx.cwd };
  const stdin = `${JSON.stringify(input)}\n`;
  const results = await Promise.all(
    [...entries.values()].map(async (entry) => {
      const res = await runCommand(entry.command, { cwd: ctx.cwd, env, stdin, timeoutMs: timeoutMsFor(entry), signal: ctx.signal }, deps);
      return interpret(event, entry, res);
    }),
  );
  const outcome = { additionalContext: [], decision: null, reason: null, updatedInput: null, warnings };
  const firstReason = new Map();
  for (const result of results) {
    if (result.context) outcome.additionalContext.push(result.context);
    if (result.decision && !firstReason.has(result.decision)) firstReason.set(result.decision, result.reason ?? null);
    if (result.updatedInput) outcome.updatedInput = result.updatedInput;
    if (result.warnings) warnings.push(...result.warnings);
  }
  for (const decision of ['deny', 'ask', 'allow']) {
    if (firstReason.has(decision)) {
      outcome.decision = decision;
      outcome.reason = firstReason.get(decision);
      break;
    }
  }
  return outcome;
}
