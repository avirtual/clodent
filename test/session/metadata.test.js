import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMain, textReply } from '../helpers/run-main.js';
import { startRepl } from '../repl/harness.js';
import { useTempDir } from '../tools/tmp-dir.js';

const GUARD = { timeout: 5000 };
const ID = '11111111-2222-4333-8444-555555555555';
const rateLimited = { status: 429, body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }) };

const userIds = (calls) => calls.map((call) => call.body.metadata?.user_id);
const userIdOf = (id) => JSON.stringify({ session_id: id });

async function dirs(t) {
  return { home: await useTempDir(t), cwd: await useTempDir(t) };
}

async function steps(repl, lines) {
  await repl.prompts(1);
  for (const [i, line] of lines.entries()) {
    repl.stdin.type(`${line}\r`);
    await repl.prompts(i + 2);
  }
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
}

test('a fresh --session-id is sent as metadata.user_id, the exact JSON string', async (t) => {
  const { home, cwd } = await dirs(t);
  const res = await runMain(['-p', 'hi', '--session-id', ID], { home, cwd, responses: [textReply('ok')] });
  assert.equal(res.code, 0);
  assert.deepEqual(res.calls.map((call) => call.body.metadata), [{ user_id: `{"session_id":"${ID}"}` }]);
});

test('a minted session id in metadata.user_id is the [clodent:session] id', async (t) => {
  const { home, cwd } = await dirs(t);
  const res = await runMain(['-p', 'hi'], { home, cwd, responses: [textReply('ok')] });
  assert.equal(res.code, 0);
  assert.match(res.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(userIds(res.calls), [userIdOf(res.id)]);
});

test('--resume sends the resumed id; --resume --fork-session sends the forked id', async (t) => {
  const { home, cwd } = await dirs(t);
  await runMain(['-p', 'one', '--session-id', ID], { home, cwd, responses: [textReply('a')] });
  const resumed = await runMain(['-p', 'two', '--resume', ID], { home, cwd, responses: [textReply('b')] });
  assert.equal(resumed.id, ID);
  assert.deepEqual(userIds(resumed.calls), [userIdOf(ID)]);
  const fork = await runMain(['-p', 'three', '--resume', ID, '--fork-session'], { home, cwd, responses: [textReply('c')] });
  assert.equal(fork.code, 0);
  assert.notEqual(fork.id, ID);
  assert.deepEqual(userIds(fork.calls), [userIdOf(fork.id)]);
});

test('a request retried after a 429 before the first event carries the same metadata.user_id', async (t) => {
  const { home, cwd } = await dirs(t);
  const res = await runMain(['-p', 'hi', '--session-id', ID], { home, cwd, responses: [rateLimited, textReply('ok')] });
  assert.equal(res.code, 0);
  assert.deepEqual(userIds(res.calls), [userIdOf(ID), userIdOf(ID)]);
});

test('/clear: requests before it carry the old id, requests after it the new one', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl(['--session-id', ID], { home, cwd, replies: [textReply('a'), textReply('b')] });
  await steps(repl, ['one', '/clear', 'two']);
  const ids = repl.sessionIds();
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ID);
  assert.notEqual(ids[1], ID);
  assert.deepEqual(userIds(repl.fetch.calls), [userIdOf(ids[0]), userIdOf(ids[1])]);
});

test('the /compact summary request carries metadata.user_id, as do the turns around it', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl(['--session-id', ID], { home, cwd, replies: [textReply('a'), textReply('summary'), textReply('b')] });
  await steps(repl, ['one', '/compact', 'two']);
  const calls = repl.fetch.calls;
  assert.deepEqual(calls[1].body.tool_choice, { type: 'none' });
  assert.deepEqual(userIds(calls), [userIdOf(ID), userIdOf(ID), userIdOf(ID)]);
});
