import { lstat as fsLstat, realpath as fsRealpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { classifyBash } from '../tools/bash-readonly.js';
import { CLODENT_TOOLS, mentionRegExp, pathRegExp, splitPattern } from './rules.js';

const PATH_FIELDS = { Read: 'file_path', Edit: 'file_path', Write: 'file_path', Grep: 'path', Glob: 'path' };
const LISTING_TOOLS = new Set(['Grep', 'Glob']);
const DATA_VOLUME = '/System/Volumes/Data';

export const OPEN_GUARD = Object.freeze({
  active: false,
  removes: () => false,
  check: async () => null,
  screen: async () => ({ ruled: null, hidden: null }),
});

const removedBy = (deny, tool) => deny.some((rule) => rule.kind === 'tool' && rule.tool === tool);

export function sentTools({ deny = [] } = {}) {
  return CLODENT_TOOLS.filter((tool) => !removedBy(deny, tool));
}

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

function pathMatch(rules, tool, paths, forms) {
  return rules.find(
    (rule) => rule.kind === 'path' && rule.tools.includes(tool) && forms.get(rule).some((form) => paths.some((path) => form.regex.test(path))),
  );
}

function bashMatch(rules, command, readOnly, forms) {
  const trimmed = command.trim();
  const commands = [trimmed, ...simpleCommands(command)];
  const text = command.replaceAll('\\ ', ' ');
  return rules.find((rule) => {
    if (rule.kind === 'bash') return commands.some((one) => rule.test(one));
    if (rule.kind !== 'path' || rule.bash === null || !forms.get(rule).some((form) => form.mention.test(text))) return false;
    return rule.bash === 'read' || !readOnly();
  });
}

async function resolveForms(rules, realpath) {
  const reals = new Map();
  const forms = new Map();
  await Promise.all(
    rules
      .filter((rule) => rule.kind === 'path')
      .map(async (rule) => {
        const { prefix, rest } = splitPattern(rule.pattern);
        if (!reals.has(prefix)) reals.set(prefix, realpathDeep(prefix, realpath));
        const real = await reals.get(prefix);
        const own = { regex: rule.regex, mention: rule.mention };
        if (real === prefix) return forms.set(rule, [own]);
        const pattern = rest === '' ? real : join(real, rest);
        forms.set(rule, [own, { regex: pathRegExp(pattern), mention: mentionRegExp(pattern, rule.home) }]);
      }),
  );
  return forms;
}

export function createGuard({ deny = [], ask = [] } = {}, deps = {}) {
  const realpath = deps.realpath ?? fsRealpath;
  const lstat = deps.lstat ?? fsLstat;
  const platform = deps.platform ?? process.platform;
  const lists = [
    ['deny', deny],
    ['ask', ask],
  ];
  let forms;
  const formsOf = () => (forms ??= resolveForms([...deny, ...ask], realpath));
  const spellings = (path) =>
    platform === 'darwin' && path.startsWith(`${DATA_VOLUME}/`) ? [path, path.slice(DATA_VOLUME.length)] : [path];

  async function rootOf(tool, input, cwd) {
    const value = input?.[PATH_FIELDS[tool]] ?? (LISTING_TOOLS.has(tool) ? '.' : undefined);
    if (typeof value !== 'string') return null;
    const lexical = resolve(cwd, value);
    return { lexical, real: await realpathDeep(lexical, realpath) };
  }

  function verdict(tool, input, root, ruleForms) {
    const bare = (rules) => rules.find((rule) => rule.kind === 'tool' && rule.tool === tool);
    let match;
    if (tool === 'Bash') {
      const command = input?.command;
      let classified;
      const readOnly = () => (classified ??= classifyBash(command)).readOnly;
      match = (rules) => bare(rules) ?? (typeof command === 'string' ? bashMatch(rules, command, readOnly, ruleForms) : undefined);
    } else if (Object.hasOwn(PATH_FIELDS, tool)) {
      const paths = root ? [...spellings(root.lexical), ...spellings(root.real)] : [];
      match = (rules) => bare(rules) ?? pathMatch(rules, tool, paths, ruleForms);
    } else {
      match = bare;
    }
    for (const [decision, rules] of lists) {
      const rule = match(rules);
      if (rule) return { decision, rule };
    }
    return null;
  }

  function listingFilter(tool, root, mode, ruleForms) {
    if (!LISTING_TOOLS.has(tool)) return null;
    const rules = (mode === 'yolo' ? deny : [...deny, ...ask]).filter((rule) => rule.kind === 'path' && rule.tools.includes(tool));
    if (rules.length === 0) return null;
    const regexes = rules.flatMap((rule) => ruleForms.get(rule).map((form) => form.regex));
    const denied = (path) => spellings(path).some((one) => regexes.some((regex) => regex.test(one)));
    const mapped = root && root.real !== root.lexical ? (path) => join(root.real, relative(root.lexical, path)) : null;
    return async (path) => {
      if (denied(path) || (mapped && denied(mapped(path)))) return true;
      let entry;
      try {
        entry = await lstat(path);
      } catch {
        return false;
      }
      return entry.isSymbolicLink() && denied(await realpathDeep(path, realpath));
    };
  }

  async function screen(tool, input, cwd, mode) {
    const ruleForms = await formsOf();
    const root = await rootOf(tool, input, cwd);
    return { ruled: verdict(tool, input, root, ruleForms), hidden: listingFilter(tool, root, mode, ruleForms) };
  }

  return {
    active: deny.length > 0 || ask.length > 0,
    removes: (tool) => removedBy(deny, tool),
    check: async (tool, input, cwd) => (await screen(tool, input, cwd)).ruled,
    screen,
  };
}
