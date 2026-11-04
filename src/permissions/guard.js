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
  screen: async () => ({ ruled: null, hidden: null, approved: null }),
});

const removedBy = (deny, tool) => deny.some((rule) => rule.kind === 'tool' && rule.tool === tool);

export function sentTools({ deny = [] } = {}) {
  return CLODENT_TOOLS.filter((tool) => !removedBy(deny, tool));
}

export function denialReason(rule) {
  return `denied by ${rule.builtin ? 'built-in' : 'settings'} rule ${rule.text}`;
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
      if (c === '\\' && quote !== "'" && i + 1 < text.length) current += text[++i];
      else if (c === quote.at(-1)) quote = null;
    } else if ((c === '\\' && i + 1 < text.length) || (c === '$' && text[i + 1] === '$')) {
      current += c + text[++i];
    } else if (c === '$' && text[i + 1] === "'") {
      quote = "$'";
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

const WORD_BREAK = ' \t\n;&|()<>';
const DOUBLE_ESCAPES = '$`"\\\n';
const ANSI_ESCAPE = /\\(?:([abeEfnrtv\\'"?])|([0-7]{1,3})|x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|c([^]))/g;
const ANSI_SIMPLE = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

function ansiChar(whole, simple, octal, hex, short, long, ctrl) {
  if (simple) return ANSI_SIMPLE[simple] ?? simple;
  if (ctrl) return String.fromCharCode(ctrl === '?' ? 0x7f : ctrl.charCodeAt(0) & 0x1f);
  const code = octal ? Number.parseInt(octal, 8) & 0xff : Number.parseInt(hex ?? short ?? long, 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
}

function ansiQuoted(text, start) {
  let close = start;
  while (close < text.length && text[close] !== "'") close += text[close] === '\\' ? 2 : 1;
  return [text.slice(start, close).replace(ANSI_ESCAPE, ansiChar).split('\0')[0], close];
}

export function shellWords(text) {
  const words = [];
  const frames = [];
  let word = null;
  let quote = null;
  const end = () => {
    if (word) words.push(word);
    word = null;
  };
  const add = (chars) => {
    word = (word ?? '') + chars;
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else add(c);
    } else if (c === '\\' && i + 1 < text.length) {
      const next = text[++i];
      if (quote === '"' && !DOUBLE_ESCAPES.includes(next)) add(c + next);
      else if (next !== '\n') add(next);
    } else if (c === '`' && frames.at(-1)?.close === '`') {
      end();
      quote = frames.pop().quote;
    } else if (c === '`' || (c === '$' && text[i + 1] === '(')) {
      end();
      frames.push({ close: c === '`' ? '`' : ')', quote });
      quote = null;
      if (c === '$') i += 1;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else add(c);
    } else if (c === '$' && text[i + 1] === '$') {
      add('$$');
      i += 1;
    } else if (c === '$' && text[i + 1] === "'") {
      const [chars, close] = ansiQuoted(text, i + 2);
      add(chars);
      i = close;
    } else if (c === '$' && text[i + 1] === '"') {
      quote = '"';
      i += 1;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === ')' && frames.at(-1)?.close === ')') {
      end();
      quote = frames.pop().quote;
    } else if (WORD_BREAK.includes(c)) {
      end();
    } else {
      add(c);
    }
  }
  end();
  return words;
}

const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;
const USER_PREFIX = /^~([^/]+)/;
const CWD_TILDE = /^~(?:\+|[+-]?0+)(?=\/|$)/;
const DATA_PREFIX = /^\/System\/Volumes\/Data(?=\/)/i;

function expandHome(word, home) {
  const tilde = CWD_TILDE.exec(word);
  if (tilde) return `.${word.slice(tilde[0].length)}`;
  if (!home) return word;
  const prefix = HOME_PREFIX.exec(word);
  if (prefix) return home + word.slice(prefix[0].length);
  const user = USER_PREFIX.exec(word);
  return user ? join(dirname(home), user[1]) + word.slice(user[0].length) : word;
}

function wordPaths(command, cwd) {
  const words = shellWords(command).flatMap((word) => {
    const at = word.indexOf('=');
    return at === -1 ? [word] : [word, word.slice(at + 1)];
  });
  const byHome = new Map();
  return (home) => {
    if (!byHome.has(home)) {
      const paths = words.filter((word) => word !== '').map((word) => resolve(cwd, expandHome(word, home)));
      byHome.set(home, paths.flatMap((path) => (DATA_PREFIX.test(path) ? [path, path.replace(DATA_PREFIX, '')] : [path])));
    }
    return byHome.get(home);
  };
}

const mentions = (rule, text, words, forms) =>
  forms.get(rule).some((form) => form.mention.test(text) || words(rule.home).some((path) => form.word.test(path)));

const matchesPaths = (rule, paths, forms) => forms.get(rule).some((form) => paths.some((path) => form.regex.test(path)));

function pathMatch(rules, tool, paths, forms) {
  return rules.find((rule) => rule.kind === 'path' && rule.tools.includes(tool) && matchesPaths(rule, paths, forms));
}

function bashMatch(rules, command, cwd, readOnly, forms) {
  const trimmed = command.trim();
  const commands = [trimmed, ...simpleCommands(command)];
  const text = command.replaceAll('\\ ', ' ');
  const words = wordPaths(command, cwd);
  return rules.find((rule) => {
    if (rule.kind === 'bash') return commands.some((one) => rule.test(one));
    if (rule.kind !== 'path' || rule.bash === null || !mentions(rule, text, words, forms)) return false;
    return rule.bash === 'read' || !readOnly();
  });
}

const formOf = (regex, mention) => ({ regex, mention, word: new RegExp(regex.source, 'i') });
const patternForm = (pattern, home) => formOf(pathRegExp(pattern), mentionRegExp(pattern, home));

async function resolveForms(rules, realpath, platform) {
  const reals = new Map();
  const forms = new Map();
  await Promise.all(
    rules
      .filter((rule) => rule.kind === 'path')
      .map(async (rule) => {
        const { prefix, rest } = splitPattern(rule.pattern);
        if (!reals.has(prefix)) reals.set(prefix, realpathDeep(prefix, realpath));
        const real = await reals.get(prefix);
        const list = [formOf(rule.regex, rule.mention)];
        if (real !== prefix) list.push(patternForm(rest === '' ? real : join(real, rest), rule.home));
        if (platform === 'darwin' && rule.pattern.startsWith(`${DATA_VOLUME}/`)) {
          list.push(patternForm(rule.pattern.slice(DATA_VOLUME.length), rule.home));
        }
        forms.set(rule, list);
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
  const formsOf = () => (forms ??= resolveForms([...deny, ...ask], realpath, platform));
  const spellings = (path) =>
    platform === 'darwin' && path.startsWith(`${DATA_VOLUME}/`) ? [path, path.slice(DATA_VOLUME.length)] : [path];

  async function rootOf(tool, input, cwd) {
    const value = input?.[PATH_FIELDS[tool]] ?? (LISTING_TOOLS.has(tool) ? '.' : undefined);
    if (typeof value !== 'string') return null;
    const lexical = resolve(cwd, value);
    return { lexical, real: await realpathDeep(lexical, realpath) };
  }

  const rootPaths = (root) => (root ? [...spellings(root.lexical), ...spellings(root.real)] : []);

  function verdict(tool, input, cwd, paths, ruleForms) {
    const bare = (rules) => rules.find((rule) => rule.kind === 'tool' && rule.tool === tool);
    let match;
    if (tool === 'Bash') {
      const command = input?.command;
      let classified;
      const readOnly = () => (classified ??= classifyBash(command, cwd)).readOnly;
      match = (rules) => bare(rules) ?? (typeof command === 'string' ? bashMatch(rules, command, cwd, readOnly, ruleForms) : undefined);
    } else if (Object.hasOwn(PATH_FIELDS, tool)) {
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

  function listingFilter(root, rules, ruleForms) {
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
    const paths = rootPaths(root);
    const ruled = verdict(tool, input, cwd, paths, ruleForms);
    if (!LISTING_TOOLS.has(tool)) return { ruled, hidden: null, approved: null };
    const rules = (mode === 'yolo' ? deny : [...deny, ...ask]).filter((rule) => rule.kind === 'path' && rule.tools.includes(tool));
    const hidden = listingFilter(root, rules, ruleForms);
    if (ruled?.decision !== 'ask') return { ruled, hidden, approved: hidden };
    const kept = rules.filter((rule) => !ask.includes(rule) || !matchesPaths(rule, paths, ruleForms));
    return { ruled, hidden, approved: listingFilter(root, kept, ruleForms) };
  }

  return {
    active: deny.length > 0 || ask.length > 0,
    removes: (tool) => removedBy(deny, tool),
    check: async (tool, input, cwd) => (await screen(tool, input, cwd)).ruled,
    screen,
  };
}
