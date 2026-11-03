import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';

const EFFORTS = new Set(['low', 'medium', 'high']);

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
    if (typeof entry.onFailure === 'string') onFailure = entry.onFailure;
    else warn(`${where}.onFailure is not a string; ignored`);
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
  if (source.permissions !== undefined) {
    if (isObject(source.permissions)) mergeDirs(acc, source.permissions.additionalDirectories, 'permissions.additionalDirectories', warn);
    else warn('permissions is not an object; ignored');
  }
  if (source.effortLevel !== undefined) {
    if (EFFORTS.has(source.effortLevel)) acc.effortLevel = source.effortLevel;
    else warn(`effortLevel ${JSON.stringify(source.effortLevel)} is not low, medium or high; ignored`);
  }
  if (source.model !== undefined) {
    if (typeof source.model === 'string' && source.model !== '') acc.model = source.model;
    else warn('model is not a non-empty string; ignored');
  }
}

export async function loadSettings({ clayHome, files = [] } = {}, deps = {}) {
  const readFile = deps.readFile ?? fsReadFile;
  const sources = [];
  if (clayHome) sources.push({ path: join(clayHome, 'settings.json'), optional: true });
  for (const path of files) sources.push({ path, optional: false });
  const acc = { hooks: new Map(), statusLine: null, env: new Map(), extraDirs: new Set(), effortLevel: null, model: null };
  const warnings = [];
  for (const { path, optional } of sources) {
    const source = await readSource(path, optional, readFile);
    if (source) mergeSource(acc, source, (message) => warnings.push(`settings ${path}: ${message}`));
  }
  const settings = {
    hooks: Object.fromEntries(acc.hooks),
    statusLine: acc.statusLine,
    env: Object.fromEntries(acc.env),
    extraDirs: [...acc.extraDirs],
  };
  if (acc.effortLevel) settings.effortLevel = acc.effortLevel;
  if (acc.model) settings.model = acc.model;
  return { settings, warnings };
}
