import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_RELOAD_FILES } from '../agent/compact.js';
import { CACHE_TTLS, EFFORTS } from '../api/request.js';
import { HOOK_CONTEXT_DEFAULTS, HOOK_CONTEXT_MAX_BYTES, HOOK_CONTEXT_MIN_BYTES } from '../hooks/context-cap.js';
import { HOOK_EVENTS } from '../hooks/run.js';
import { parseRules, RuleError, ruleHome } from '../permissions/rules.js';
import { sandboxGuard } from './sandbox.js';

const ON_FAILURE = Object.freeze(['block', 'warn']);
const CLAUDE_ONLY_EVENTS = Object.freeze(['SubagentStart', 'SubagentStop', 'SessionEnd', 'PermissionRequest']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readSource(path, optional, readFile) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      if (optional) return null;
      throw new Error(`settings file not found: ${path}`);
    }
    throw new Error(`cannot read settings file ${path}: ${err?.message ?? err}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid settings file ${path}: ${err.message}`);
  }
  if (!isObject(parsed)) throw new Error(`invalid settings file ${path}: top level is not an object`);
  return parsed;
}

function normalizeEntry(entry, where, warn) {
  if (!isObject(entry)) {
    warn(`${where} is not an object; dropped`);
    return null;
  }
  if (entry.type !== 'command') {
    warn(`${where} has type ${JSON.stringify(entry.type) ?? 'undefined'}; only "command" hooks run; dropped`);
    return null;
  }
  if (typeof entry.command !== 'string' || entry.command.trim() === '') {
    warn(`${where} has no command; dropped`);
    return null;
  }
  let timeout = null;
  if (entry.timeout !== undefined && entry.timeout !== null) {
    if (typeof entry.timeout === 'number' && Number.isFinite(entry.timeout) && entry.timeout > 0) timeout = entry.timeout;
    else warn(`${where}.timeout is not a positive number of seconds; the default applies`);
  }
  let onFailure = null;
  if (entry.onFailure !== undefined && entry.onFailure !== null) {
    if (ON_FAILURE.includes(entry.onFailure)) onFailure = entry.onFailure;
    else {
      onFailure = 'warn';
      warn(`${where}.onFailure ${JSON.stringify(entry.onFailure)} is not "block" or "warn"; treated as "warn"`);
    }
  }
  return { type: 'command', command: entry.command, timeout, onFailure };
}

function normalizeGroup(group, where, warn) {
  if (!isObject(group) || !Array.isArray(group.hooks)) {
    warn(`${where} is not a {matcher, hooks: [...]} group; dropped`);
    return null;
  }
  const matcher = group.matcher ?? '';
  if (typeof matcher !== 'string') {
    warn(`${where}.matcher is not a string; group dropped`);
    return null;
  }
  const hooks = [];
  group.hooks.forEach((entry, i) => {
    const normalized = normalizeEntry(entry, `${where}.hooks[${i}]`, warn);
    if (normalized) hooks.push(normalized);
  });
  return { matcher, hooks };
}

function mergeHooks(acc, hooks, warn) {
  if (!isObject(hooks)) {
    warn('hooks is not an object; ignored');
    return;
  }
  for (const [event, groups] of Object.entries(hooks)) {
    if (!HOOK_EVENTS.includes(event) && !CLAUDE_ONLY_EVENTS.includes(event)) warn(`hooks.${event} is not a known event; it never fires`);
    if (!Array.isArray(groups)) {
      warn(`hooks.${event} is not an array; ignored`);
      continue;
    }
    groups.forEach((group, i) => {
      const normalized = normalizeGroup(group, `hooks.${event}[${i}]`, warn);
      if (!normalized) return;
      if (!acc.hooks.has(event)) acc.hooks.set(event, []);
      acc.hooks.get(event).push(normalized);
    });
  }
}

function mergeEnv(acc, env, warn) {
  if (!isObject(env)) {
    warn('env is not an object; ignored');
    return;
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') acc.env.set(key, value);
    else warn(`env.${key} is not a string; dropped`);
  }
}

function mergeDirs(acc, dirs, name, warn) {
  if (dirs === undefined) return;
  if (!Array.isArray(dirs)) {
    warn(`${name} is not an array; ignored`);
    return;
  }
  dirs.forEach((dir, i) => {
    if (typeof dir === 'string' && dir !== '') acc.extraDirs.add(dir);
    else warn(`${name}[${i}] is not a path; dropped`);
  });
}

function mergeGuard(acc, source, where, warn) {
  if (source.permissions !== undefined) {
    if (!isObject(source.permissions)) throw new RuleError('permissions is not an object');
    acc.deny.push(...parseRules(source.permissions.deny, 'permissions.deny', where));
    acc.ask.push(...parseRules(source.permissions.ask, 'permissions.ask', where));
    acc.allow.push(...parseRules(source.permissions.allow, 'permissions.allow', where));
  }
  const sandbox = sandboxGuard(source.sandbox, where, warn);
  acc.deny.push(...sandbox.deny);
  for (const name of sandbox.envDeny) acc.envDeny.add(name);
}

function mergeReloadFiles(acc, source, path) {
  const value = source.compactReloadFiles;
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > MAX_RELOAD_FILES) {
    throw new Error(`settings ${path}: compactReloadFiles ${JSON.stringify(value)} is not an integer from 0 to ${MAX_RELOAD_FILES}`);
  }
  acc.compactReloadFiles = value;
}

function mergeContextCaps(acc, source, path) {
  const value = source.hookContextMaxBytes;
  if (value === undefined) return;
  const fail = (message) => {
    throw new Error(`settings ${path}: hookContextMaxBytes${message}`);
  };
  if (!isObject(value)) fail(` ${JSON.stringify(value)} is not an object {perHook, perEvent}`);
  for (const [key, bytes] of Object.entries(value)) {
    if (!Object.hasOwn(HOOK_CONTEXT_DEFAULTS, key)) fail(`.${key} is not perHook or perEvent`);
    if (!Number.isInteger(bytes) || bytes < HOOK_CONTEXT_MIN_BYTES || bytes > HOOK_CONTEXT_MAX_BYTES) {
      fail(`.${key} ${JSON.stringify(bytes)} is not an integer from ${HOOK_CONTEXT_MIN_BYTES} to ${HOOK_CONTEXT_MAX_BYTES}`);
    }
  }
  acc.hookContextMaxBytes = { ...(acc.hookContextMaxBytes ?? HOOK_CONTEXT_DEFAULTS), ...value };
}

function mergeSource(acc, source, warn) {
  if (source.hooks !== undefined) mergeHooks(acc, source.hooks, warn);
  if (source.statusLine !== undefined) {
    const line = source.statusLine;
    if (isObject(line) && line.type === 'command' && typeof line.command === 'string' && line.command.trim() !== '') {
      acc.statusLine = { type: 'command', command: line.command };
    } else {
      warn('statusLine is not {type: "command", command}; ignored');
    }
  }
  if (source.env !== undefined) mergeEnv(acc, source.env, warn);
  mergeDirs(acc, source.trustedDirectories, 'trustedDirectories', warn);
  if (source.permissions !== undefined) mergeDirs(acc, source.permissions.additionalDirectories, 'permissions.additionalDirectories', warn);
  if (source.effortLevel !== undefined) {
    if (EFFORTS.includes(source.effortLevel)) acc.effortLevel = source.effortLevel;
    else warn(`effortLevel ${JSON.stringify(source.effortLevel)} is not low, medium, high, xhigh or max; ignored`);
  }
  if (source.cacheTtl !== undefined) {
    if (CACHE_TTLS.includes(source.cacheTtl)) acc.cacheTtl = source.cacheTtl;
    else warn(`cacheTtl ${JSON.stringify(source.cacheTtl)} is not 5m or 1h; ignored`);
  }
  if (source.messageCacheTtl !== undefined) {
    if (CACHE_TTLS.includes(source.messageCacheTtl)) acc.messageCacheTtl = source.messageCacheTtl;
    else warn(`messageCacheTtl ${JSON.stringify(source.messageCacheTtl)} is not 5m or 1h; ignored`);
  }
  if (source.model !== undefined) {
    if (typeof source.model === 'string' && source.model !== '') acc.model = source.model;
    else warn('model is not a non-empty string; ignored');
  }
}

export async function loadSettings({ clodentHome, files = [], cwd = process.cwd(), home = ruleHome(process.env) } = {}, deps = {}) {
  const readFile = deps.readFile ?? fsReadFile;
  const sources = [];
  if (clodentHome) sources.push({ path: join(clodentHome, 'settings.json'), optional: true });
  for (const path of files) sources.push({ path, optional: false });
  const acc = { hooks: new Map(), statusLine: null, env: new Map(), extraDirs: new Set(), effortLevel: null, cacheTtl: null, messageCacheTtl: null, model: null, compactReloadFiles: null, hookContextMaxBytes: null, deny: [], ask: [], allow: [], envDeny: new Set() };
  const warnings = [];
  for (const { path, optional } of sources) {
    const source = await readSource(path, optional, readFile);
    if (!source) continue;
    const warn = (message) => warnings.push(`settings ${path}: ${message}`);
    try {
      mergeGuard(acc, source, { file: path, cwd, home }, warn);
    } catch (err) {
      if (err instanceof RuleError) throw new Error(`settings ${path}: ${err.message}`);
      throw err;
    }
    mergeReloadFiles(acc, source, path);
    mergeContextCaps(acc, source, path);
    mergeSource(acc, source, warn);
  }
  const settings = {
    hooks: Object.fromEntries(acc.hooks),
    statusLine: acc.statusLine,
    env: Object.fromEntries(acc.env),
    extraDirs: [...acc.extraDirs],
  };
  if (acc.effortLevel) settings.effortLevel = acc.effortLevel;
  if (acc.cacheTtl) settings.cacheTtl = acc.cacheTtl;
  if (acc.messageCacheTtl) settings.messageCacheTtl = acc.messageCacheTtl;
  if (acc.model) settings.model = acc.model;
  if (acc.compactReloadFiles !== null) settings.compactReloadFiles = acc.compactReloadFiles;
  if (acc.hookContextMaxBytes !== null) settings.hookContextMaxBytes = acc.hookContextMaxBytes;
  if (acc.deny.length > 0 || acc.ask.length > 0 || acc.allow.length > 0) settings.permissions = { deny: acc.deny, ask: acc.ask, allow: acc.allow };
  if (acc.envDeny.size > 0) settings.envDeny = [...acc.envDeny];
  return { settings, warnings };
}
