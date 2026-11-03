import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createBash, clampTimeout } from '../../src/tools/bash.js';
import { capResult } from '../../src/tools/cap.js';
import { cleanEnv, ctxFor, useTempDir } from './tmp-dir.js';

const bash = createBash();
const GUARD = { timeout: 10000 };

function isGone(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === 'ESRCH';
  }
  const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  return state === '' || state.startsWith('Z');
}

test('stdout comes back with an [exit 0] trailer', GUARD, async (t) => {
  const dir = await useTempDir(t);
  assert.deepEqual(await bash.run({ command: 'echo hello' }, ctxFor(dir)), { content: 'hello\n[exit 0]', isError: false });
});

test('a non-zero exit is an error and the trailer starts on its own line', GUARD, async (t) => {
  const dir = await useTempDir(t);
  assert.deepEqual(await bash.run({ command: 'printf abc; exit 3' }, ctxFor(dir)), { content: 'abc\n[exit 3]', isError: true });
});

test('no output is just the trailer', GUARD, async (t) => {
  const dir = await useTempDir(t);
  assert.deepEqual(await bash.run({ command: 'true' }, ctxFor(dir)), { content: '[exit 0]', isError: false });
});

test('stdout and stderr interleave in arrival order', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const command = 'echo out1; sleep 0.2; echo err1 >&2; sleep 0.2; echo out2';
  assert.equal((await bash.run({ command }, ctxFor(dir))).content, 'out1\nerr1\nout2\n[exit 0]');
});

test('cwd and env come from ctx', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const ctx = { cwd: dir, env: cleanEnv({ CLAY_PROBE: 'probe-value' }) };
  assert.equal((await bash.run({ command: 'pwd; echo "$CLAY_PROBE"' }, ctx)).content, `${dir}\nprobe-value\n[exit 0]`);
});

test('stdin is closed', GUARD, async (t) => {
  const dir = await useTempDir(t);
  assert.equal((await bash.run({ command: 'cat; echo done' }, ctxFor(dir))).content, 'done\n[exit 0]');
});

test('a 300 ms timeout on sleep 5 returns within 3 s', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const started = Date.now();
  const result = await bash.run({ command: 'echo before; sleep 5', timeout: 300 }, ctxFor(dir));
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(result, { content: 'before\n[timed out after 300 ms]', isError: true });
});

test('the process-group kill reaps a backgrounded grandchild', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const result = await bash.run({ command: 'sleep 30 & echo $!; wait', timeout: 300 }, ctxFor(dir));
  const pid = Number(result.content.split('\n')[0]);
  assert.ok(pid > 0, result.content);
  assert.match(result.content, /\[timed out after 300 ms\]$/);
  assert.ok(isGone(pid), `grandchild ${pid} still running`);
});

test('SIGKILL follows SIGTERM after the grace period', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const stubborn = createBash({ killGraceMs: 50 });
  const started = Date.now();
  const result = await stubborn.run({ command: "trap '' TERM; sleep 30", timeout: 300 }, ctxFor(dir));
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.content, '[timed out after 300 ms]');
});

test('aborting through an AbortController kills the command', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const controller = new AbortController();
  const started = Date.now();
  const pending = bash.run({ command: 'sleep 30' }, ctxFor(dir, { signal: controller.signal }));
  controller.abort();
  const result = await pending;
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(result, { content: '[killed by SIGTERM]', isError: true });
});

test('an already-aborted signal does not run the command', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const result = await bash.run({ command: 'touch ran' }, ctxFor(dir, { signal: AbortSignal.abort() }));
  assert.deepEqual(result, { content: 'Command not run: aborted', isError: true });
  assert.equal(existsSync(join(dir, 'ran')), false);
});

test('large output is capped head and tail, keeping the trailer', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const result = await bash.run({ command: "head -c 100000 /dev/zero | tr '\\0' a" }, ctxFor(dir));
  assert.equal(result.content, capResult(`${'a'.repeat(100000)}\n[exit 0]`));
});

test('a missing cwd is an error, not a throw', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const result = await bash.run({ command: 'echo hi' }, ctxFor(join(dir, 'missing')));
  assert.equal(result.isError, true);
  assert.match(result.content, /^Cannot run bash in /);
});

test('timeout defaults to 120000 ms and is clamped to 600000 ms', () => {
  assert.equal(clampTimeout(undefined), 120000);
  assert.equal(clampTimeout(0), 120000);
  assert.equal(clampTimeout('soon'), 120000);
  assert.equal(clampTimeout(300), 300);
  assert.equal(clampTimeout(900000), 600000);
});
