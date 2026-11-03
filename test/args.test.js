import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLAGS, givenFlags, parseArgs } from '../src/args.js';

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
  });
});

const VALUE_FLAGS = [
  ['--print', 'print', 'fix the bug', 'fix the bug'],
  ['-p', 'print', 'fix the bug', 'fix the bug'],
  ['--model', 'model', 'claude-sonnet-5', 'claude-sonnet-5'],
  ['--effort', 'effort', 'low', 'low'],
  ['--effort', 'effort', 'medium', 'medium'],
  ['--effort', 'effort', 'high', 'high'],
  ['--budget', 'budgetUsd', '2.5', 2.5],
  ['--budget', 'budgetUsd', '0.01', 0.01],
  ['--budget', 'budgetUsd', '3', 3],
  ['--session-id', 'sessionId', UUID, UUID],
  ['--session-id', 'sessionId', UUID.toUpperCase(), UUID.toUpperCase()],
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
];

for (const [flag, key] of REPEATABLE) {
  test(`${flag} collects every occurrence in order, mixing both forms`, () => {
    assert.deepEqual(ok([flag, 'one'])[key], ['one']);
    assert.deepEqual(ok([`${flag}=one`])[key], ['one']);
    assert.deepEqual(ok([flag, 'a', `${flag}=b`, flag, 'c'])[key], ['a', 'b', 'c']);
  });
}

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

test('a separate value that is not a clay flag is taken as is, even with a leading dash', () => {
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

test('a value flag followed by another clay flag is a missing value', () => {
  assert.equal(err(['--model', '--yolo']), '--model needs a value');
  assert.equal(err(['--resume', '--fork-session']), '--resume needs a value');
  assert.equal(err(['-p', '-v']), '--print needs a value');
  assert.equal(err(['--add-dir', '--settings=x']), '--add-dir needs a value');
});

test('a boolean flag given a value is an error', () => {
  assert.equal(err(['--yolo=1']), '--yolo takes no value');
  assert.equal(err(['--version=2']), '--version takes no value');
});

test('--effort rejects anything but low, medium or high', () => {
  for (const raw of ['max', 'LOW', '', 'xhigh']) {
    assert.equal(err(['--effort', raw]), `--effort must be low, medium or high, got "${raw}"`);
  }
});

test('--budget rejects anything but a finite number greater than 0', () => {
  for (const raw of ['0', '-1', '0.0', 'abc', '', 'Infinity', 'NaN', '1e999', '0x10', ' 5', '5usd']) {
    assert.equal(err([`--budget=${raw}`]), `--budget must be a number greater than 0, got "${raw}"`);
  }
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
      `unexpected argument "${arg}": clay takes no positional arguments (use -p <prompt>)`,
    );
  }
  assert.match(err(['--yolo', 'fix it']), /^unexpected argument "fix it"/);
});

test('givenFlags names every flag present, in table order', () => {
  assert.deepEqual(givenFlags(ok([])), []);
  assert.deepEqual(givenFlags(ok(['--read-only', '--add-dir', 'x', '-p', 'go'])), ['print', 'read-only', 'add-dir']);
  assert.deepEqual(givenFlags(ok(['--yolo'])), ['yolo']);
  assert.deepEqual(givenFlags(ok(['--system-prompt-file', 'sys.md'])), ['system-prompt-file']);
  const every = FLAGS.filter((f) => f.long !== 'read-only' && f.long !== 'system-prompt-file');
  const argv = every.flatMap((f) => {
    if (!f.arg) return [`--${f.long}`];
    if (f.long === 'effort') return ['--effort', 'low'];
    if (f.long === 'budget') return ['--budget', '1'];
    if (f.long === 'session-id') return ['--session-id', UUID];
    return [`--${f.long}`, 'x'];
  });
  assert.deepEqual(givenFlags(ok(argv)), every.map((f) => f.long));
});
