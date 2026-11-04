export const READ_ONLY_COMMANDS = Object.freeze([
  'cat', 'head', 'tail', 'wc', 'ls', 'pwd', 'echo', 'printf', 'true', 'false', 'grep', 'egrep', 'fgrep', 'rg', 'file',
  'stat', 'du', 'df', 'which', 'type', 'whoami', 'id', 'uname', 'date', 'basename', 'dirname', 'realpath', 'readlink',
  'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'comm', 'tree', 'jq', 'od', 'hexdump', 'xxd', 'strings', 'column', 'nl',
  'fold', 'paste', 'seq', 'test', '[', 'cd', 'sha256sum', 'sha1sum', 'shasum', 'md5', 'md5sum', 'cksum', 'find', 'sed',
  'git',
]);

const COMMANDS = new Set(READ_ONLY_COMMANDS);
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const UNKNOWN = '\u0000';
const BRACED_NAME = /^\{[A-Za-z_][A-Za-z0-9_]*\}/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const DIGITS = /^\d+$/;

const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
const SED_SHORT = new Set(['n', 'E', 'r', 's', 'u', 'z']);
const SED_LONG = new Set(['--regexp-extended', '--separate', '--null-data', '--unbuffered', '--debug', '--sandbox']);
const GIT_FREE = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'grep', 'describe', 'shortlog', 'cat-file', 'merge-base', 'rev-list']);
const GIT_FLAGS_ONLY = {
  branch: new Set(['-a', '-r', '-v', '-vv', '--list', '--show-current', '--contains', '--merged', '--no-merged']),
  tag: new Set(['-l', '--list']),
  remote: new Set(['-v']),
};
const GIT_CONFIG_READS = new Set(['--get', '--get-all', '--list', '-l']);

class Refusal {
  constructor(reason) {
    this.reason = reason;
  }
}

function refuse(reason) {
  throw new Refusal(reason);
}

function shortHas(arg, letters) {
  return /^-[^-]/.test(arg) && [...letters].some((letter) => arg.includes(letter, 1));
}

function longMatches(arg, name) {
  if (!arg.startsWith('--')) return false;
  const flag = arg.slice(2).split('=')[0];
  return flag.length > 0 && (name.startsWith(flag) || flag.startsWith(name));
}

function firstMatch(cmd, args, test) {
  const bad = args.find(test);
  return bad === undefined ? null : `${cmd} ${bad}`;
}

function operandCount(args) {
  let count = 0;
  let operands = false;
  for (const arg of args) {
    if (operands) count++;
    else if (arg === '--') operands = true;
    else if (!arg.startsWith('-') || arg === '-') {
      count++;
      operands = true;
    }
  }
  return count;
}

function oneOperand(cmd) {
  return (args) => (operandCount(args) > 1 ? `${cmd} with an output file` : null);
}

function noVariableTest(cmd) {
  return (args) => firstMatch(cmd, args, (arg) => arg === '-v' || arg === '-R');
}

function sedScriptOk(script) {
  let i = 0;
  const skip = () => {
    while (script[i] === ' ' || script[i] === '\t') i++;
  };
  const scan = (from, regex) => {
    for (let j = from; j < script.length; j++) {
      const c = script[j];
      if (c === '\n' || (regex && c === '[')) return -1;
      if (c === '/') return j;
      if (c === '\\') {
        j++;
        if (j >= script.length || script[j] === '\n') return -1;
      }
    }
    return -1;
  };
  const address = () => {
    if (script[i] === '$') {
      i++;
      return true;
    }
    if (/[0-9]/.test(script[i] ?? '')) {
      while (/[0-9]/.test(script[i] ?? '')) i++;
      return true;
    }
    if (script[i] !== '/') return false;
    const close = scan(i + 1, true);
    if (close < 0) return null;
    i = close + 1;
    return true;
  };
  skip();
  if (i >= script.length) return false;
  for (;;) {
    const first = address();
    if (first === null) return false;
    if (first && script[i] === ',') {
      i++;
      if (address() !== true) return false;
    }
    skip();
    const c = script[i];
    if (c === 'p' || c === 'd' || c === '=' || c === 'q') i++;
    else if (c === 's' && script[i + 1] === '/') {
      const middle = scan(i + 2, true);
      if (middle < 0) return false;
      const close = scan(middle + 1, false);
      if (close < 0) return false;
      i = close + 1;
      while (/[gpIi0-9]/.test(script[i] ?? '')) i++;
    } else return false;
    skip();
    if (i >= script.length) return true;
    if (script[i] !== ';') return false;
    i++;
    skip();
    if (i >= script.length) return true;
  }
}

function sedRule(args) {
  const scripts = [];
  const operands = [];
  let options = true;
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (!options || arg === '-' || !arg.startsWith('-')) {
      operands.push(arg);
      continue;
    }
    if (arg === '--') {
      options = false;
      continue;
    }
    if (operands.length > 0) return `sed ${arg} after an operand`;
    if (/i/i.test(arg)) return `sed ${arg}`;
    if (arg.startsWith('--')) {
      if (!SED_LONG.has(arg)) return `sed ${arg}`;
      continue;
    }
    for (let p = 1; p < arg.length; p++) {
      if (arg[p] === 'e') {
        const value = p + 1 < arg.length ? arg.slice(p + 1) : args[++k];
        if (value === undefined) return 'sed -e without a script';
        scripts.push(value);
        break;
      }
      if (!SED_SHORT.has(arg[p])) return `sed ${arg}`;
    }
  }
  if (scripts.length === 0) {
    if (operands.length === 0) return 'sed without a script';
    scripts.push(operands[0]);
  }
  const bad = scripts.find((script) => !sedScriptOk(script));
  return bad === undefined ? null : `sed script ${bad}`;
}

function gitRule(args) {
  let k = 0;
  while (k < args.length) {
    const arg = args[k];
    if (arg === '--no-pager' || arg.startsWith('--git-dir=')) k++;
    else if (arg === '-C' && k + 1 < args.length) k += 2;
    else if (arg.startsWith('-')) return `git ${arg}`;
    else break;
  }
  const sub = args[k];
  if (sub === undefined) return 'git without a subcommand';
  const rest = args.slice(k + 1);
  const unsafe = firstMatch(`git ${sub}`, rest, (arg) =>
    longMatches(arg, 'output') ||
    longMatches(arg, 'ext-diff') ||
    (sub === 'grep' && (shortHas(arg, 'O') || longMatches(arg, 'open-files-in-pager'))),
  );
  if (unsafe) return unsafe;
  if (GIT_FREE.has(sub)) return null;
  const flags = GIT_FLAGS_ONLY[sub];
  if (flags) return firstMatch(`git ${sub}`, rest, (arg) => !flags.has(arg));
  if (sub === 'config') {
    const other = firstMatch('git config', rest, (arg) => arg.startsWith('-') && !GIT_CONFIG_READS.has(arg));
    if (other) return other;
    return rest.some((arg) => GIT_CONFIG_READS.has(arg)) ? null : 'git config without --get or --list';
  }
  return `git ${sub} is not read-only`;
}

const RULES = {
  find: (args) => firstMatch('find', args, (arg) => FIND_ACTIONS.has(arg)),
  sort: (args) => firstMatch('sort', args, (arg) => shortHas(arg, 'o') || longMatches(arg, 'output') || longMatches(arg, 'compress-program')),
  tree: (args) => firstMatch('tree', args, (arg) => shortHas(arg, 'oR')),
  rg: (args) => firstMatch('rg', args, (arg) => ['--pre', '--hostname-bin'].some((name) => arg === name || arg.startsWith(`${name}=`))),
  date: (args) => firstMatch('date', args, (arg) => shortHas(arg, 's') || longMatches(arg, 'set') || /^\d+(\.\d+)?$/.test(arg)),
  file: (args) => firstMatch('file', args, (arg) => shortHas(arg, 'C') || longMatches(arg, 'compile')),
  printf: (args) => firstMatch('printf', args, (arg) => arg.startsWith('-v')),
  test: noVariableTest('test'),
  '[': noVariableTest('['),
  uniq: oneOperand('uniq'),
  xxd: oneOperand('xxd'),
  sed: sedRule,
  git: gitRule,
};

function lex(src) {
  const tokens = [];
  let i = 0;
  let word = null;
  const begin = () => {
    word ??= { start: i, value: '', dynamic: false, bracket: false, braces: 0 };
  };
  const end = () => {
    if (!word) return;
    tokens.push({ type: 'word', value: word.value, raw: src.slice(word.start, i), dynamic: word.dynamic });
    word = null;
  };
  const plain = (c) => {
    begin();
    word.value += c;
    if (c === '*' || c === '?') word.dynamic = true;
    else if (c === '[') word.bracket = true;
    else if (c === ']' && word.bracket) word.dynamic = true;
    else if (c === '{') word.braces++;
    else if (c === '}' && word.braces > 0) word.braces--;
    else if (word.braces > 0 && (c === ',' || (c === '.' && src[i - 1] === '.'))) word.dynamic = true;
  };
  const expansion = (next) => {
    word.dynamic = true;
    word.value += UNKNOWN;
    return next;
  };
  const dollar = (j, quoted) => {
    const next = src[j + 1];
    if (next === '(') refuse('command substitution');
    if (next === '[') refuse('arithmetic expansion');
    if (next === '{') {
      const match = BRACED_NAME.exec(src.slice(j + 1));
      if (!match) refuse('parameter expansion');
      return expansion(j + 1 + match[0].length);
    }
    if (!quoted && (next === "'" || next === '"')) refuse(`$${next} quoting`);
    if (/[A-Za-z_]/.test(next ?? '')) {
      let k = j + 2;
      while (/[A-Za-z0-9_]/.test(src[k] ?? '')) k++;
      return expansion(k);
    }
    if (/[0-9@*#?$!-]/.test(next ?? '')) return expansion(j + 2);
    word.value += '$';
    return j + 1;
  };
  const escape = (j) => {
    const next = src[j + 1];
    if (next === undefined) refuse('trailing backslash');
    if (next === '\n') return j + 2;
    if (next === '`') refuse('command substitution');
    begin();
    word.value += next;
    return j + 2;
  };
  const single = (j) => {
    const close = src.indexOf("'", j + 1);
    if (close === -1) refuse('unterminated quote');
    begin();
    word.value += src.slice(j + 1, close);
    return close + 1;
  };
  const double = (j) => {
    begin();
    let k = j + 1;
    for (;;) {
      const c = src[k];
      if (c === undefined) refuse('unterminated quote');
      if (c === '"') return k + 1;
      if (c === '`') refuse('command substitution');
      if (c === '$') {
        k = dollar(k, true);
        continue;
      }
      if (c === '\\') {
        const next = src[k + 1];
        if (next === '`') refuse('command substitution');
        if (next === '\n') {
          k += 2;
          continue;
        }
        if (next === '$' || next === '"' || next === '\\') {
          word.value += next;
          k += 2;
          continue;
        }
      }
      word.value += c;
      k++;
    }
  };
  const redirect = (j) => {
    if (word && /^\{.*\}$/s.test(src.slice(word.start, j))) refuse('variable redirection');
    if (word && DIGITS.test(src.slice(word.start, j))) word = null;
    else end();
    const next = src[j + 1];
    let op = src[j];
    if (op === '<') {
      if (next === '<') refuse('here-document');
      if (next === '(') refuse('process substitution');
      if (next === '>') refuse('output redirection');
      if (next === '&') refuse('input fd duplication');
    } else {
      if (next === '(') refuse('process substitution');
      if (next === '>' || next === '|' || next === '&') op += next;
    }
    tokens.push({ type: 'redir', op });
    return j + op.length;
  };
  const separator = (op) => {
    end();
    tokens.push({ type: 'sep', op });
    i += op.length;
  };
  try {
    if (CONTROL.test(src)) refuse('control character');
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\t') {
        end();
        i++;
      } else if (c === '\n') separator('\n');
      else if (c === '#' && !word) {
        while (i < src.length && src[i] !== '\n') i++;
      } else if (c === '\\') i = escape(i);
      else if (c === "'") i = single(i);
      else if (c === '"') i = double(i);
      else if (c === '`') refuse('command substitution');
      else if (c === '$') {
        begin();
        i = dollar(i, false);
      } else if (c === '(' || c === ')') refuse('subshell');
      else if (c === ';') separator(';');
      else if (c === '|') separator(src[i + 1] === '|' ? '||' : '|');
      else if (c === '&') {
        if (src[i + 1] === '&') separator('&&');
        else if (src[i + 1] === '>') {
          end();
          const op = src[i + 2] === '>' ? '&>>' : '&>';
          tokens.push({ type: 'redir', op });
          i += op.length;
        } else refuse('background job &');
      } else if (c === '<' || c === '>') i = redirect(i);
      else {
        plain(c);
        i++;
      }
    }
    end();
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    tokens.push({ type: 'error', reason: err.reason });
  }
  return tokens;
}

function checkRedirect(op, target) {
  if (op === '<') return;
  if (op === '>&' && DIGITS.test(target.raw)) return;
  if (!target.dynamic && target.value === '/dev/null') return;
  refuse('output redirection');
}

function checkSegment(items) {
  const words = [];
  for (let k = 0; k < items.length; k++) {
    const item = items[k];
    if (item.type === 'redir') {
      const target = items[k + 1];
      if (target?.type !== 'word') refuse('redirection without a target');
      checkRedirect(item.op, target);
      k++;
    } else if (item.raw === '{' || item.raw === '}') refuse('command group');
    else words.push(item);
  }
  if (words.length === 0) refuse('redirection without a command');
  const [head, ...args] = words;
  if (ASSIGNMENT.test(head.raw)) refuse('variable assignment');
  if (head.dynamic) refuse(`command name ${head.raw} is an expansion`);
  if (!COMMANDS.has(head.value)) refuse(`${head.value} is not a read-only command`);
  const rule = RULES[head.value];
  if (!rule) return;
  const loose = args.find((arg) => arg.dynamic);
  if (loose) refuse(`${head.value} argument ${loose.raw} is an expansion or glob`);
  const reason = rule(args.map((arg) => arg.value));
  if (reason) refuse(reason);
}

export function classifyBash(command) {
  if (typeof command !== 'string') return { readOnly: false, reason: 'command is not a string' };
  let segment = [];
  let pending = null;
  let commands = 0;
  try {
    for (const token of lex(command)) {
      if (token.type === 'error') refuse(token.reason);
      if (token.type !== 'sep') {
        segment.push(token);
        continue;
      }
      if (segment.length > 0) {
        checkSegment(segment);
        commands++;
        segment = [];
        pending = token.op === '\n' ? null : token.op;
      } else if (token.op !== '\n') refuse('empty command');
    }
    if (segment.length > 0) checkSegment(segment);
    else if (commands === 0 || pending === '|' || pending === '||' || pending === '&&') refuse('empty command');
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    return { readOnly: false, reason: err.reason };
  }
  return { readOnly: true };
}
