import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PASTE_END, PASTE_START } from '../../src/repl/keys.js';
import { ASK_LINE, EXIT_HINT, PASTE_ON, QUEUED_NOTE } from '../../src/repl/repl.js';
import { hookGroup, textReply, toolsReply, writeSettings } from '../helpers/run-main.js';
import { useTempDir } from '../tools/tmp-dir.js';
import { startRepl } from './harness.js';

const GUARD = { timeout: 5000 };
const WAIT_THEN_FAIL = 'while [ ! -e go ]; do sleep 0.01; done; exit 1';
const ERASE_1 = '\r\x1b[2K';
const ERASE_2 = '\r\x1b[2K\x1b[A\x1b[2K';
const ERASE_3 = '\r\x1b[2K\x1b[A\x1b[2K\x1b[A\x1b[2K';
const yellow = (text) => `\x1b[33m${text}\x1b[0m`;

async function dirs(t) {
  return { home: await useTempDir(t), cwd: await useTempDir(t), dir: await useTempDir(t) };
}

function since(repl, start) {
  return repl.out.text.slice(start);
}

test('on a TTY, backspace, ^W, ^C and ^U on a draft wider than the terminal erase every row it wraps onto', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl([], { home, cwd, columns: 20 });
  await repl.prompts(1);
  const start = repl.out.text.length;
  const x25 = 'x'.repeat(25);
  repl.stdin.type(`${x25} tail`);
  repl.stdin.type('\x7f');
  repl.stdin.type('\x17');
  repl.stdin.type('y'.repeat(15));
  repl.stdin.type('\x03');
  repl.stdin.type('z'.repeat(25));
  repl.stdin.type('\x15');
  assert.equal(
    since(repl, start),
    `${x25} tail${ERASE_2}> ${x25} tai${ERASE_2}> ${x25} ${'y'.repeat(15)}${ERASE_3}> ${'z'.repeat(25)}${ERASE_2}> `,
  );
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
});

test('on a TTY, a resize redraws the prompt line over the rows it uses at both the old and the new width', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl([], { home, cwd, columns: 20 });
  await repl.prompts(1);
  const x30 = 'x'.repeat(30);
  repl.stdin.type(x30);
  const start = repl.out.text.length;
  repl.out.resize(40);
  repl.out.resize(10);
  repl.out.resize(16);
  assert.equal(since(repl, start), `${ERASE_1}> ${x30}${ERASE_1}> ${x30}${ERASE_2}> ${x30}`);
  repl.stdin.type('\x15\x04');
  assert.equal(await repl.done, 0);
  assert.equal(repl.out.listenerCount('resize'), 0);
});

test('on a TTY whose columns is 0, rows are counted at 80 columns', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl([], { home, cwd, columns: 0 });
  await repl.prompts(1);
  const start = repl.out.text.length;
  const x81 = 'x'.repeat(81);
  repl.stdin.type(x81);
  repl.stdin.type('\x7f');
  assert.equal(since(repl, start), `${x81}${ERASE_2}> ${'x'.repeat(80)}`);
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
});

test('on a TTY, the first exit ^C replaces the empty prompt row with the hint', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl([], { home, cwd, columns: 80 });
  await repl.prompts(1);
  const start = repl.out.text.length;
  repl.stdin.type('\x03');
  assert.equal(since(repl, start), `${ERASE_1}${EXIT_HINT}\n${PASTE_ON}> `);
  repl.stdin.type('\x03');
  assert.equal(await repl.done, 0);
});

test('on a TTY, a statusLine warning at the idle prompt lifts the draft, prints above it, then redraws it', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const settings = writeSettings(dir, { statusLine: { type: 'command', command: WAIT_THEN_FAIL } });
  const repl = startRepl(['--settings', settings], { home, cwd, replies: [textReply('hello')], columns: 80 });
  await repl.prompts(1);
  repl.stdin.type('hi\r');
  await repl.prompts(2);
  const start = repl.out.text.length;
  repl.stdin.type('draft');
  writeFileSync(join(cwd, 'go'), '');
  const warning = `clodent: statusLine "${WAIT_THEN_FAIL}": exit 1`;
  await repl.until(warning);
  assert.equal(since(repl, start), `draft${ERASE_1}${yellow(warning)}\n> draft`);
  repl.stdin.type('\x15\x04');
  assert.equal(await repl.done, 0);
});

test('on a TTY, a hook warning during the ask redraws the ask with its partial answer, and a queued paste leaves one ask line', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const settings = writeSettings(dir, { hooks: { Notification: [hookGroup('', WAIT_THEN_FAIL)] } });
  const replies = [toolsReply([['Write', { file_path: 'a.txt', content: 'a' }]]), textReply('done'), textReply('queued done')];
  const repl = startRepl(['--settings', settings], { home, cwd, replies, columns: 20 });
  await repl.prompts(1);
  repl.stdin.type('write a\r');
  await repl.until(ASK_LINE);
  const start = repl.out.text.length;
  repl.stdin.type('y');
  writeFileSync(join(cwd, 'go'), '');
  const warning = `clodent: hook Notification "${WAIT_THEN_FAIL}": exit 1`;
  await repl.until(warning);
  repl.stdin.type(`${PASTE_START}pasted\rprompt${PASTE_END}\r`);
  assert.equal(
    since(repl, start),
    `y${ERASE_1}${yellow(warning)}\n${ASK_LINE}y[pasted text, 2 lines]${ERASE_2}${QUEUED_NOTE}\n${ASK_LINE}`,
  );
  repl.stdin.type('y\r');
  await repl.prompts(3);
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
});
