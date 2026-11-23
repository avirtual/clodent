import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PASTE_OFF } from '../../src/repl/repl.js';
import { hookGroup, runMain, writeSettings } from '../helpers/run-main.js';
import { gatedPost, readFifoLine, slowPost } from '../helpers/slow-hooks.js';
import { script } from '../hooks/scripts.js';
import { useTempDir } from '../tools/tmp-dir.js';
import { startRepl } from './harness.js';

const GUARD = { timeout: 5000 };
const PROMPT_EXIT_MS = 1500;

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

test('REPL: a second Ctrl-C before the stopped call\'s PostToolUseFailure hook starts kills nothing: that hook and Stop run to completion', GUARD, async (t) => {
  const { home, cwd, settings, reply, running, terminated, release, postRan, stopRan } = await gatedPost(t);
  const repl = startRepl(['--yolo', '--settings', settings], { home, cwd, replies: [reply] });
  await repl.prompts(1);
  repl.stdin.type('go\r');
  assert.equal(await running, 'run');
  repl.stdin.type('\x03');
  assert.equal(await terminated, 'term');
  repl.stdin.type('\x03');
  await release();
  await repl.prompts(2);
  assert.match(repl.out.text, /^clodent: interrupted$/m);
  assert.doesNotMatch(repl.out.text, /aborted/);
  assert.deepEqual([existsSync(postRan), existsSync(stopRan)], [true, true]);
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
});

test('REPL: a second Ctrl-C kills the slow PostToolUseFailure hook of the call the first one stopped, Stop still runs, and the turn ends', GUARD, async (t) => {
  const { home, cwd, settings, reply, running, up, stopRan } = await slowPost(t);
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
  assert.match(repl.out.text, /^clodent: hook PostToolUseFailure "[^"]*post\.sh": aborted$/m);
  assert.doesNotMatch(repl.out.text, /hook Stop/);
  assert.equal(existsSync(stopRan), true);
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
