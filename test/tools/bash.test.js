import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { KILL_GRACE_MS, createBash, clampTimeout } from '../../src/tools/bash.js';
import { capResult } from '../../src/tools/cap.js';
import { cleanEnv, ctxFor, useTempDir } from './tmp-dir.js';

const bash = createBash();
const GUARD = { timeout: 10000 };
const HAS_PERL = (process.env.PATH ?? '').split(delimiter).some((dir) => dir !== '' && existsSync(join(dir, 'perl')));

function isGone(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === 'ESRCH';
  }
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return state === '' || state.startsWith('Z');
  } catch {
    return true;
  }
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
  const ctx = { cwd: dir, env: cleanEnv({ CLODENT_PROBE: 'probe-value' }) };
  assert.equal((await bash.run({ command: 'pwd; echo "$CLODENT_PROBE"' }, ctx)).content, `${dir}\nprobe-value\n[exit 0]`);
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

test('SIGKILL follows SIGTERM to the group after the grace period', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const calls = [];
  const kill = (pid, signal) => {
    calls.push([pid < 0, signal]);
    process.kill(pid, signal);
  };
  const stubborn = createBash({ killGraceMs: 50, kill });
  const started = Date.now();
  const result = await stubborn.run({ command: "trap '' TERM; sleep 30", timeout: 300 }, ctxFor(dir));
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.content, '[timed out after 300 ms]');
  assert.deepEqual(calls, [[true, 'SIGTERM'], [true, 'SIGKILL']]);
  assert.equal(KILL_GRACE_MS, 2000);
});

test('a line written just before the SIGKILL still reaches the output', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const marker = join(dir, 'wrote');
  const kill = (pid, signal) => {
    if (signal === 'SIGKILL') {
      process.kill(pid, 'SIGUSR1');
      const deadline = Date.now() + 5000;
      while (!existsSync(marker) && Date.now() < deadline) {}
    }
    process.kill(pid, signal);
  };
  const stubborn = createBash({ killGraceMs: 50, kill });
  const command = "(trap '' TERM; trap 'echo last-line; touch wrote' USR1; while :; do sleep 1; done) 2>/dev/null &";
  const result = await stubborn.run({ command, timeout: 300 }, ctxFor(dir));
  assert.deepEqual(result, { content: 'last-line\n[timed out after 300 ms]', isError: true });
});

test('a descendant that leaves the process group cannot hold a timed-out call open', { ...GUARD, skip: HAS_PERL ? false : 'perl is not on PATH' }, async (t) => {
  const dir = await useTempDir(t);
  const quick = createBash({ killGraceMs: 50 });
  const started = Date.now();
  const command = "perl -MPOSIX -e 'POSIX::setsid(); sleep 5' & echo started";
  const result = await quick.run({ command, timeout: 300 }, ctxFor(dir, { env: cleanEnv({ LC_ALL: 'C' }) }));
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.deepEqual(result, { content: 'started\n[timed out after 300 ms]', isError: true });
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

test('after an abort, a background child that ignores TERM and redirected its output still gets the SIGKILL', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const pidFile = join(dir, 'pid');
  const controller = new AbortController();
  const quick = createBash({ killGraceMs: 100 });
  const command = "(trap '' TERM; exec sleep 30) >/dev/null 2>&1 & echo $! > pid.tmp; mv pid.tmp pid; wait";
  const pending = quick.run({ command }, ctxFor(dir, { signal: controller.signal }));
  const until = async (ready) => {
    const deadline = Date.now() + 3000;
    while (!ready() && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
    return ready();
  };
  assert.ok(await until(() => existsSync(pidFile)), 'the child never started');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  });
  controller.abort();
  await pending;
  assert.ok(await until(() => isGone(pid)), `child ${pid} survived the abort`);
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
