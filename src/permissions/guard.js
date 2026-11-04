import { lstat as fsLstat, readdir as fsReaddir, realpath as fsRealpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { classifyBash, searchesTree } from '../tools/bash-readonly.js';
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

export function denialReason(rule, uncertain = false) {
  const reason = `denied by ${rule.builtin ? 'built-in' : 'settings'} rule ${rule.text}`;
  return uncertain ? `${reason}, which may apply to a command that could not be parsed with certainty` : reason;
}

export const uncertainDecision = (list, mode, kind = 'strong') => (list === 'deny' && mode === 'yolo' && kind === 'strong' ? 'deny' : 'ask');

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

function pastContinuations(text, at) {
  while (text[at] === '\\' && text[at + 1] === '\n') at += 2;
  return at;
}

const tokenOf = (c) => (' \t\n;&|()'.includes(c) ? 'none' : '<>'.includes(c) ? 'redirect' : '$=?*+@!'.includes(c) ? 'glue' : 'word');
const startsComment = (token) => token === 'none' || token === 'redirect';
const gluesParen = (token) => token === 'glue' || token === 'redirect';

function frameOf(frames, close, quote, inWord) {
  frames.push({ close, quote, inWord, ticked: close === '`' || frames.at(-1)?.ticked === true });
}

function popToTick(frames) {
  while (frames.at(-1).close !== '`') frames.pop();
}

function pastComment(text, at, frames) {
  const ticked = frames.at(-1)?.ticked === true;
  let k = at;
  while (k < text.length && text[k] !== '\n' && !(ticked && text[k] === '`')) k += ticked && text[k] === '\\' && text[k + 1] !== '\n' ? 2 : 1;
  if (text[k] === '`') popToTick(frames);
  return k - 1;
}

export function simpleCommands(text) {
  const out = [];
  const frames = [];
  let current = '';
  let quote = null;
  let token = 'none';
  const push = () => {
    if (current.trim() !== '') out.push(current.trim());
    current = '';
  };
  const enter = (close, inWord) => {
    push();
    frameOf(frames, close, quote, inWord);
    quote = null;
    token = 'none';
  };
  const leave = () => {
    push();
    const frame = frames.pop();
    quote = frame.quote;
    token = frame.inWord ? 'word' : 'none';
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const j = c === '$' ? pastContinuations(text, i + 1) : i + 1;
    const braced = frames.at(-1)?.close === '}';
    if (quote === "'" || quote === "$'") {
      current += c;
      if (c === '\\' && quote === "$'" && i + 1 < text.length) current += text[++i];
      else if (c === "'") quote = null;
    } else if (c === '\\' && i + 1 < text.length) {
      current += c + text[++i];
      if (text[i] !== '\n') token = 'word';
    } else if (c === '`') {
      if (frames.at(-1)?.ticked) {
        popToTick(frames);
        leave();
      } else enter('`', true);
    } else if (c === '$' && text[j] === '(') {
      current += text.slice(i, j);
      i = j;
      enter(')', true);
    } else if (c === '$' && text[j] === '{') {
      current += text.slice(i, j + 1);
      i = j;
      frameOf(frames, '}', quote, true);
      quote = null;
    } else if (quote === '"') {
      current += c;
      if (c === '"') quote = null;
    } else if (c === '$' && (text[j] === '$' || text[j] === "'")) {
      if (text[j] === "'") quote = "$'";
      current += text.slice(i, j + 1);
      i = j;
      token = 'word';
    } else if (c === "'" || c === '"') {
      quote = c;
      current += c;
      token = 'word';
    } else if (braced && c === '}') {
      current += c;
      quote = frames.pop().quote;
      token = 'word';
    } else if (braced && (c === '#' || c === '(' || c === ')')) {
      current += c;
    } else if (c === '#' && startsComment(token)) {
      i = pastComment(text, i, frames);
    } else if (c === '(') {
      enter(')', gluesParen(token));
    } else if (c === ')' && frames.at(-1)?.close === ')') {
      leave();
    } else if (';&|\n)'.includes(c)) {
      push();
      token = c === ')' ? 'word' : 'none';
      if ((c === '&' || c === '|') && text[i + 1] === c) i += 1;
    } else {
      current += c;
      token = tokenOf(c);
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
  let token = 'none';
  const end = () => {
    if (word) words.push(word);
    word = null;
  };
  const add = (chars) => {
    word = (word ?? '') + chars;
    token = 'word';
  };
  const enter = (close, inWord) => {
    end();
    frameOf(frames, close, quote, inWord);
    quote = null;
    token = 'none';
  };
  const leave = () => {
    end();
    const frame = frames.pop();
    quote = frame.quote;
    token = frame.inWord ? 'word' : 'none';
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const j = c === '$' ? pastContinuations(text, i + 1) : i + 1;
    const braced = frames.at(-1)?.close === '}';
    if (quote === "'") {
      if (c === "'") quote = null;
      else add(c);
    } else if (c === '\\' && i + 1 < text.length) {
      const next = text[++i];
      if (quote === '"' && !DOUBLE_ESCAPES.includes(next)) add(c + next);
      else if (next !== '\n') add(next);
    } else if (c === '`' && frames.at(-1)?.ticked) {
      popToTick(frames);
      leave();
    } else if (c === '`' || (c === '$' && text[j] === '(')) {
      if (c === '$') i = j;
      enter(c === '`' ? '`' : ')', true);
    } else if (c === '$' && text[j] === '{') {
      add('${');
      i = j;
      frameOf(frames, '}', quote, true);
      quote = null;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else add(c);
    } else if (c === '$' && text[j] === '$') {
      add('$$');
      i = j;
    } else if (c === '$' && text[j] === "'") {
      const [chars, close] = ansiQuoted(text, j + 1);
      add(chars);
      i = close;
    } else if (c === '$' && text[j] === '"') {
      quote = '"';
      token = 'word';
      i = j;
    } else if (c === "'" || c === '"') {
      quote = c;
      token = 'word';
    } else if (braced && c === '}') {
      add(c);
      quote = frames.pop().quote;
    } else if (braced && (c === '#' || c === '(' || c === ')')) {
      add(c);
    } else if (c === '#' && startsComment(token)) {
      i = pastComment(text, i, frames);
    } else if (c === '(') {
      enter(')', gluesParen(token));
    } else if (c === ')' && frames.at(-1)?.close === ')') {
      leave();
    } else if (WORD_BREAK.includes(c)) {
      end();
      token = c === ')' ? 'word' : tokenOf(c);
    } else {
      add(c);
      token = tokenOf(c);
    }
  }
  end();
  return words;
}

const RAW_UNQUOTE = /['"\\]/g;

export function rawCommands(text) {
  return text
    .split(/[;&|\n()`#]/)
    .map((piece) => piece.replace(RAW_UNQUOTE, '').trim())
    .filter((piece) => piece !== '');
}

export function rawWords(text) {
  return text
    .replace(RAW_UNQUOTE, '')
    .split(/[ \t\n;&|()<>`#]+/)
    .flatMap((word) => {
      const at = word.indexOf('=');
      return at === -1 ? [word] : [word, word.slice(at + 1)];
    })
    .flatMap((word) => {
      const bare = word.replaceAll('${', '$').replaceAll('}', '');
      return bare === word ? [word] : [word, bare];
    })
    .filter((word) => word !== '');
}

const PRECISE = { commands: simpleCommands, words: shellWords };
const RAW = { commands: rawCommands, words: rawWords };

const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;
const USER_PREFIX = /^~([^/]+)/;
const CWD_TILDE = /^~(?:\+|[+-]?0+)(?=\/|$)/;
const DIR_STACK = /^~(?:-|[+-]?0*[1-9]\d*)(?=\/|$)/;
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

function wordPaths(command, cwd, split) {
  const words = split(command).flatMap((word) => {
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

const UNKNOWN = '\u0000';
const VAGUE = '\u0001';
const WILD = /[\0\x01]/;
const BRACE_CAP = 1024;
const BRACE_DEPTH = 64;
const VISIT_CAP = 10_000;
const DIR_CAP = 64;
const QUOTED = { '*': '', '?': '', '[': '', '{': '', '}': '', ',': '', $: '' };
const UNQUOTED = Object.fromEntries(Object.entries(QUOTED).map(([c, q]) => [q, c]));
const MARKER = /\\([*?[{},$])/g;
const QUOTED_CHAR = /[-]/g;
const MARKED_AFTER_DOLLAR = /[A-Za-z0-9_@*#?!{-]/;
const VARIABLE = /\$(?:\{([^}]*)(?:[}]|$)|([A-Za-z_][A-Za-z0-9_]*)|[0-9@*#?$!-])/g;
const SEQUENCE = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.(-?\d+))?$/;
const GLOB = /[*?]|\[[^/]*\]/;
const POSIX_CLASS = /\[[:=.]/;
const HEAD_END = /[\0\x01*?[]/;
const ENV_VARIABLES = new Set(['USER', 'LOGNAME', 'TMPDIR', 'SHELL', 'PATH']);
const LEADING_WORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{', 'time', 'builtin', 'command']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const CHANGES_DIR = new Set(['cd', 'pushd']);
const CDPATH_FREE = /^(?:\/|\.\.?(?:\/|$))/;
const OPTION_VALUES = { grep: 'ABCDdefm', egrep: 'ABCDdefm', fgrep: 'ABCDdefm', rg: 'ABCdEefgjMmrTt' };

function marked(text) {
  let out = '';
  let escapes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const special = c === '$' ? MARKED_AFTER_DOLLAR.test(text[i + 1] ?? '') : '*?[{},'.includes(c) && !(c === '{' && text[i - 1] === '$');
    if (special) out += escapes % 2 === 0 ? '\\' : '\\\\';
    out += c;
    escapes = c === '\\' ? escapes + 1 : 0;
  }
  return out;
}

const decoded = (word) => word.replace(MARKER, (_, c) => QUOTED[c]);
const literal = (text) => text.replace(QUOTED_CHAR, (q) => UNQUOTED[q]);
const fold = (text) => literal(text).toLowerCase();

function steps(from, to, step) {
  const out = [];
  for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? step : -step) out.push(n);
  return out;
}

function sequence(body) {
  const match = SEQUENCE.exec(body);
  if (!match) return null;
  const [, from, to, first, last, by] = match;
  const step = Math.abs(Number(by ?? 1)) || 1;
  const [a, b] = first ? [first.charCodeAt(0), last.charCodeAt(0)] : [Number(from), Number(to)];
  const safe = [a, b, step].every(Number.isSafeInteger);
  const count = safe ? Math.floor(Math.abs(b - a) / step) + 1 : Infinity;
  if (first) return { count, values: () => steps(a, b, step).map((code) => String.fromCharCode(code)) };
  const width = /^-?0\d/.test(from) || /^-?0\d/.test(to) ? Math.max(from.length, to.length) : 0;
  const pad = (n) => (n < 0 ? `-${String(-n).padStart(width - 1, '0')}` : String(n).padStart(width, '0'));
  return { count, values: () => steps(a, b, step).map(pad) };
}

function braceGroups(word) {
  const groups = new Map();
  const stack = [];
  for (let i = 0; i < word.length; i += 1) {
    const c = word[i];
    if (c === '$' && word[i + 1] === '{') {
      const close = word.slice(i + 2).search(/[}]/);
      if (close === -1) break;
      i += close + 2;
    } else if (c === '{') stack.push({ at: i, commas: [] });
    else if (c === ',' && stack.length > 0) stack.at(-1).commas.push(i);
    else if (c === '}' && stack.length > 0) {
      const open = stack.pop();
      const seq = open.commas.length === 0 ? sequence(word.slice(open.at + 1, i)) : null;
      if (open.commas.length > 0 || seq) groups.set(open.at, { close: i, commas: open.commas, seq });
    }
  }
  return groups;
}

function expansions(word, groups, start, end, depth) {
  if (depth > BRACE_DEPTH) return null;
  let out = [''];
  let text = '';
  for (let k = start; k < end; k += 1) {
    const group = groups.get(k);
    if (!group || group.close >= end) {
      text += word[k];
      continue;
    }
    let parts = [];
    if (group.seq) {
      if (!(group.seq.count <= BRACE_CAP)) return null;
      parts = group.seq.values();
    } else {
      const bounds = [k, ...group.commas, group.close];
      for (let b = 0; b + 1 < bounds.length; b += 1) {
        const sub = expansions(word, groups, bounds[b] + 1, bounds[b + 1], depth + 1);
        if (!sub || parts.length + sub.length > BRACE_CAP) return null;
        parts.push(...sub);
      }
    }
    if (out.length * parts.length > BRACE_CAP) return null;
    out = out.flatMap((head) => parts.map((part) => head + text + part));
    text = '';
    k = group.close;
  }
  return out.map((head) => head + text);
}

function braced(word) {
  const groups = braceGroups(word);
  if (groups.size === 0) return [word];
  const all = expansions(word, groups, 0, word.length, 0);
  if (all) return all;
  for (const [at, group] of groups) if (!group.seq && word.slice(at + 1, group.close).includes('.')) return [UNKNOWN];
  let out = '';
  for (let k = 0; k < word.length; k += 1) {
    const group = groups.get(k);
    if (group) {
      out += UNKNOWN;
      k = group.close;
    } else out += word[k];
  }
  return [out];
}

function expandVars(text, dir, home, env) {
  return text.replace(VARIABLE, (whole, inBraces, plain) => {
    const name = inBraces ?? plain;
    if (name === 'HOME') return home ?? UNKNOWN;
    if (name === 'PWD') return dir;
    if (ENV_VARIABLES.has(name) && env) return env[name] ?? '';
    return name === 'OLDPWD' || ENV_VARIABLES.has(name) ? UNKNOWN : VAGUE;
  });
}

const placed = (text, base) => (text.startsWith('/') || WILD.test(text[0] ?? '') ? text : `${base}/${text}`);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function classSource(body) {
  const negate = body[0] === '!' || body[0] === '^';
  const members = [...(negate ? body.slice(1) : body)].map((c) => literal(c).replace(/[\\\]^[]/, '\\$&')).join('');
  return negate ? `[^/${members}]` : `[${members}]`;
}

function segmentRegExp(segment, flags) {
  if (POSIX_CLASS.test(segment)) return null;
  let source = '';
  let closes = true;
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i];
    let close = -1;
    if (c === '[' && closes) {
      let j = i + 1;
      if (segment[j] === '!' || segment[j] === '^') j += 1;
      if (segment[j] === ']') j += 1;
      close = segment.indexOf(']', j);
      closes = close !== -1;
    }
    if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else if (close !== -1) {
      source += classSource(segment.slice(i + 1, close));
      i = close;
    } else source += escapeRegExp(literal(c));
  }
  try {
    return new RegExp(`^${source}$`, flags);
  } catch {
    return null;
  }
}

async function globbed(path, list, budget) {
  let heads = [''];
  for (const segment of path.split('/')) {
    if (segment === '') continue;
    if (!GLOB.test(segment)) {
      heads = heads.map((head) => `${head}/${literal(segment)}`);
      continue;
    }
    const regex = segmentRegExp(segment, '');
    if (!regex) return null;
    const dotted = segment[0] === '.';
    const next = [];
    for (const head of heads) {
      const names = await list(head || '/');
      budget.visited += names.length + 1;
      if (budget.visited > VISIT_CAP) return null;
      for (const name of dotted ? ['.', '..', ...names] : names) {
        if ((dotted || name[0] !== '.') && regex.test(name)) next.push(`${head}/${name}`);
      }
    }
    if (next.length === 0) return [];
    heads = next;
  }
  return heads.map((head) => resolve(head || '/'));
}

const wildClimbs = (segment) => WILD.test(segment) && segment.replace(/[\0\x01]/g, '') === '..';
const globClimbs = (segment) => segment[0] === '.' && GLOB.test(segment) && (segmentRegExp(segment, 's')?.test('..') ?? true);

function looseSegments(path) {
  const strong = path.includes(UNKNOWN) || !path.includes(VAGUE);
  const out = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (globClimbs(segment)) return { segments: [UNKNOWN], strong: true };
    if (segment === '..' ? WILD.test(out.at(-1) ?? '') : wildClimbs(segment)) return { segments: [UNKNOWN], strong };
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return { segments: out, strong };
}

function segmentFits(segment, name) {
  if (!GLOB.test(segment)) return fold(segment) === name.toLowerCase();
  const regex = segmentRegExp(segment, 'is');
  return !regex || regex.test(name);
}

function couldReach(segments, prefix, asRoot) {
  for (let j = 0; j < prefix.length; j += 1) {
    if (j === segments.length) return asRoot;
    const segment = segments[j];
    if (WILD.test(segment)) {
      const end = segment.search(HEAD_END);
      return prefix.slice(j).join('/').toLowerCase().startsWith(fold(segment.slice(0, end)));
    }
    if (!segmentFits(segment, prefix[j])) return false;
  }
  return true;
}

async function expandWord(word, dirs, scope) {
  const paths = new Set();
  const loose = [];
  const budget = { visited: 0 };
  const seen = new Set();
  for (const text of braced(word)) {
    const homed = DIR_STACK.test(text) ? text.replace(DIR_STACK, UNKNOWN) : expandHome(text, scope.home);
    for (const dir of dirs) {
      const value = expandVars(homed, dir, scope.home, scope.env);
      const bases = scope.cdpath && !CDPATH_FREE.test(value) ? [dir, ...scope.cdpath.map((entry) => placed(entry, dir))] : [dir];
      for (const base of bases) {
        const path = placed(value, base);
        if (seen.has(path)) continue;
        seen.add(path);
        if (WILD.test(path)) {
          loose.push(path);
          continue;
        }
        paths.add(resolve(literal(path)));
        if (!GLOB.test(path)) continue;
        const matched = await globbed(path, scope.list, budget);
        if (matched) for (const one of matched) paths.add(one);
        else loose.push(path);
      }
    }
  }
  return { paths: [...paths], loose };
}

function searchOperands(head, args) {
  const takes = OPTION_VALUES[head] ?? '';
  const operands = [];
  let byOption = !Object.hasOwn(OPTION_VALUES, head);
  let unsure = false;
  let options = true;
  for (let k = 0; k < args.length; k += 1) {
    const arg = literal(args[k]);
    if (!options || arg === '-' || !arg.startsWith('-')) operands.push(args[k]);
    else if (arg === '--') options = false;
    else if (arg.startsWith('--')) {
      byOption ||= /^--(?:regexp|file)/.test(arg);
      unsure ||= takes !== '' && !arg.includes('=');
    } else {
      const at = [...arg.slice(1)].findIndex((letter) => takes.includes(letter));
      byOption ||= at !== -1 && 'ef'.includes(arg[at + 1]);
      if (at !== -1 && at + 2 === arg.length) k += 1;
    }
  }
  if (unsure) return { operands, implicit: true };
  const paths = byOption ? operands : operands.slice(1);
  return { operands: paths, implicit: paths.length === 0 };
}

async function reachOf(command, cwd, scope) {
  const text = marked(command);
  const dirs = new Set([typeof cwd === 'string' ? cwd : UNKNOWN]);
  const add = (dir) => {
    if (!dirs.has(dir)) dirs.add(dirs.size < DIR_CAP ? dir : UNKNOWN);
  };
  const cdScope = { ...scope, cdpath: scope.env?.CDPATH ? scope.env.CDPATH.split(':') : null };
  const searches = [];
  for (const piece of simpleCommands(text)) {
    const words = shellWords(piece).map(decoded);
    let at = 0;
    while (at < words.length && (LEADING_WORDS.has(words[at]) || ASSIGNMENT.test(words[at]))) at += 1;
    const [head, ...args] = words.slice(at);
    if (head === undefined) continue;
    if (CHANGES_DIR.has(head)) {
      const target = args.find((arg) => arg === '-' || !arg.startsWith('-'));
      if (target === undefined) {
        if (head === 'cd') add(scope.home ?? UNKNOWN);
      } else if (target === '-') add(UNKNOWN);
      else if (head === 'cd' || !/^\+\d+$/.test(target)) {
        for (const dir of [...dirs]) {
          const { paths, loose } = await expandWord(target, [dir], cdScope);
          paths.forEach(add);
          if (loose.length > 0) add(loose.some((path) => looseSegments(path).strong) ? UNKNOWN : VAGUE);
        }
      }
    }
    const name = basename(literal(head));
    if (searchesTree(name, args.map(literal))) searches.push({ head: name, ...searchOperands(name, args) });
  }
  const paths = new Set();
  const loose = [];
  const all = [...dirs];
  for (const word of shellWords(text).map(decoded)) {
    const at = word.indexOf('=');
    for (const one of at === -1 ? [word] : [word, word.slice(at + 1)]) {
      const reach = await expandWord(one, all, scope);
      reach.paths.forEach((path) => paths.add(path));
      loose.push(...reach.loose.map(looseSegments));
    }
  }
  const roots = [];
  for (const { head, operands, implicit } of searches) {
    if (implicit) {
      for (const dir of all) roots.push({ head, ...looseSegments(dir) });
      all.filter((dir) => !WILD.test(dir)).forEach((dir) => paths.add(dir));
    }
    for (const operand of operands) {
      const reach = await expandWord(operand, all, scope);
      roots.push(...[...reach.paths, ...reach.loose].map((path) => ({ head, ...looseSegments(path) })));
    }
  }
  const spelled = [...paths].flatMap((path) => (DATA_PREFIX.test(path) ? [path, path.replace(DATA_PREFIX, '')] : [path]));
  return { paths: spelled, loose, roots };
}

const shown = (segments) => literal(`/${segments.join('/')}`).replace(/[\0\x01]+/g, '…');

const mentions = (rule, text, words, forms) =>
  forms.get(rule).some((form) => form.mention.test(text) || words(rule.home).some((path) => form.word.test(path)));

const matchesPaths = (rule, paths, forms) => forms.get(rule).some((form) => paths.some((path) => form.regex.test(path)));

function pathMatch(rules, tool, paths, forms) {
  return rules.find((rule) => rule.kind === 'path' && rule.tools.includes(tool) && matchesPaths(rule, paths, forms));
}

const reachesPath = (rule, reaches, forms) =>
  reaches !== null && forms.get(rule).some((form) => reaches.get(rule.home).paths.some((path) => form.word.test(path)));

function bashMatch(rules, command, cwd, readOnly, forms, reaches, pass = PRECISE) {
  const trimmed = command.trim();
  const commands = [trimmed, ...pass.commands(command)];
  const text = command.replaceAll('\\ ', ' ');
  const words = wordPaths(command, cwd, pass.words);
  return rules.find((rule) => {
    if (rule.kind === 'bash') return commands.some((one) => rule.test(one));
    if (rule.kind !== 'path' || rule.bash === null) return false;
    if (!mentions(rule, text, words, forms) && !reachesPath(rule, reaches, forms)) return false;
    return rule.bash === 'read' || !readOnly();
  });
}

function looseMatch(rules, reaches, forms, readOnly, strong) {
  for (const rule of rules) {
    if (rule.kind !== 'path' || rule.bash === null || (rule.bash !== 'read' && readOnly())) continue;
    const { loose, roots } = reaches.get(rule.home);
    const prefixes = forms.get(rule).map((form) => form.prefix);
    const reaching = (asRoot) => (one) => one.strong === strong && prefixes.some((prefix) => couldReach(one.segments, prefix, asRoot));
    const word = loose.find(reaching(false));
    if (word) return { rule, reason: `${shown(word.segments)} may name a path ${rule.text} guards` };
    const root = rule.bash === 'read' && roots.find(reaching(true));
    if (root) {
      return { rule, reason: `${root.head} searches ${shown(root.segments)} recursively, which may read files ${rule.text} guards; the Grep tool skips denied files` };
    }
  }
  return null;
}

const prefixOf = (pattern) => splitPattern(pattern).prefix.split('/').filter((segment) => segment !== '');
const formOf = (regex, mention, pattern) => ({ regex, mention, word: new RegExp(regex.source, 'i'), prefix: prefixOf(pattern) });
const patternForm = (pattern, home) => formOf(pathRegExp(pattern), mentionRegExp(pattern, home), pattern);

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
        const list = [formOf(rule.regex, rule.mention, rule.pattern)];
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
  const readdir = deps.readdir ?? fsReaddir;
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

  async function reachesOf(command, cwd) {
    const reaches = new Map();
    const listed = new Map();
    const list = (dir) => {
      if (!listed.has(dir)) listed.set(dir, (async () => readdir(dir))().then((names) => names.map(String), () => []));
      return listed.get(dir);
    };
    for (const rule of [...deny, ...ask]) {
      if (rule.kind !== 'path' || rule.bash === null || reaches.has(rule.home)) continue;
      reaches.set(rule.home, await reachOf(command, cwd, { home: rule.home, env: deps.env, list }));
    }
    return reaches;
  }

  function verdict(tool, input, cwd, paths, ruleForms, reaches, mode) {
    const bare = (rules) => rules.find((rule) => rule.kind === 'tool' && rule.tool === tool);
    let match;
    let readOnly;
    let unsure = () => undefined;
    if (tool === 'Bash') {
      const command = input?.command;
      let classified;
      readOnly = () => (classified ??= classifyBash(command, cwd)).readOnly;
      match = (rules) => bare(rules) ?? (typeof command === 'string' ? bashMatch(rules, command, cwd, readOnly, ruleForms, reaches) : undefined);
      unsure = (rules) => (typeof command === 'string' ? bashMatch(rules, command, cwd, readOnly, ruleForms, null, RAW) : undefined);
    } else if (Object.hasOwn(PATH_FIELDS, tool)) {
      match = (rules) => bare(rules) ?? pathMatch(rules, tool, paths, ruleForms);
    } else {
      match = bare;
    }
    for (const [decision, rules] of lists) {
      const rule = match(rules);
      if (rule) return { decision, rule };
      const raw = unsure(rules);
      if (raw) return { decision: uncertainDecision(decision, mode), rule: raw, uncertain: true };
      for (const kind of reaches ? ['strong', 'weak'] : []) {
        const loose = looseMatch(rules, reaches, ruleForms, readOnly, kind === 'strong');
        if (loose) return { decision: uncertainDecision(decision, mode, kind), ...loose };
      }
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
    const reaches = tool === 'Bash' && typeof input?.command === 'string' ? await reachesOf(input.command, cwd) : null;
    const ruled = verdict(tool, input, cwd, paths, ruleForms, reaches, mode);
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
