import { realpath as fsRealpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { classifyBash } from '../tools/bash-readonly.js';

const PATH_FIELDS = { Read: 'file_path', Edit: 'file_path', Write: 'file_path', Grep: 'path', Glob: 'path' };
const LISTING_TOOLS = new Set(['Grep', 'Glob']);

export const OPEN_GUARD = Object.freeze({
  removes: () => false,
  check: async () => null,
  hidden: () => null,
});

export function denialReason(rule) {
  return `denied by settings rule ${rule.text}`;
}

async function realpathDeep(path, realpath) {
  const rest = [];
  let head = path;
  for (;;) {
    try {
      return join(await realpath(head), ...rest);
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      rest.unshift(basename(head));
      head = parent;
    }
  }
}

export function simpleCommands(text) {
  const out = [];
  let current = '';
  let quote = null;
  const push = () => {
    if (current.trim() !== '') out.push(current.trim());
    current = '';
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      current += c;
      if (c === '\\' && quote === '"' && i + 1 < text.length) current += text[++i];
      else if (c === quote) quote = null;
    } else if (c === '\\' && i + 1 < text.length) {
      current += c + text[++i];
    } else if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (';&|\n()`'.includes(c)) {
      push();
      if ((c === '&' || c === '|') && text[i + 1] === c) i += 1;
    } else {
      current += c;
    }
  }
  push();
  return out;
}

function pathMatch(rules, tool, paths) {
  return rules.find((rule) => rule.kind === 'path' && rule.tools.includes(tool) && paths.some((path) => rule.regex.test(path)));
}

function bashMatch(rules, command, readOnly) {
  const trimmed = command.trim();
  const commands = [trimmed, ...simpleCommands(command)];
  const text = command.replaceAll('\\ ', ' ');
  return rules.find((rule) => {
    if (rule.kind === 'bash') return commands.some((one) => rule.test(one));
    if (rule.kind !== 'path' || rule.bash === null || !rule.mention.test(text)) return false;
    return rule.bash === 'read' || !readOnly();
  });
}

export function createGuard({ deny = [], ask = [] } = {}, deps = {}) {
  const realpath = deps.realpath ?? fsRealpath;
  const lists = [
    ['deny', deny],
    ['ask', ask],
  ];

  async function pathsOf(tool, input, cwd) {
    const value = input?.[PATH_FIELDS[tool]] ?? (LISTING_TOOLS.has(tool) ? '.' : undefined);
    if (typeof value !== 'string') return [];
    const lexical = resolve(cwd, value);
    return [lexical, await realpathDeep(lexical, realpath)];
  }

  async function check(tool, input, cwd) {
    const bare = (rules) => rules.find((rule) => rule.kind === 'tool' && rule.tool === tool);
    let match;
    if (tool === 'Bash') {
      const command = input?.command;
      let verdict;
      const readOnly = () => (verdict ??= classifyBash(command)).readOnly;
      match = (rules) => bare(rules) ?? (typeof command === 'string' ? bashMatch(rules, command, readOnly) : undefined);
    } else if (Object.hasOwn(PATH_FIELDS, tool)) {
      const paths = await pathsOf(tool, input, cwd);
      match = (rules) => bare(rules) ?? pathMatch(rules, tool, paths);
    } else {
      match = bare;
    }
    for (const [decision, rules] of lists) {
      const rule = match(rules);
      if (rule) return { decision, rule };
    }
    return null;
  }

  function hidden(tool) {
    if (!LISTING_TOOLS.has(tool)) return null;
    const rules = deny.filter((rule) => rule.kind === 'path' && rule.tools.includes(tool));
    if (rules.length === 0) return null;
    return (path) => rules.some((rule) => rule.regex.test(path));
  }

  return {
    removes: (tool) => deny.some((rule) => rule.kind === 'tool' && rule.tool === tool),
    check,
    hidden,
  };
}
