import { parseRule, RuleError } from '../permissions/rules.js';

export const SANDBOX_NOTICE = 'sandbox: clodent does not sandbox Bash; filesystem and credentials entries are enforced as permission rules, other keys ignored';
const NONE = Object.freeze({ deny: [], envDeny: [] });

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function section(parent, key, where) {
  const value = parent[key];
  if (value !== undefined && !isObject(value)) throw new RuleError(`${where}.${key} is not an object`);
  return value ?? {};
}

function list(parent, key, where) {
  const value = parent[key];
  if (value !== undefined && !Array.isArray(value)) throw new RuleError(`${where}.${key} is not an array`);
  return value ?? [];
}

function rulePath(path) {
  return path.startsWith('/') ? `/${path}` : path;
}

function ruleFor(tool, path, key, where) {
  try {
    return parseRule(`${tool}(${rulePath(path)})`, where);
  } catch (err) {
    if (!(err instanceof RuleError)) throw err;
    throw new RuleError(`${key} ${JSON.stringify(path)}: ${err.message}`);
  }
}

function pathRules(paths, tool, key, where) {
  return paths.map((path, i) => {
    if (typeof path !== 'string') throw new RuleError(`${key}[${i}] is not a string`);
    return ruleFor(tool, path, `${key}[${i}]`, where);
  });
}

function denyEntries(entries, field, key, warn) {
  const kept = [];
  entries.forEach((entry, i) => {
    if (!isObject(entry)) throw new RuleError(`${key}[${i}] is not an object`);
    if (typeof entry[field] !== 'string') throw new RuleError(`${key}[${i}].${field} is not a string`);
    if (entry.mode === 'deny') kept.push({ value: entry[field], key: `${key}[${i}].${field}` });
    else warn(`sandbox: ignored entry ${JSON.stringify(entry)}`);
  });
  return kept;
}

export function sandboxGuard(sandbox, where, warn) {
  if (!isObject(sandbox) || sandbox.enabled !== true) return NONE;
  const filesystem = section(sandbox, 'filesystem', 'sandbox');
  const credentials = section(sandbox, 'credentials', 'sandbox');
  const denyRead = list(filesystem, 'denyRead', 'sandbox.filesystem');
  const denyWrite = list(filesystem, 'denyWrite', 'sandbox.filesystem');
  const files = denyEntries(list(credentials, 'files', 'sandbox.credentials'), 'path', 'sandbox.credentials.files', warn);
  const envVars = denyEntries(list(credentials, 'envVars', 'sandbox.credentials'), 'name', 'sandbox.credentials.envVars', warn);
  const deny = [
    ...pathRules(denyRead, 'Read', 'sandbox.filesystem.denyRead', where),
    ...pathRules(denyWrite, 'Edit', 'sandbox.filesystem.denyWrite', where),
    ...files.flatMap(({ value, key }) => [ruleFor('Read', value, key, where), ruleFor('Edit', value, key, where)]),
  ];
  warn(SANDBOX_NOTICE);
  return { deny, envDeny: envVars.map(({ value }) => value) };
}
