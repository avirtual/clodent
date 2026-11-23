import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, createReadStream, openSync } from 'node:fs';
import { join } from 'node:path';
import { PASTE_OFF } from '../../src/repl/repl.js';
import { hookGroup, runMain, toolsReply, textReply, writeSettings } from '../helpers/run-main.js';
import { script } from '../hooks/scripts.js';
import { useTempDir } from '../tools/tmp-dir.js';
import { parseRecords, startStream, STREAM_ARGV, userLine, UUID } from '../stream/harness.js';
import { startRepl } from './harness.js';

const GUARD = { timeout: 5000 };
const PROMPT_EXIT_MS = 1500;

function readFifoLine(path, t) {
  const stream = createReadStream(path, 'utf8');
  t.after(() => {
    try {
      closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {}
    stream.destroy();
  });
  return new Promise((resolve, reject) => {
    let text = '';
    stream.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) resolve(text.trim());
    });
    stream.on('error', reject);
  });
}

async function hungStop(t) {
  const home = await useTempDir(t);
  const cwd = await useTempDir(t);
  const dir = await useTempDir(t);
  const fifo = join(dir, 'stop.fifo');
  execFileSync('mkfifo', [fifo]);
  const stop = await script(dir, 'stop.sh', `cat > /dev/null\necho up > ${JSON.stringify(fifo)}\nexec sleep 30`);
  const settings = writeSettings(dir, { hooks: { Stop: [hookGroup('', stop)] } });
  return { home, cwd, settings, up: readFifoLine(fifo, t) };
}

test('SIGTERM and SIGHUP during a REPL turn abort it and exit 143 / 129 through the exit path, restoring raw mode', GUARD, async (t) => {
  const home = await useTempDir(t);
  const cwd = await useTempDir(t);
  for (const [name, code] of [['SIGTERM', 143], ['SIGHUP', 129]]) {
    const repl = startRepl([], { home, cwd });
    await repl.prompts(1);
    repl.stdin.type('go\r');
    await repl.fetch.called(1);
    repl.signals[name]();
    assert.equal(await repl.done, code, name);
    assert.match(repl.out.text, /^clodent: interrupted$/m);
    assert.match(repl.out.text, /^\[clodent:cost\] session total /m);
    assert.ok(repl.out.text.endsWith(PASTE_OFF));
    assert.deepEqual(repl.stdin.rawModes, [true, false]);
    assert.deepEqual(repl.signals, {});
  }
});

test('SIGTERM at an idle REPL prompt exits 143 at once', GUARD, async (t) => {
  const repl = startRepl([], { home: await useTempDir(t), cwd: await useTempDir(t) });
  await repl.prompts(1);
  repl.signals.SIGTERM();
  assert.equal(await repl.done, 143);
  assert.deepEqual(repl.stdin.rawModes, [true, false]);
});

test('-p: a second SIGTERM aborts a hung Stop hook, so clodent exits promptly with 143', GUARD, async (t) => {
  const { home, cwd, settings, up } = await hungStop(t);
  let signals;
  const running = runMain(['-p', 'go', '--settings', settings], {
    home,
    cwd,
    responses: [{ body: '' }],
    onFetch: (ctx) => {
      signals = ctx.signals;
      signals.SIGTERM();
    },
  });
  assert.equal(await up, 'up');
  const sent = performance.now();
  signals.SIGTERM();
  const res = await running;
  assert.equal(res.code, 143, res.stderr);
  assert.ok(performance.now() - sent < PROMPT_EXIT_MS, `took ${performance.now() - sent} ms`);
});

test('REPL: a second SIGTERM aborts a hung Stop hook, so clodent exits promptly with 143', GUARD, async (t) => {
  const { home, cwd, settings, up } = await hungStop(t);
  const repl = startRepl(['--settings', settings], { home, cwd });
  await repl.prompts(1);
  repl.stdin.type('go\r');
  await repl.fetch.called(1);
  repl.signals.SIGTERM();
  assert.equal(await up, 'up');
  const sent = performance.now();
  repl.signals.SIGTERM();
  assert.equal(await repl.done, 143);
  assert.ok(performance.now() - sent < PROMPT_EXIT_MS, `took ${performance.now() - sent} ms`);
  assert.deepEqual(repl.stdin.rawModes, [true, false]);
});

async function slowPost(t) {
  const home = await useTempDir(t);
  const cwd = await useTempDir(t);
  const dir = await useTempDir(t);
  const ran = join(dir, 'ran.fifo');
  const fifo = join(dir, 'post.fifo');
  execFileSync('mkfifo', [ran]);
  execFileSync('mkfifo', [fifo]);
  const post = await script(dir, 'post.sh', `cat > /dev/null\necho up > ${JSON.stringify(fifo)}\nexec sleep 30`);
  const settings = writeSettings(dir, { hooks: { PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command: post, timeout: 3 }] }] } });
  const command = `echo run > ${JSON.stringify(ran)}; exec sleep 30`;
  return { home, cwd, dir, settings, reply: toolsReply([['Bash', { command }]]), running: readFifoLine(ran, t), up: readFifoLine(fifo, t) };
}

const interrupt = (id) => ({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } });

test('REPL: a second Ctrl-C kills the slow PostToolUseFailure hook of the call the first one stopped, and the turn ends', GUARD, async (t) => {
  const { home, cwd, settings, reply, running, up } = await slowPost(t);
  const repl = startRepl(['--yolo', '--settings', settings], { home, cwd, replies: [reply] });
  await repl.prompts(1);
  repl.stdin.type('go\r');
  assert.equal(await running, 'run');
  repl.stdin.type('\x03');
  assert.equal(await up, 'up');
  const sent = performance.now();
  repl.stdin.type('\x03');
  await repl.prompts(2);
  assert.ok(performance.now() - sent < PROMPT_EXIT_MS, `took ${performance.now() - sent} ms`);
  assert.match(repl.out.text, /^clodent: interrupted$/m);
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
  assert.equal(repl.fetch.calls.length, 1);
});

test('REPL: a second Ctrl-C kills a hung Stop hook of an interrupted turn, and the next prompt shows', GUARD, async (t) => {
  const { home, cwd, settings, up } = await hungStop(t);
  const repl = startRepl(['--settings', settings], { home, cwd });
  await repl.prompts(1);
  repl.stdin.type('go\r');
  await repl.fetch.called(1);
  repl.stdin.type('\x03');
  assert.equal(await up, 'up');
  const sent = performance.now();
  repl.stdin.type('\x03');
  await repl.prompts(2);
  assert.ok(performance.now() - sent < PROMPT_EXIT_MS, `took ${performance.now() - sent} ms`);
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
});

test('stream-json: a second interrupt kills the slow PostToolUseFailure hook of the call the first one stopped, and the turn ends', GUARD, async (t) => {
  const { home, cwd, settings, reply, running, up } = await slowPost(t);
  const s = startStream([...STREAM_ARGV, '--yolo', '--session-id', UUID, '--settings', settings], { home, cwd, replies: [reply] });
  s.send(userLine('go'));
  assert.equal(await running, 'run');
  s.send(interrupt('i-1'));
  assert.equal(await up, 'up');
  const sent = performance.now();
  s.send(interrupt('i-2'));
  await s.until('result');
  assert.ok(performance.now() - sent < PROMPT_EXIT_MS, `took ${performance.now() - sent} ms`);
  s.close();
  assert.equal(await s.done, 0);
  const [result] = parseRecords(s.out.text).filter((record) => record.type === 'result');
  assert.deepEqual([result.is_error, result.stop_reason, result.num_turns], [false, null, 1]);
  assert.equal(s.fetch.calls.length, 1);
});

test('stream-json: an interrupt during the Stop hook of an interrupted turn kills it, and the waiting prompt runs uninterrupted', GUARD, async (t) => {
  const home = await useTempDir(t);
  const cwd = await useTempDir(t);
  const dir = await useTempDir(t);
  const fifo = join(dir, 'stop.fifo');
  execFileSync('mkfifo', [fifo]);
  const once = join(dir, 'stopped');
  const stop = await script(dir, 'stop.sh', `cat > /dev/null\n[ -e ${JSON.stringify(once)} ] && exit 0\ntouch ${JSON.stringify(once)}\necho up > ${JSON.stringify(fifo)}\nexec sleep 30`);
  const settings = writeSettings(dir, { hooks: { Stop: [hookGroup('', stop)] } });
  const up = readFifoLine(fifo, t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, '--settings', settings], { home, cwd, replies: [] });
  s.send(userLine('go'));
  await s.fetch.called(1);
  s.send(interrupt('i-1'));
  assert.equal(await up, 'up');
  s.send(userLine('next'));
  const sent = performance.now();
  s.send(interrupt('i-2'));
  s.fetch.push(textReply('next done'));
  await s.until('result', 2);
  assert.ok(performance.now() - sent < PROMPT_EXIT_MS, `took ${performance.now() - sent} ms`);
  s.close();
  assert.equal(await s.done, 0);
  const [first, second] = parseRecords(s.out.text).filter((record) => record.type === 'result');
  assert.deepEqual([first.stop_reason, first.result], [null, '']);
  assert.deepEqual([second.is_error, second.stop_reason, second.result], [false, 'end_turn', 'next done']);
  assert.equal(s.fetch.calls.length, 2);
});
