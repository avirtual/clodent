import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, createReadStream, openSync } from 'node:fs';
import { join } from 'node:path';
import { PASTE_OFF } from '../../src/repl/repl.js';
import { hookGroup, runMain, writeSettings } from '../helpers/run-main.js';
import { script } from '../hooks/scripts.js';
import { useTempDir } from '../tools/tmp-dir.js';
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
    assert.match(repl.out.text, /^clay: interrupted$/m);
    assert.match(repl.out.text, /^\[clay:cost\] session total /m);
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

test('-p: a second SIGTERM aborts a hung Stop hook, so clay exits promptly with 143', GUARD, async (t) => {
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

test('REPL: a second SIGTERM aborts a hung Stop hook, so clay exits promptly with 143', GUARD, async (t) => {
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
