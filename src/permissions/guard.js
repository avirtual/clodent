import { lstat as fsLstat, readdir as fsReaddir, readlink as fsReadlink, realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { classifyBash, redirectsOutput, searchesTree } from '../tools/bash-readonly.js';
import { CLODENT_TOOLS, isProtected, mentionRegExp, pathRegExp, protectedRules, ruleHome, splitPattern } from './rules.js';

const PATH_FIELDS = { Read: 'file_path', Edit: 'file_path', Write: 'file_path', Grep: 'path', Glob: 'path' };
const LISTING_TOOLS = new Set(['Grep', 'Glob']);
const ALLOWED_TOOLS = { Read: ['Read', 'Grep', 'Glob'], Edit: ['Edit', 'Write'], Write: ['Write'], Grep: ['Grep'], Glob: ['Glob'] };
const SUBSTITUTION = /`|[$<>](?:\\\n)*\(/;
const DIR_CHANGES = new Set(['cd', 'pushd', 'popd']);
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);
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

const LINK_HOPS = 40;

async function linkTarget(head, rest, fs) {
  const target = (await fs.readlink(head)).replace(/\/+/g, '/').replace(/(?!^)\/$/, '');
  const base = isAbsolute(target) ? target : `${await fs.realpath(dirname(head))}/${target}`;
  return [base, ...rest].join('/');
}

async function deepestReal(path, fs, trace) {
  const rest = [];
  for (let head = path; ; ) {
    const real = await fs.realpath(head).catch(() => null);
    if (real !== null) return { real: join(real, ...rest) };
    try {
      const entry = await fs.lstat(head);
      trace.unresolved = true;
      if (entry.isSymbolicLink()) return { link: await linkTarget(head, rest, fs) };
    } catch (err) {
      if (!ABSENT.has(err?.code)) trace.unresolved = trace.uncertain = true;
    }
    const parent = dirname(head);
    if (parent === head) return {};
    rest.unshift(basename(head));
    head = parent;
  }
}

async function realpathDeep(path, fs, trace = {}) {
  let current = path;
  for (let hops = 0; ; hops += 1) {
    const { real, link } = await deepestReal(current, fs, trace);
    if (link === undefined) return real ?? current;
    if (hops === LINK_HOPS) {
      trace.unresolved = trace.uncertain = true;
      return current;
    }
    current = link;
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
const STAND_IN = '\uE007';
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
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const DEFAULTED = /^[A-Za-z_][A-Za-z0-9_]*:?[-=+]/;
const SEQUENCE = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.(-?\d+))?$/;
const GLOB = /[*?]|\[[^/]*\]/;
const POSIX_CLASS = /\[[:=.]/;
const HEAD_END = /[\0\x01*?[]/;
const ENV_VARIABLES = new Set(['USER', 'LOGNAME', 'TMPDIR', 'SHELL', 'PATH']);
const LEADING_WORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{', 'time', 'builtin', 'command']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const LOOP_WORDS = new Set(['do', 'while', 'until']);
const CHANGES_DIR = new Set(['cd', 'pushd']);
const CDPATH_FREE = /^(?:\/|\.\.?(?:\/|$))/;
const CDPATH_SET = /^CDPATH\+?=/;
const GLOBIGNORE_SET = /^GLOBIGNORE\+?=/;
const OPTION = /^-[^=]*$/;
const WRAPPERS = { env: 'uCPS', nice: 'n', nohup: '', timeout: 'ks', stdbuf: 'ioe', xargs: 'aEdIJLnPRSs' };
const WRAPPER_VALUES = /^--(?:unset|chdir|split-string|adjustment|kill-after|signal|input|output|error|arg-file|delimiter|max-args|max-lines|max-procs|max-chars)$/;
const OPTION_VALUES = { grep: 'ABCDdefm', egrep: 'ABCDdefm', fgrep: 'ABCDdefm', rg: 'ABCdEefgjMmrTt' };

function marked(text) {
  let out = '';
  let escapes = 0;
  let depth = 0;
  let opener = -1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const free = escapes % 2 === 0;
    const after = c === '$' ? pastContinuations(text, i + 1) : i + 1;
    if (free && c === '$' && text[after] === '{') {
      depth += 1;
      opener = after;
    } else if (free && c === '}' && depth > 0) depth -= 1;
    else if (c === '$' ? MARKED_AFTER_DOLLAR.test(text[i + 1] ?? '') : '*?[{},'.includes(c) && !(c === '{' && (i === opener || text[i - 1] === '$'))) {
      out += free ? '\\' : '\\\\';
    }
    out += c;
    escapes = c === '\\' ? escapes + 1 : 0;
  }
  return out;
}

const decoded = (word) => word.replace(MARKER, (_, c) => QUOTED[c]).replace(/[\0\x01]/g, STAND_IN);
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

function valueOf(name, dir, home, env) {
  if (name === 'HOME') return home ?? UNKNOWN;
  if (name === 'PWD') return dir;
  if (ENV_VARIABLES.has(name) && env) return env[name] ?? '';
  return name === 'OLDPWD' || ENV_VARIABLES.has(name) ? UNKNOWN : VAGUE;
}

function expandVars(text, dir, home, env) {
  return text.replace(VARIABLE, (whole, inBraces, plain) => {
    if (inBraces === undefined) return valueOf(plain, dir, home, env);
    const name = VARIABLE_NAME.exec(inBraces)?.[0];
    const value = valueOf(name, dir, home, env);
    if (name === inBraces) return value;
    return value.includes(UNKNOWN) ? UNKNOWN : VAGUE;
  });
}

function withDefaults(text) {
  const other = text.replace(VARIABLE, (whole, inBraces) => {
    const operator = inBraces === undefined ? null : DEFAULTED.exec(inBraces);
    return operator ? inBraces.slice(operator[0].length) : whole;
  });
  return other === text ? [text] : [text, other];
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

async function globbed(path, list, budget, dotglob) {
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
        if ((dotted || dotglob || name[0] !== '.') && regex.test(name)) next.push(`${head}/${name}`);
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

function segmentFits(segment, name, dotglob) {
  if (!GLOB.test(segment)) return fold(segment) === name.toLowerCase();
  if (!dotglob && name[0] === '.' && segment[0] !== '.') return false;
  const regex = segmentRegExp(segment, 'is');
  return !regex || regex.test(name);
}

function couldReach(segments, prefix, asRoot, dotglob) {
  for (let j = 0; j < prefix.length; j += 1) {
    if (j === segments.length) return asRoot;
    const segment = segments[j];
    if (WILD.test(segment)) {
      const end = segment.search(HEAD_END);
      return prefix.slice(j).join('/').toLowerCase().startsWith(fold(segment.slice(0, end)));
    }
    if (!segmentFits(segment, prefix[j], dotglob)) return false;
  }
  return true;
}

async function expandWord(word, dirs, scope) {
  const paths = new Set();
  const loose = [];
  const budget = { visited: 0 };
  const seen = new Set();
  for (const text of braced(word).flatMap(withDefaults)) {
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
        const matched = await globbed(path, scope.list, budget, scope.dotglob);
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

function pastWrappers(words, at) {
  let k = at;
  for (let name = basename(literal(words[k] ?? '')); Object.hasOwn(WRAPPERS, name); name = basename(literal(words[k] ?? ''))) {
    k += 1;
    for (let word = literal(words[k] ?? ''); word.startsWith('-') || (name === 'env' && ASSIGNMENT.test(word)); word = literal(words[k] ?? '')) {
      const letter = [...word.slice(1)].findIndex((one) => WRAPPERS[name].includes(one));
      const valued = word.startsWith('--') ? WRAPPER_VALUES.test(word) : letter !== -1 && letter + 2 === word.length;
      k += valued ? 2 : 1;
    }
    if (name === 'timeout') k += 1;
  }
  return k;
}

const onDisk = async (paths, list) => {
  const kept = [];
  for (const path of paths) if (path === '/' || (await list(dirname(path))).includes(basename(path))) kept.push(path);
  return kept;
};

const pathless = (word, k, at) => (k < at ? LEADING_WORDS.has(word) : (k === at && !word.includes('/')) || OPTION.test(word));

async function reachOf(command, cwd, scope) {
  const text = marked(command);
  const dirs = new Map([[typeof cwd === 'string' ? cwd : UNKNOWN, -1]]);
  const add = (dir, at) => {
    const one = dirs.has(dir) || dirs.size < DIR_CAP ? dir : UNKNOWN;
    if (!dirs.has(one) || dirs.get(one) > at) dirs.set(one, at);
  };
  const searches = [];
  const pieces = [];
  const cds = [];
  const open = [];
  let loop = null;
  let everyWord = false;
  let cdpathAt = null;
  let dotglob = false;
  let index = 0;
  for (const piece of simpleCommands(text)) {
    index += 1;
    const words = shellWords(piece).map(decoded);
    let at = 0;
    while (at < words.length && (LEADING_WORDS.has(words[at]) || ASSIGNMENT.test(words[at]))) at += 1;
    const [head, ...args] = words.slice(at);
    if (open.length === 0) loop = null;
    for (const word of words.slice(0, at)) {
      if (word === 'do' && open.at(-1) === 'while') open[open.length - 1] = 'do';
      else if (LOOP_WORDS.has(word)) open.push(word === 'do' ? 'do' : 'while');
    }
    if (open.length > 0) loop ??= { end: Infinity };
    everyWord ||= head === 'trap' || loop !== null;
    if (head === 'done' && open.pop() && open.length === 0) loop.end = index;
    if (words.some((word) => CDPATH_SET.test(word))) cdpathAt ??= index;
    dotglob ||= words.some((word) => GLOBIGNORE_SET.test(word)) || (head === 'shopt' && args.includes('dotglob'));
    pieces.push({ words: words.filter((word, k) => !pathless(word, k, at)), index });
    if (head === undefined) continue;
    if (CHANGES_DIR.has(head)) cds.push({ head, args, index, loop });
    const call = pastWrappers(words, at);
    if (call >= words.length) continue;
    const name = basename(literal(words[call]));
    const rest = words.slice(call + 1);
    if (searchesTree(name, rest.map(literal))) searches.push({ head: name, index, ...searchOperands(name, rest) });
  }
  const wordScope = { ...scope, dotglob };
  const cdScope = { ...wordScope, cdpath: scope.env?.CDPATH ? scope.env.CDPATH.split(':') : [] };
  const vagueScope = { ...cdScope, cdpath: [...cdScope.cdpath, VAGUE] };
  const scopeAt = (until) => (cdpathAt !== null && cdpathAt <= until ? vagueScope : cdScope);
  const tried = new Set();
  for (let pass = 1, fresh = true; fresh; pass += 1) {
    fresh = false;
    for (const { head, args, index: at, loop: within } of cds) {
      const until = within ? within.end : at;
      const target = args.find((arg) => arg === '-' || !arg.startsWith('-'));
      if (target === undefined) {
        if (head === 'cd') add(scope.home ?? UNKNOWN, at);
      } else if (target === '-') add(UNKNOWN, at);
      else if (head === 'cd' || !/^\+\d+$/.test(target)) {
        for (const dir of [...dirs.keys()]) {
          const key = `${at}:${dir}`;
          if (tried.has(key) || dirs.get(dir) >= until || dirs.get(dir) === at) continue;
          tried.add(key);
          fresh = true;
          const { paths, loose } = await expandWord(target, [dir], scopeAt(until));
          (within && pass > 1 ? await onDisk(paths, scope.list) : paths).forEach((path) => add(path, at));
          if (loose.length > 0) add(loose.some((path) => looseSegments(path).strong) ? UNKNOWN : VAGUE, at);
        }
      }
    }
  }
  const paths = new Set();
  const loose = [];
  const all = [...dirs.keys()];
  const dirsAt = (at) => all.filter((dir) => everyWord || !WILD.test(dir) || dirs.get(dir) < at);
  const resolveWords = async (words, against) => {
    for (const word of words) {
      const at = word.indexOf('=');
      for (const one of at === -1 ? [word] : [word, word.slice(at + 1)]) {
        const reach = await expandWord(one, against, wordScope);
        reach.paths.forEach((path) => paths.add(path));
        loose.push(...reach.loose.map(looseSegments));
      }
    }
  };
  await resolveWords(shellWords(text).map(decoded), all.filter((dir) => !WILD.test(dir) || dirs.get(dir) < 0));
  for (const { words, index: at } of pieces) {
    const later = all.filter((dir) => WILD.test(dir) && dirs.get(dir) >= 0 && (everyWord || dirs.get(dir) < at));
    if (later.length > 0) await resolveWords(words, later);
  }
  const roots = [];
  for (const { head, operands, implicit, index: at } of searches) {
    const against = dirsAt(at);
    if (implicit) {
      for (const dir of against) roots.push({ head, ...looseSegments(dir) });
      against.filter((dir) => !WILD.test(dir)).forEach((dir) => paths.add(dir));
    }
    for (const operand of operands) {
      const reach = await expandWord(operand, against, wordScope);
      roots.push(...[...reach.paths, ...reach.loose].map((path) => ({ head, ...looseSegments(path) })));
    }
  }
  const spelled = [...paths].flatMap((path) => (DATA_PREFIX.test(path) ? [path, path.replace(DATA_PREFIX, '')] : [path]));
  return { paths: spelled, loose, roots, dotglob };
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
    const { loose, roots, dotglob } = reaches.get(rule.home);
    const prefixes = forms.get(rule).map((form) => form.prefix);
    const reaching = (asRoot) => (one) => one.strong === strong && prefixes.some((prefix) => couldReach(one.segments, prefix, asRoot, dotglob));
    const word = loose.find(reaching(false));
    if (word) return { rule, reason: `${shown(word.segments)} may name a path ${rule.text} guards` };
    const root = rule.bash === 'read' && roots.find(reaching(true));
    if (root) {
      return { rule, reason: `${root.head} searches ${shown(root.segments)} recursively, which may read files ${rule.text} guards; the Grep tool skips denied files` };
    }
  }
  return null;
}

function bashAllowed(rules, command, cwd) {
  const pieces = simpleCommands(command);
  const raw = rawCommands(command);
  if (SUBSTITUTION.test(command) || pieces.length === 0 || pieces.length !== raw.length) return null;
  if (pieces.some((piece, i) => piece.replace(RAW_UNQUOTE, '').trim() !== raw[i])) return null;
  const dir = shellWords(command).some((word) => DIR_CHANGES.has(word)) ? '/' : cwd;
  let granted = null;
  for (const piece of pieces) {
    const rule = rules.find((one) => one.kind === 'bash' && one.test(piece));
    if (!(rule && !redirectsOutput(piece)) && !classifyBash(piece, dir).readOnly) return null;
    granted ??= rule ?? null;
  }
  return granted;
}

const prefixOf = (pattern) => splitPattern(pattern).prefix.split('/').filter((segment) => segment !== '');
const formOf = (regex, mention, pattern) => ({ regex, mention, word: new RegExp(regex.source, 'i'), prefix: prefixOf(pattern) });
const patternForm = (pattern, home) => formOf(pathRegExp(pattern), mentionRegExp(pattern, home), pattern);

async function resolveForms(rules, fs, platform) {
  const reals = new Map();
  const forms = new Map();
  await Promise.all(
    rules
      .filter((rule) => rule.kind === 'path')
      .map(async (rule) => {
        const { prefix, rest } = splitPattern(rule.pattern);
        if (!reals.has(prefix)) reals.set(prefix, realpathDeep(prefix, fs));
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

export function createGuard({ deny = [], ask = [], allow = [] } = {}, deps = {}) {
  const realpath = deps.realpath ?? fsRealpath;
  const lstat = deps.lstat ?? fsLstat;
  const stat = deps.stat ?? fsStat;
  const fs = { realpath, lstat, readlink: deps.readlink ?? fsReadlink };
  const platform = deps.platform ?? process.platform;
  const readdir = deps.readdir ?? fsReaddir;
  const lists = [
    ['deny', deny],
    ['ask', ask],
  ];
  let shields;
  let forms;
  const shieldsOf = () => (shields ??= protectionOf(deps.protect ?? [], deps.protectExisting ?? []));
  const formsOf = () => (forms ??= shieldsOf().then(({ rules }) => resolveForms([...deny, ...ask, ...allow, ...rules], fs, platform)));
  const spellings = (path) =>
    platform === 'darwin' && path.startsWith(`${DATA_VOLUME}/`) ? [path, path.slice(DATA_VOLUME.length)] : [path];

  async function rootOf(tool, input, cwd) {
    const value = input?.[PATH_FIELDS[tool]] ?? (LISTING_TOOLS.has(tool) ? '.' : undefined);
    if (typeof value !== 'string') return null;
    const lexical = resolve(cwd, value);
    const trace = {};
    const real = await realpathDeep(lexical, fs, trace);
    return { lexical, real, unresolved: trace.unresolved === true, uncertain: trace.uncertain === true };
  }

  const rootPaths = (root) => (root ? [...spellings(root.lexical), ...spellings(root.real)] : []);

  const withReal = async (list) => [...new Set([...list, ...(await Promise.all(list.map((file) => realpathDeep(file, fs))))])];
  const directory = (file) => stat(file).then((entry) => entry.isDirectory(), () => lstat(file).then(() => false, () => null));

  async function protectionOf(protect, protectExisting) {
    if (allow.length === 0) return { rules: [], files: [] };
    const [named, existing] = await Promise.all([withReal(protect), withReal(protectExisting)]);
    const kept = await Promise.all([
      ...named.map(async (file) => (await directory(file)) !== true),
      ...existing.map(async (file) => (await directory(file)) === false),
    ]);
    const files = [...named, ...existing];
    return { rules: protectedRules([...new Set(files.filter((file, i) => kept[i]))], deps.home ?? ruleHome(deps.env)), files: [...new Set(files)] };
  }

  async function reachesOf(command, cwd, guarded) {
    const reaches = new Map();
    const listed = new Map();
    const list = (dir) => {
      if (!listed.has(dir)) listed.set(dir, (async () => readdir(dir))().then((names) => names.map(String), () => []));
      return listed.get(dir);
    };
    for (const rule of guarded) {
      if (rule.kind !== 'path' || rule.bash === null || reaches.has(rule.home)) continue;
      reaches.set(rule.home, await reachOf(command, cwd, { home: rule.home, env: deps.env, list }));
    }
    return reaches;
  }

  function verdict(tool, input, cwd, root, ruleForms, reaches, mode, shield) {
    const paths = rootPaths(root);
    const bare = (rules) => rules.find((rule) => rule.kind === 'tool' && rule.tool === tool);
    let match;
    let readOnly;
    let unsure = () => undefined;
    if (tool === 'Bash') {
      const command = input?.command;
      let classified;
      readOnly = () => (classified ??= classifyBash(command, cwd)).readOnly;
      match = (rules) => bare(rules) ?? (typeof command === 'string' ? bashMatch(rules, command, cwd, readOnly, ruleForms, reaches) : undefined);
      unsure = (rules) => {
        const rule = typeof command === 'string' ? bashMatch(rules, command, cwd, readOnly, ruleForms, null, RAW) : undefined;
        return rule && { rule, uncertain: true };
      };
    } else if (Object.hasOwn(PATH_FIELDS, tool)) {
      match = (rules) => bare(rules) ?? pathMatch(rules, tool, paths, ruleForms);
      unsure = (rules) => {
        const rule = root?.uncertain ? rules.find((one) => one.kind === 'path' && one.tools.includes(tool)) : undefined;
        return rule && { rule, reason: `${root.lexical} may resolve to a path ${rule.text} guards: it could not be resolved` };
      };
    } else {
      match = bare;
    }
    const hit = (rules) => {
      const rule = match(rules);
      if (rule) return { rule };
      const raw = unsure(rules);
      if (raw) return { kind: 'strong', ...raw };
      for (const kind of reaches ? ['strong', 'weak'] : []) {
        const loose = looseMatch(rules, reaches, ruleForms, readOnly, kind === 'strong');
        if (loose) return { kind, ...loose };
      }
      return null;
    };
    for (const [decision, rules] of lists) {
      const found = hit(rules);
      if (!found) continue;
      const { kind, ...rest } = found;
      return { decision: kind ? uncertainDecision(decision, mode, kind) : decision, ...rest };
    }
    const rule = allow.length > 0 ? allowedBy(tool, input, cwd, root, ruleForms, () => hit(shield.rules), shield.files) : null;
    return rule ? { decision: 'allow', rule } : null;
  }

  // An allow rule needs both paths and every command, so whatever is uncertain falls back to asking.
  function allowedBy(tool, input, cwd, root, ruleForms, shielded, files) {
    const bare = allow.find((rule) => rule.kind === 'tool' && rule.tool === tool);
    if (tool === 'Bash') {
      const command = input?.command;
      if (typeof command !== 'string') return null;
      const rule = bare ?? bashAllowed(allow, command, cwd);
      return rule && !shielded() ? rule : null;
    }
    if (!Object.hasOwn(PATH_FIELDS, tool)) return bare ?? null;
    if (!root || root.unresolved || rootPaths(root).some((path) => isProtected(path, files))) return null;
    const both = (rule) => [root.lexical, root.real].every((path) => matchesPaths(rule, spellings(path), ruleForms));
    return bare ?? allow.find((rule) => rule.kind === 'path' && ALLOWED_TOOLS[rule.tool].includes(tool) && both(rule)) ?? null;
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
      return entry.isSymbolicLink() && denied(await realpathDeep(path, fs));
    };
  }

  async function screen(tool, input, cwd, mode) {
    const ruleForms = await formsOf();
    const shield = await shieldsOf();
    const root = await rootOf(tool, input, cwd);
    const paths = rootPaths(root);
    const reaches = tool === 'Bash' && typeof input?.command === 'string' ? await reachesOf(input.command, cwd, [...deny, ...ask, ...shield.rules]) : null;
    const ruled = verdict(tool, input, cwd, root, ruleForms, reaches, mode, shield);
    if (!LISTING_TOOLS.has(tool)) return { ruled, hidden: null, approved: null };
    const rules = (mode === 'yolo' ? deny : [...deny, ...ask]).filter((rule) => rule.kind === 'path' && rule.tools.includes(tool));
    const hidden = listingFilter(root, rules, ruleForms);
    if (ruled?.decision !== 'ask') return { ruled, hidden, approved: hidden };
    const kept = rules.filter((rule) => !ask.includes(rule) || !matchesPaths(rule, paths, ruleForms));
    return { ruled, hidden, approved: listingFilter(root, kept, ruleForms) };
  }

  return {
    active: deny.length > 0 || ask.length > 0 || allow.length > 0,
    removes: (tool) => removedBy(deny, tool),
    check: async (tool, input, cwd) => (await screen(tool, input, cwd)).ruled,
    screen,
  };
}
