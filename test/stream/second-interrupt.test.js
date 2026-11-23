import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hookGroup, textReply, writeSettings } from '../helpers/run-main.js';
import { gatedPost, readFifoLine, slowPost } from '../helpers/slow-hooks.js';
import { script } from '../hooks/scripts.js';
import { useTempDir } from '../tools/tmp-dir.js';
import { parseRecords, startStream, STREAM_ARGV, userLine, UUID } from './harness.js';

const GUARD = { timeout: 5000 };
const PROMPT_EXIT_MS = 1500;

const interrupt = (id) => ({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } });

test('a second interrupt before the stopped call\'s PostToolUseFailure hook starts kills nothing: that hook and Stop run to completion', GUARD, async (t) => {
  const { home, cwd, settings, reply, running, terminated, release, postRan, stopRan } = await gatedPost(t);
  const s = startStream([...STREAM_ARGV, '--yolo', '--session-id', UUID, '--settings', settings], { home, cwd, replies: [reply] });
  s.send(userLine('go'));
  assert.equal(await running, 'run');
  s.send(interrupt('i-1'));
  assert.equal(await terminated, 'term');
  s.send(interrupt('i-2'));
  await s.out.wait((records) => records.some((record) => record.response?.request_id === 'i-2'), 'i-2 reply');
  await release();
  await s.until('result');
  s.close();
  assert.equal(await s.done, 0);
  assert.doesNotMatch(s.err.text, /aborted/);
  assert.deepEqual([existsSync(postRan), existsSync(stopRan)], [true, true]);
  const [result] = parseRecords(s.out.text).filter((record) => record.type === 'result');
  assert.deepEqual([result.is_error, result.stop_reason, result.num_turns], [false, null, 1]);
});

test('a second interrupt kills the slow PostToolUseFailure hook of the call the first one stopped, Stop still runs, and the turn ends', GUARD, async (t) => {
  const { home, cwd, settings, reply, running, up, stopRan } = await slowPost(t);
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
  assert.match(s.err.text, /^clodent: hook PostToolUseFailure "[^"]*post\.sh": aborted$/m);
  assert.doesNotMatch(s.err.text, /hook Stop/);
  assert.equal(existsSync(stopRan), true);
  const [result] = parseRecords(s.out.text).filter((record) => record.type === 'result');
  assert.deepEqual([result.is_error, result.stop_reason, result.num_turns], [false, null, 1]);
  assert.equal(s.fetch.calls.length, 1);
});

test('an interrupt during the Stop hook of an interrupted turn kills it, and the waiting prompt runs uninterrupted', GUARD, async (t) => {
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
