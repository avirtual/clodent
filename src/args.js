import { EFFORTS } from './api/request.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const PERMISSION_MODE_NAMES = Object.freeze({ default: 'ask', plan: 'read-only', acceptEdits: 'accept-edits', bypassPermissions: 'yolo' });

const MODEL_SUFFIX = /^(.+)\[[^[\]]*\]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS = ['text', 'stream-json'];
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export const FLAGS = [
  { long: 'print', short: 'p', key: 'print', arg: 'prompt', allowEmpty: true, bare: '', help: 'run one prompt without the REPL, print the reply and exit' },
  { long: 'input-format', key: 'inputFormat', arg: 'format', check: checkFormat('--input-format'), help: 'with -p: text (the -p prompt) or stream-json (JSON lines on stdin)' },
  { long: 'output-format', key: 'outputFormat', arg: 'format', check: checkFormat('--output-format'), help: 'with -p: text (the final answer) or stream-json (JSON lines on stdout)' },
  { long: 'verbose', key: 'verbose', value: true, help: 'accepted; no effect' },
  { long: 'permission-prompt-tool', key: 'permissionPromptTool', arg: 'name', check: checkPromptTool, help: 'stdio: ask permission over stdin and stdout (needs --input-format stream-json)' },
  { long: 'model', key: 'model', arg: 'id', check: checkModel, help: `model id (default ${DEFAULT_MODEL}); a trailing [suffix] such as [1m] is dropped` },
  { long: 'effort', key: 'effort', arg: 'level', check: checkEffort, help: 'reasoning effort: low, medium, high, xhigh or max' },
  { long: 'budget', key: 'budgetUsd', arg: 'usd', check: checkBudget, help: 'stop before the session spends more than this many US dollars' },
  { long: 'yolo', key: 'yolo', value: true, mode: 'yolo', help: 'run every tool without asking' },
  { long: 'read-only', key: 'readOnly', value: true, mode: 'read-only', help: 'refuse write tools and any Bash command that is not read-only' },
  { long: 'dangerously-skip-permissions', key: 'skipPermissions', value: true, mode: 'yolo', help: 'same as --yolo' },
  { long: 'permission-mode', key: 'permissionMode', arg: 'mode', check: checkPermissionMode, help: 'default (ask), plan (--read-only), acceptEdits (run edits without asking) or bypassPermissions (--yolo)' },
  { long: 'disallowedTools', alias: 'disallowed-tools', key: 'disallowedTools', arg: 'list', repeat: true, help: 'deny these tools or permission rules, separated by commas or spaces (repeatable)' },
  { long: 'session-id', key: 'sessionId', arg: 'uuid', check: checkUuid, help: 'use this session id instead of minting one' },
  { long: 'resume', key: 'resume', arg: 'id', check: checkResume, help: 'resume the session with this id' },
  { long: 'fork-session', key: 'forkSession', value: true, help: 'with --resume, continue under a new session id' },
  { long: 'settings', key: 'settings', arg: 'file', repeat: true, help: 'merge settings from this JSON file (repeatable)' },
  { long: 'add-dir', key: 'addDirs', arg: 'path', repeat: true, help: 'give the agent an additional directory (repeatable)' },
  { long: 'system-prompt', key: 'systemPrompt', arg: 'text', allowEmpty: true, help: 'replace the base system prompt with this text' },
  { long: 'system-prompt-file', key: 'systemPromptFile', arg: 'path', help: 'replace the base system prompt with this file' },
  { long: 'append-system-prompt', key: 'appendSystemPrompt', arg: 'text', allowEmpty: true, repeat: true, help: 'append this text to the system prompt (repeatable)' },
  { long: 'append-system-prompt-file', key: 'appendSystemPromptFile', arg: 'path', repeat: true, help: "append this file's contents to the system prompt (repeatable)" },
  { long: 'allowedTools', alias: 'allowed-tools', key: 'allowedTools', arg: 'list', repeat: true, ignored: true, help: 'accepted and ignored' },
  { long: 'plugin-dir', key: 'pluginDir', arg: 'dir', repeat: true, ignored: true, help: 'accepted and ignored' },
  { long: 'agents', key: 'agents', arg: 'json', ignored: true, help: 'accepted and ignored' },
  { long: 'mcp-config', key: 'mcpConfig', arg: 'path', repeat: true, ignored: true, help: 'accepted and ignored' },
  { long: 'strict-mcp-config', key: 'strictMcpConfig', value: true, ignored: true, help: 'accepted and ignored' },
  { long: 'dangerously-bypass-hook-trust', key: 'bypassHookTrust', value: true, ignored: true, help: 'accepted and ignored' },
  { long: 'version', short: 'v', key: 'version', value: true, help: 'print the version and exit' },
  { long: 'help', short: 'h', key: 'help', value: true, help: 'print this help and exit' },
];

const BY_LONG = new Map(FLAGS.flatMap((flag) => [flag.long, ...(flag.alias ? [flag.alias] : [])].map((name) => [`--${name}`, flag])));
const BY_SHORT = new Map(FLAGS.filter((flag) => flag.short).map((flag) => [`-${flag.short}`, flag]));
const PERMISSION_FLAGS = FLAGS.filter((flag) => flag.mode !== undefined || flag.key === 'permissionMode');

export function stripModelSuffix(id) {
  return id.match(MODEL_SUFFIX)?.[1] ?? id;
}

function checkModel(raw) {
  return { value: stripModelSuffix(raw) };
}

function checkPermissionMode(raw) {
  if (Object.hasOwn(PERMISSION_MODE_NAMES, raw)) return { value: PERMISSION_MODE_NAMES[raw] };
  return { error: `--permission-mode must be default, plan, acceptEdits or bypassPermissions, got "${raw}"` };
}

function checkFormat(name) {
  return (raw) => (FORMATS.includes(raw) ? { value: raw } : { error: `${name} must be text or stream-json, got "${raw}"` });
}

function checkPromptTool(raw) {
  if (raw === 'stdio') return { value: raw };
  return { error: `--permission-prompt-tool must be stdio, got "${raw}"` };
}

function checkEffort(raw) {
  if (EFFORTS.includes(raw)) return { value: raw };
  return { error: `--effort must be low, medium, high, xhigh or max, got "${raw}"` };
}

function checkBudget(raw) {
  const value = Number(raw);
  if (DECIMAL.test(raw) && Number.isFinite(value) && value > 0) return { value };
  return { error: `--budget must be a number greater than 0, got "${raw}"` };
}

function checkUuid(raw) {
  if (UUID.test(raw)) return { value: raw.toLowerCase() };
  return { error: `--session-id must be a UUID (8-4-4-4-12 hex digits), got "${raw}"` };
}

function checkResume(raw) {
  return { value: UUID.test(raw) ? raw.toLowerCase() : raw };
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

function permissionOf(opts, seen) {
  const given = PERMISSION_FLAGS.filter((flag) => seen.has(flag.long)).map((flag) => ({ name: flag.long, mode: flag.mode ?? opts.permissionMode }));
  if (given.length === 0) return { mode: 'ask' };
  const other = given.find((flag) => flag.mode !== given[0].mode);
  if (other) return { error: `--${given[0].name} and --${other.name} cannot be combined` };
  return { mode: given[0].mode };
}

function formatError(opts, seen) {
  const streamIn = opts.inputFormat === 'stream-json';
  if ((streamIn || opts.outputFormat === 'stream-json') && !seen.has('print')) {
    return `${streamIn ? '--input-format' : '--output-format'} stream-json requires -p`;
  }
  if (streamIn && opts.outputFormat !== 'stream-json') return '--input-format stream-json requires --output-format stream-json';
  if (streamIn && opts.print !== '') return '--input-format stream-json reads prompts from stdin: give -p no prompt';
  if (seen.has('permission-prompt-tool') && !streamIn) return '--permission-prompt-tool requires --input-format stream-json';
  return null;
}

export function parseArgs(argv) {
  const opts = { permission: 'ask', settings: [], addDirs: [], appendSystemPrompt: [], appendSystemPromptFile: [], disallowedTools: [] };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-') || arg === '-') {
      return fail(`unexpected argument "${arg}": clodent takes no positional arguments (use -p <prompt>)`);
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
      if (next !== undefined && isFlag(next) && flag.bare !== undefined) raw = flag.bare;
      else if (next === undefined || isFlag(next)) return fail(`${name} needs a value`);
      else {
        raw = next;
        i++;
      }
    }
    if (raw === '' && !flag.allowEmpty) return fail(`${name} needs a value`);
    let value = raw;
    if (flag.check) {
      const checked = flag.check(raw);
      if (checked.error) return fail(checked.error);
      value = checked.value;
    }
    if (flag.ignored) opts[flag.key] = true;
    else if (flag.repeat) opts[flag.key].push(value);
    else opts[flag.key] = value;
  }
  const permission = permissionOf(opts, seen);
  if (permission.error) return fail(permission.error);
  opts.permission = permission.mode;
  if (seen.has('fork-session') && !seen.has('resume')) return fail('--fork-session requires --resume');
  if (seen.has('session-id') && seen.has('resume') && !seen.has('fork-session')) {
    return fail('--session-id with --resume requires --fork-session');
  }
  if (seen.has('system-prompt') && seen.has('system-prompt-file')) {
    return fail('--system-prompt and --system-prompt-file cannot be combined');
  }
  const formats = formatError(opts, seen);
  if (formats) return fail(formats);
  return { ok: true, opts };
}

export function givenFlags(opts) {
  return FLAGS.filter((flag) => {
    const value = opts[flag.key];
    if (flag.repeat && !flag.ignored) return value.length > 0;
    return value !== undefined;
  }).map((flag) => flag.long);
}
