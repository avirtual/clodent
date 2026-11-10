import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLAGS, givenFlags, modelChoice, parseArgs } from '../src/args.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

function ok(argv) {
  const res = parseArgs(argv);
  assert.equal(res.ok, true, res.error);
  return res.opts;
}

function err(argv) {
  const res = parseArgs(argv);
  assert.equal(res.ok, false, `expected ${JSON.stringify(argv)} to fail`);
  assert.equal(res.opts, undefined);
  return res.error;
}

test('no arguments yields the defaults', () => {
  assert.deepEqual(ok([]), {
    permission: 'ask',
    settings: [],
    addDirs: [],
    appendSystemPrompt: [],
    appendSystemPromptFile: [],
    disallowedTools: [],
    allowedTools: [],
  });
});

const VALUE_FLAGS = [
  ['--print', 'print', 'fix the bug', 'fix the bug'],
  ['-p', 'print', 'fix the bug', 'fix the bug'],
  ['--model', 'model', 'claude-sonnet-5', 'claude-sonnet-5'],
  ['--effort', 'effort', 'low', 'low'],
  ['--effort', 'effort', 'medium', 'medium'],
  ['--effort', 'effort', 'high', 'high'],
  ['--effort', 'effort', 'xhigh', 'xhigh'],
  ['--effort', 'effort', 'max', 'max'],
  ['--model', 'model', 'claude-haiku-5-5[1m]', 'claude-haiku-5-5[1m]'],
  ['--cache-ttl', 'cacheTtl', '5m', '5m'],
  ['--cache-ttl', 'cacheTtl', '1h', '1h'],
  ['--message-cache-ttl', 'messageCacheTtl', '5m', '5m'],
  ['--message-cache-ttl', 'messageCacheTtl', '1h', '1h'],
  ['--budget', 'budgetUsd', '2.5', 2.5],
  ['--budget', 'budgetUsd', '0.01', 0.01],
  ['--budget', 'budgetUsd', '3', 3],
  ['--session-id', 'sessionId', UUID, UUID],
  ['--session-id', 'sessionId', UUID.toUpperCase(), UUID],
  ['--resume', 'resume', 'abc', 'abc'],
  ['--system-prompt', 'systemPrompt', 'be terse', 'be terse'],
  ['--system-prompt-file', 'systemPromptFile', 'sys.md', 'sys.md'],
];

for (const [flag, key, raw, expected] of VALUE_FLAGS) {
  test(`${flag} ${raw} sets ${key} in both forms`, () => {
    assert.deepEqual(ok([flag, raw])[key], expected);
    assert.deepEqual(ok([`${flag}=${raw}`])[key], expected);
  });
}

const REPEATABLE = [
  ['--settings', 'settings'],
  ['--add-dir', 'addDirs'],
  ['--append-system-prompt', 'appendSystemPrompt'],
  ['--append-system-prompt-file', 'appendSystemPromptFile'],
  ['--disallowedTools', 'disallowedTools'],
  ['--disallowed-tools', 'disallowedTools'],
  ['--allowedTools', 'allowedTools'],
  ['--allowed-tools', 'allowedTools'],
];

for (const [flag, key] of REPEATABLE) {
  test(`${flag} collects every occurrence in order, mixing both forms`, () => {
    assert.deepEqual(ok([flag, 'one'])[key], ['one']);
    assert.deepEqual(ok([`${flag}=one`])[key], ['one']);
    assert.deepEqual(ok([flag, 'a', `${flag}=b`, flag, 'c'])[key], ['a', 'b', 'c']);
  });
}

test('modelChoice drops one trailing [suffix] from the id and gives 1000000 only for a dropped [1m]', () => {
  const rows = [
    ['claude-haiku-5-5[1m]', 'claude-haiku-5-5', 1000000],
    ['claude-sonnet-5-5[1M]', 'claude-sonnet-5-5', 1000000],
    ['claude-opus-5-5[1m][2m]', 'claude-opus-5-5[1m]', 200000],
    ['claude-opus-5-5[2m][1m]', 'claude-opus-5-5[2m]', 1000000],
    ['claude-opus-5-5[2m]', 'claude-opus-5-5', 200000],
    ['claude-opus-5-5', 'claude-opus-5-5', 200000],
    ['[1m]', '[1m]', 200000],
  ];
  for (const [raw, id, contextWindow] of rows) assert.deepEqual(modelChoice(raw), { id, contextWindow }, raw);
});

test('the = form keeps everything after the first = and allows an empty value', () => {
  assert.equal(ok(['--print=a=b']).print, 'a=b');
  assert.equal(ok(['--print=']).print, '');
  assert.equal(ok(['--print=--yolo']).print, '--yolo');
});

test('an empty value is a missing value, except for --print, --system-prompt and --append-system-prompt', () => {
  const allowed = ['print', 'system-prompt', 'append-system-prompt'];
  for (const flag of FLAGS.filter((f) => f.arg && !allowed.includes(f.long))) {
    assert.equal(err([`--${flag.long}`, '']), `--${flag.long} needs a value`);
    assert.equal(err([`--${flag.long}=`]), `--${flag.long} needs a value`);
  }
  assert.equal(err(['--add-dir', 'x', '--add-dir=']), '--add-dir needs a value');
  assert.equal(ok(['-p', '']).print, '');
  assert.equal(ok(['--system-prompt=']).systemPrompt, '');
  assert.deepEqual(ok(['--append-system-prompt', '']).appendSystemPrompt, ['']);
});

test('a separate value that is not a clodent flag is taken as is, even with a leading dash', () => {
  assert.equal(ok(['-p', '- list the files']).print, '- list the files');
  assert.equal(ok(['--print', '--not-a-flag']).print, '--not-a-flag');
});

test('boolean flags', () => {
  assert.equal(ok(['--yolo']).permission, 'yolo');
  assert.equal(ok(['--read-only']).permission, 'read-only');
  assert.equal(ok(['--resume', 'x', '--fork-session']).forkSession, true);
  assert.equal(ok(['--version']).version, true);
  assert.equal(ok(['-v']).version, true);
  assert.equal(ok(['--help']).help, true);
  assert.equal(ok(['-h']).help, true);
});

test('flags combine in any order', () => {
  const opts = ok(['--add-dir', '/a', '-p', 'go', '--yolo', '--add-dir=/b', '--effort=high', '--settings', 's.json']);
  assert.equal(opts.print, 'go');
  assert.equal(opts.permission, 'yolo');
  assert.equal(opts.effort, 'high');
  assert.deepEqual(opts.addDirs, ['/a', '/b']);
  assert.deepEqual(opts.settings, ['s.json']);
});

test('a value flag at the end of argv is a missing value', () => {
  for (const flag of FLAGS.filter((f) => f.arg)) {
    assert.match(err([`--${flag.long}`]), new RegExp(`^--${flag.long} needs a value$`));
  }
  assert.equal(err(['-p']), '--print needs a value');
});

test('a value flag followed by another clodent flag is a missing value', () => {
  assert.equal(err(['--model', '--yolo']), '--model needs a value');
  assert.equal(err(['--resume', '--fork-session']), '--resume needs a value');
  assert.equal(err(['--add-dir', '--settings=x']), '--add-dir needs a value');
});

test('a boolean flag given a value is an error', () => {
  assert.equal(err(['--yolo=1']), '--yolo takes no value');
  assert.equal(err(['--version=2']), '--version takes no value');
});

test('--effort rejects anything but low, medium, high, xhigh or max', () => {
  for (const raw of ['MAX', 'LOW', 'x-high', 'ultra']) {
    assert.equal(err(['--effort', raw]), `--effort must be low, medium, high, xhigh or max, got "${raw}"`);
  }
});

test('--dangerously-skip-permissions is --yolo, and --permission-mode maps the four Claude modes', () => {
  assert.equal(ok(['--dangerously-skip-permissions']).permission, 'yolo');
  const modes = { default: 'ask', plan: 'read-only', acceptEdits: 'accept-edits', bypassPermissions: 'yolo' };
  for (const [name, mode] of Object.entries(modes)) {
    assert.equal(ok(['--permission-mode', name]).permission, mode);
    assert.equal(ok([`--permission-mode=${name}`]).permission, mode);
  }
});

test('--permission-mode rejects any other value, naming the four', () => {
  for (const raw of ['ask', 'yolo', 'Default', 'dontAsk', 'accept-edits']) {
    assert.equal(err(['--permission-mode', raw]), `--permission-mode must be default, plan, acceptEdits or bypassPermissions, got "${raw}"`);
  }
});

test('permission flags that resolve to different modes cannot be combined; flags that agree can', () => {
  assert.equal(err(['--dangerously-skip-permissions', '--read-only']), '--read-only and --dangerously-skip-permissions cannot be combined');
  assert.equal(err(['--permission-mode', 'plan', '--yolo']), '--yolo and --permission-mode cannot be combined');
  assert.equal(err(['--permission-mode', 'acceptEdits', '--dangerously-skip-permissions']), '--dangerously-skip-permissions and --permission-mode cannot be combined');
  assert.equal(err(['--read-only', '--permission-mode', 'default']), '--read-only and --permission-mode cannot be combined');
  assert.equal(ok(['--yolo', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']).permission, 'yolo');
  assert.equal(ok(['--permission-mode', 'plan', '--read-only']).permission, 'read-only');
});

test('the accepted-and-ignored flags parse, take their value, and keep none of it', () => {
  const opts = ok([
    '--plugin-dir', 'a', '--plugin-dir=b', '--agents', '{"x":{}}', '--mcp-config', 'm.json', '--mcp-config', 'n.json',
    '--strict-mcp-config', '--dangerously-bypass-hook-trust', '-p', 'go',
  ]);
  assert.deepEqual(
    [opts.pluginDir, opts.agents, opts.mcpConfig, opts.strictMcpConfig, opts.bypassHookTrust, opts.print],
    [true, true, true, true, true, 'go'],
  );
  assert.equal(err(['--agents', 'a', '--agents', 'b']), '--agents given more than once');
  assert.equal(err(['--strict-mcp-config=1']), '--strict-mcp-config takes no value');
  assert.equal(err(['--plugin-dir', '--yolo']), '--plugin-dir needs a value');
});

test('--budget rejects anything but a finite number greater than 0', () => {
  for (const raw of ['0', '-1', '0.0', 'abc', 'Infinity', 'NaN', '1e999', '0x10', ' 5', '5usd']) {
    assert.equal(err([`--budget=${raw}`]), `--budget must be a number greater than 0, got "${raw}"`);
  }
});

test('--cache-ttl rejects anything but 5m or 1h, and is absent unless given', () => {
  for (const raw of ['1H', '5M', '60m', '2h', '1d', ' 1h', '300']) {
    assert.equal(err([`--cache-ttl=${raw}`]), `--cache-ttl must be 5m or 1h, got "${raw}"`);
  }
  assert.equal(err(['--cache-ttl']), '--cache-ttl needs a value');
  assert.equal(err(['--cache-ttl', '1h', '--cache-ttl', '5m']), '--cache-ttl given more than once');
  assert.equal(Object.hasOwn(ok([]), 'cacheTtl'), false);
});

test('--message-cache-ttl rejects anything but 5m or 1h, and is absent unless given', () => {
  for (const raw of ['1H', '5M', '60m', '2h', '1d', ' 1h', '300']) {
    assert.equal(err([`--message-cache-ttl=${raw}`]), `--message-cache-ttl must be 5m or 1h, got "${raw}"`);
  }
  assert.equal(err(['--message-cache-ttl']), '--message-cache-ttl needs a value');
  assert.equal(err(['--message-cache-ttl', '1h', '--message-cache-ttl', '5m']), '--message-cache-ttl given more than once');
  assert.equal(Object.hasOwn(ok([]), 'messageCacheTtl'), false);
});

test('--session-id rejects anything not shaped like a UUID', () => {
  for (const raw of ['abc', `${UUID}0`, UUID.replaceAll('-', ''), `{${UUID}}`, UUID.replace('1', 'g')]) {
    assert.match(err(['--session-id', raw]), /^--session-id must be a UUID/);
  }
});

test('--yolo with --read-only is an error in either order', () => {
  assert.equal(err(['--yolo', '--read-only']), '--yolo and --read-only cannot be combined');
  assert.equal(err(['--read-only', '--yolo']), '--yolo and --read-only cannot be combined');
});

test('--fork-session without --resume is an error', () => {
  assert.equal(err(['--fork-session']), '--fork-session requires --resume');
});

test('--session-id with --resume needs --fork-session', () => {
  assert.equal(err(['--resume', 'x', '--session-id', UUID]), '--session-id with --resume requires --fork-session');
  assert.equal(err(['--session-id', UUID, '--resume', 'x']), '--session-id with --resume requires --fork-session');
  assert.deepEqual(ok(['--resume', 'x', '--session-id', UUID, '--fork-session']).sessionId, UUID);
});

test('the --read-only help says only Bash commands that are not read-only are refused', () => {
  assert.equal(FLAGS.find((f) => f.long === 'read-only').help, 'refuse write tools and any Bash command that is not read-only');
});

test('a UUID-shaped --resume is lowercased and any other id is kept as given', () => {
  assert.equal(ok(['--resume', UUID.toUpperCase()]).resume, UUID);
  assert.equal(ok(['--resume', 'Not-A-UUID']).resume, 'Not-A-UUID');
});

test('--system-prompt with --system-prompt-file is an error', () => {
  assert.equal(
    err(['--system-prompt-file', 'f', '--system-prompt', 't']),
    '--system-prompt and --system-prompt-file cannot be combined',
  );
});

test('a non-repeatable flag given twice is an error', () => {
  assert.equal(err(['--model', 'a', '--model=b']), '--model given more than once');
  assert.equal(err(['-p', 'a', '--print', 'b']), '--print given more than once');
  assert.equal(err(['--yolo', '--yolo']), '--yolo given more than once');
});

test('an unknown flag is an error', () => {
  assert.equal(err(['--frobnicate']), 'unknown option: --frobnicate');
  assert.equal(err(['--frobnicate=1']), 'unknown option: --frobnicate');
  assert.equal(err(['-x']), 'unknown option: -x');
  assert.equal(err(['--']), 'unknown option: --');
  assert.equal(err(['-pv']), 'unknown option: -pv');
});

test('a positional argument is an error', () => {
  for (const arg of ['hello', '-']) {
    assert.equal(
      err([arg]),
      `unexpected argument "${arg}": clodent takes no positional arguments (use -p <prompt>)`,
    );
  }
  assert.match(err(['--yolo', 'fix it']), /^unexpected argument "fix it"/);
});

test('givenFlags names every flag present, in table order', () => {
  assert.deepEqual(givenFlags(ok([])), []);
  assert.deepEqual(givenFlags(ok(['--read-only', '--add-dir', 'x', '-p', 'go'])), ['print', 'read-only', 'add-dir']);
  assert.deepEqual(givenFlags(ok(['--yolo'])), ['yolo']);
  assert.deepEqual(givenFlags(ok(['--system-prompt-file', 'sys.md'])), ['system-prompt-file']);
  assert.deepEqual(givenFlags(ok(['--dangerously-skip-permissions', '--strict-mcp-config'])), ['dangerously-skip-permissions', 'strict-mcp-config']);
  const every = FLAGS.filter((f) => f.long !== 'read-only' && f.long !== 'system-prompt-file');
  const argv = every.flatMap((f) => {
    if (!f.arg) return [`--${f.long}`];
    if (f.long === 'effort') return ['--effort', 'low'];
    if (f.long === 'permission-mode') return ['--permission-mode', 'bypassPermissions'];
    if (f.long === 'budget') return ['--budget', '1'];
    if (f.long === 'cache-ttl' || f.long === 'message-cache-ttl') return [`--${f.long}`, '1h'];
    if (f.long === 'session-id') return ['--session-id', UUID];
    if (f.long === 'print') return ['-p'];
    if (f.long === 'input-format' || f.long === 'output-format') return [`--${f.long}`, 'stream-json'];
    if (f.long === 'permission-prompt-tool') return ['--permission-prompt-tool', 'stdio'];
    return [`--${f.long}`, 'x'];
  });
  assert.deepEqual(givenFlags(ok(argv)), every.map((f) => f.long));
});

const STREAM = ['--input-format', 'stream-json', '--output-format', 'stream-json'];

test('-p followed by another clodent flag is a bare flag with an empty prompt; -p at the end still needs a value', () => {
  const opts = ok(['-p', ...STREAM, '--verbose', '--session-id', UUID, '--permission-prompt-tool', 'stdio']);
  assert.deepEqual([opts.print, opts.inputFormat, opts.outputFormat, opts.verbose, opts.permissionPromptTool], ['', 'stream-json', 'stream-json', true, 'stdio']);
  assert.equal(ok(['-p', '', ...STREAM]).print, '');
  assert.equal(ok(['-p=', ...STREAM]).print, '');
  assert.deepEqual([ok(['-p', '-v']).print, ok(['-p', '-v']).version], ['', true]);
  assert.equal(ok(['-p', '--fix-it']).print, '--fix-it');
  assert.equal(err(['--model', 'x', '-p']), '--print needs a value');
});

test('--input-format and --output-format take text or stream-json, naming both', () => {
  assert.equal(ok(['-p', 'x', '--input-format', 'text', '--output-format', 'text']).outputFormat, 'text');
  assert.equal(ok(['-p', 'x', '--output-format', 'stream-json']).outputFormat, 'stream-json');
  assert.equal(err(['-p', 'x', '--input-format', 'json']), '--input-format must be text or stream-json, got "json"');
  assert.equal(err(['-p', 'x', '--output-format=jsonl']), '--output-format must be text or stream-json, got "jsonl"');
});

test('stream-json needs -p, stream input needs stream output and no prompt, and --permission-prompt-tool needs stream input', () => {
  assert.equal(err(STREAM), '--input-format stream-json requires -p');
  assert.equal(err(['--output-format', 'stream-json']), '--output-format stream-json requires -p');
  assert.equal(err(['-p', '--input-format', 'stream-json']), '--input-format stream-json requires --output-format stream-json');
  assert.equal(err(['-p', '--input-format', 'stream-json', '--output-format', 'text']), '--input-format stream-json requires --output-format stream-json');
  assert.equal(err(['-p', 'hi', ...STREAM]), '--input-format stream-json reads prompts from stdin: give -p no prompt');
  assert.equal(err(['-p', 'hi', '--permission-prompt-tool', 'stdio']), '--permission-prompt-tool requires --input-format stream-json');
  assert.equal(err(['-p', ...STREAM, '--permission-prompt-tool', 'mcp__x']), '--permission-prompt-tool must be stdio, got "mcp__x"');
  assert.equal(err(['--verbose=1']), '--verbose takes no value');
});
