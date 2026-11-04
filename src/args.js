export const DEFAULT_MODEL = 'claude-opus-5-5';

const EFFORTS = ['low', 'medium', 'high'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export const FLAGS = [
  { long: 'print', short: 'p', key: 'print', arg: 'prompt', allowEmpty: true, help: 'run one prompt without the REPL, print the reply and exit' },
  { long: 'model', key: 'model', arg: 'id', help: `model id (default ${DEFAULT_MODEL})` },
  { long: 'effort', key: 'effort', arg: 'level', check: checkEffort, help: 'reasoning effort: low, medium or high' },
  { long: 'budget', key: 'budgetUsd', arg: 'usd', check: checkBudget, help: 'stop before the session spends more than this many US dollars' },
  { long: 'yolo', key: 'permission', value: 'yolo', help: 'run every tool without asking' },
  { long: 'read-only', key: 'permission', value: 'read-only', help: 'refuse write tools and every Bash command' },
  { long: 'session-id', key: 'sessionId', arg: 'uuid', check: checkUuid, help: 'use this session id instead of minting one' },
  { long: 'resume', key: 'resume', arg: 'id', help: 'resume the session with this id' },
  { long: 'fork-session', key: 'forkSession', value: true, help: 'with --resume, continue under a new session id' },
  { long: 'settings', key: 'settings', arg: 'file', repeat: true, help: 'merge settings from this JSON file (repeatable)' },
  { long: 'add-dir', key: 'addDirs', arg: 'path', repeat: true, help: 'give the agent an additional directory (repeatable)' },
  { long: 'system-prompt', key: 'systemPrompt', arg: 'text', allowEmpty: true, help: 'replace the base system prompt with this text' },
  { long: 'system-prompt-file', key: 'systemPromptFile', arg: 'path', help: 'replace the base system prompt with this file' },
  { long: 'append-system-prompt', key: 'appendSystemPrompt', arg: 'text', allowEmpty: true, repeat: true, help: 'append this text to the system prompt (repeatable)' },
  { long: 'append-system-prompt-file', key: 'appendSystemPromptFile', arg: 'path', repeat: true, help: "append this file's contents to the system prompt (repeatable)" },
  { long: 'version', short: 'v', key: 'version', value: true, help: 'print the version and exit' },
  { long: 'help', short: 'h', key: 'help', value: true, help: 'print this help and exit' },
];

const BY_LONG = new Map(FLAGS.map((flag) => [`--${flag.long}`, flag]));
const BY_SHORT = new Map(FLAGS.filter((flag) => flag.short).map((flag) => [`-${flag.short}`, flag]));

function checkEffort(raw) {
  if (EFFORTS.includes(raw)) return { value: raw };
  return { error: `--effort must be low, medium or high, got "${raw}"` };
}

function checkBudget(raw) {
  const value = Number(raw);
  if (DECIMAL.test(raw) && Number.isFinite(value) && value > 0) return { value };
  return { error: `--budget must be a number greater than 0, got "${raw}"` };
}

function checkUuid(raw) {
  if (UUID.test(raw)) return { value: raw };
  return { error: `--session-id must be a UUID (8-4-4-4-12 hex digits), got "${raw}"` };
}

function split(arg) {
  const eq = arg.indexOf('=');
  if (eq === -1) return { token: arg, inline: undefined };
  return { token: arg.slice(0, eq), inline: arg.slice(eq + 1) };
}

function lookup(token) {
  return token.startsWith('--') ? BY_LONG.get(token) : BY_SHORT.get(token);
}

function isFlag(arg) {
  return arg.startsWith('-') && lookup(split(arg).token) !== undefined;
}

function fail(error) {
  return { ok: false, error };
}

export function parseArgs(argv) {
  const opts = { permission: 'ask', settings: [], addDirs: [], appendSystemPrompt: [], appendSystemPromptFile: [] };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-') || arg === '-') {
      return fail(`unexpected argument "${arg}": clay takes no positional arguments (use -p <prompt>)`);
    }
    const { token, inline } = split(arg);
    const flag = lookup(token);
    if (!flag) return fail(`unknown option: ${token}`);
    const name = `--${flag.long}`;
    if (seen.has(flag.long) && !flag.repeat) return fail(`${name} given more than once`);
    seen.add(flag.long);
    if (!flag.arg) {
      if (inline !== undefined) return fail(`${name} takes no value`);
      opts[flag.key] = flag.value;
      continue;
    }
    let raw = inline;
    if (raw === undefined) {
      const next = argv[i + 1];
      if (next === undefined || isFlag(next)) return fail(`${name} needs a value`);
      raw = next;
      i++;
    }
    if (raw === '' && !flag.allowEmpty) return fail(`${name} needs a value`);
    let value = raw;
    if (flag.check) {
      const checked = flag.check(raw);
      if (checked.error) return fail(checked.error);
      value = checked.value;
    }
    if (flag.repeat) opts[flag.key].push(value);
    else opts[flag.key] = value;
  }
  if (seen.has('yolo') && seen.has('read-only')) return fail('--yolo and --read-only cannot be combined');
  if (seen.has('fork-session') && !seen.has('resume')) return fail('--fork-session requires --resume');
  if (seen.has('session-id') && seen.has('resume') && !seen.has('fork-session')) {
    return fail('--session-id with --resume requires --fork-session');
  }
  if (seen.has('system-prompt') && seen.has('system-prompt-file')) {
    return fail('--system-prompt and --system-prompt-file cannot be combined');
  }
  return { ok: true, opts };
}

export function givenFlags(opts) {
  return FLAGS.filter((flag) => {
    const value = opts[flag.key];
    if (flag.repeat) return value.length > 0;
    if (flag.key === 'permission') return value === flag.value;
    return value !== undefined;
  }).map((flag) => flag.long);
}
