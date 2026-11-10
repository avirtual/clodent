import { resolve, sep } from 'node:path';
import { rawWords, shellWords } from '../permissions/guard.js';
import { isProtected } from '../permissions/rules.js';
import { classifyBash } from '../tools/bash-readonly.js';
import { toolEnv } from '../tools/env.js';

const ALLOW = Object.freeze({ allow: true });
export const ASK_DENIAL = 'permission required: run clodent without -p to approve it, or pass --yolo';

const MODES = new Set(['ask', 'read-only', 'accept-edits']);
const LEADING_VAR = /^(?:~(?=\/|$)|\$(HOME|CLODENT_PROJECT_DIR|CLAUDE_PROJECT_DIR|PWD)(?![A-Za-z0-9_])|\$\{(HOME|CLODENT_PROJECT_DIR|CLAUDE_PROJECT_DIR|PWD)\})/;

export function asksInMode(mode) {
  return mode === 'ask' || mode === 'accept-edits';
}

function hookCommands(settings) {
  const commands = Object.values(settings?.hooks ?? {}).flatMap((groups) => groups.flatMap((group) => group.hooks.map((entry) => entry.command)));
  return [...commands, settings?.statusLine?.command].filter((command) => typeof command === 'string');
}

export function hookPaths(settings, { cwd, env = {}, home }) {
  const vars = { ...toolEnv({ ...env, ...settings?.env }, settings?.envDeny), CLODENT_PROJECT_DIR: cwd, PWD: cwd };
  const expand = (word) => {
    const match = LEADING_VAR.exec(word);
    if (!match) return word;
    const name = match[1] ?? match[2];
    return (name ? (vars[name] ?? '') : (vars.HOME ?? home)) + word.slice(match[0].length);
  };
  const words = hookCommands(settings).flatMap((command) => [...shellWords(command), ...rawWords(command)].map(expand));
  const paths = (named) => [...new Set(words.filter((word) => word.includes('/') === named).map((word) => resolve(cwd, word)))];
  return { named: paths(true), bare: paths(false) };
}

const within = (path, dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

function editsFreely(input, cwd, scope) {
  const file = input?.file_path;
  if (typeof file !== 'string' || typeof cwd !== 'string') return false;
  const path = resolve(cwd, file);
  if (isProtected(path, scope?.protect)) return false;
  return [cwd, ...(scope?.dirs ?? [])].some((dir) => within(path, resolve(cwd, dir)));
}

export function decide(tool, input, mode, cwd, scope) {
  if (mode === 'yolo') return ALLOW;
  if (!MODES.has(mode)) return { allow: false, reason: `unknown permission mode ${mode}` };
  if (tool.kind === 'read') return ALLOW;
  if (mode === 'accept-edits' && tool.kind === 'write' && editsFreely(input, cwd, scope)) return ALLOW;
  if (tool.name === 'Bash' && classifyBash(input?.command ?? '', cwd).readOnly) return ALLOW;
  if (mode === 'read-only' && tool.name === 'Bash') return { allow: false, reason: `--read-only: Bash command is not read-only (${classifyBash(input?.command ?? '', cwd).reason})` };
  if (mode === 'read-only') return { allow: false, reason: `--read-only: ${tool.name} is not allowed` };
  return { allow: false, ask: true, reason: ASK_DENIAL };
}
