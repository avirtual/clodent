import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { textReply } from '../helpers/run-main.js';
import { useTempDir } from '../tools/tmp-dir.js';
import { parseRecords, startStream, STREAM_ARGV, userLine, UUID } from './harness.js';

const GUARD = { timeout: 5000 };
const TOO_LONG_BODY = readFileSync(new URL('../api/fixtures/prompt-too-long.json', import.meta.url), 'utf8').trim();
const MAX_TOKENS_BODY = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for claude-opus-5-5' } });

async function dirs(t) {
  return { home: await useTempDir(t), cwd: await useTempDir(t) };
}

function results(s) {
  return parseRecords(s.out.text).filter((record) => record.type === 'result');
}

function inits(s) {
  return parseRecords(s.out.text).filter((record) => record.type === 'system' && record.subtype === 'init');
}

async function oneTurn(t, replies, argv = []) {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, ...argv], { home, cwd, replies });
  s.send(userLine('hi'));
  await s.until('result');
  s.send(userLine('/cost'));
  await s.until('result', 2);
  s.close();
  assert.equal(await s.done, 0);
  return { s, results: results(s) };
}

test('a prompt-too-long 400 is not retried; its result carries api_error with the request-id header and context_window_exceeded', GUARD, async (t) => {
  const reply = { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_from_header' }, body: TOO_LONG_BODY };
  const { s, results: [turn, command] } = await oneTurn(t, [reply]);
  assert.equal(s.fetch.calls.length, 1);
  assert.equal(turn.is_error, true);
  assert.deepEqual(turn.api_error, { status: 400, type: 'invalid_request_error', message: 'prompt is too long: 1057655 tokens > 1000000 maximum', request_id: 'req_from_header' });
  assert.equal(turn.context_window_exceeded, true);
  assert.equal(Object.hasOwn(command, 'api_error') || Object.hasOwn(command, 'context_window_exceeded'), false);
  assert.match(s.err.text, /^clodent: prompt is too long: 1057655 tokens > 1000000 maximum\nclodent: the conversation is larger than the model's context window; start a new session$/m);
});

test('another 400 gives api_error, with a null request_id when the header is absent, and no context_window_exceeded', GUARD, async (t) => {
  const reply = { status: 400, headers: { 'content-type': 'application/json' }, body: MAX_TOKENS_BODY };
  const { s, results: [turn] } = await oneTurn(t, [reply]);
  assert.equal(s.fetch.calls.length, 1);
  assert.deepEqual(turn.api_error, { status: 400, type: 'invalid_request_error', message: JSON.parse(MAX_TOKENS_BODY).error.message, request_id: null });
  assert.equal(Object.hasOwn(turn, 'context_window_exceeded'), false);
  assert.doesNotMatch(s.err.text, /context window/);
});

test('a successful turn on a priced model carries no api_error, context_window_exceeded or unpriced_models', GUARD, async (t) => {
  const { results: [turn, command] } = await oneTurn(t, [textReply('ok', { input_tokens: 10, output_tokens: 2 })]);
  assert.equal(turn.is_error, false);
  for (const record of [turn, command]) {
    for (const key of ['api_error', 'context_window_exceeded', 'unpriced_models']) assert.equal(Object.hasOwn(record, key), false, key);
  }
});

test('an unpriced model puts unpriced_models on every result after it is seen', GUARD, async (t) => {
  const { results: [turn, command] } = await oneTurn(t, [textReply('ok', { input_tokens: 10, output_tokens: 2 })], ['--model', 'claude-unknown-9']);
  assert.deepEqual(turn.unpriced_models, ['claude-unknown-9']);
  assert.deepEqual(command.unpriced_models, ['claude-unknown-9']);
});

test('init carries the window /model decided and the AGENTS.md files, again on each /clear', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  writeFileSync(join(cwd, 'AGENTS.md'), 'rules');
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, '--model', 'claude-haiku-5-5[1m]'], { home, cwd });
  await s.until('system/init');
  s.send(userLine('/model claude-opus-5-5'));
  s.send(userLine('/clear'));
  await s.until('system/init', 2);
  s.send(userLine('/model claude-sonnet-5-5[1M]'));
  s.send(userLine('/clear'));
  await s.until('system/init', 3);
  s.close();
  assert.equal(await s.done, 0);
  const files = [join(cwd, 'AGENTS.md')];
  assert.deepEqual(
    inits(s).map((init) => [init.model, init.context_window_size, init.instruction_files]),
    [
      ['claude-haiku-5-5', 1000000, files],
      ['claude-opus-5-5', 200000, files],
      ['claude-sonnet-5-5', 1000000, files],
    ],
  );
});
