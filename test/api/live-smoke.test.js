import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { liveSmoke, DEFAULT_MODEL } from '../../scripts/live-smoke.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/live-smoke.js', import.meta.url));

function fakeDeps(responses, env = { ANTHROPIC_API_KEY: 'sk-test' }) {
  const out = [];
  const err = [];
  const fetch = createFakeFetch(responses);
  return {
    fetch,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    deps: {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env,
      fetch,
      sleep: async () => {},
      random: () => 0.5,
      now: () => 0,
    },
  };
}

test('without ANTHROPIC_API_KEY the script exits 2 with a stderr line and no request', () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const run = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.equal(run.stderr, 'live-smoke: ANTHROPIC_API_KEY not set\n');
  assert.equal(run.stdout, '');
});

test('sends the same streamed request twice and prints text, stop_reason and usage', async () => {
  const fake = fakeDeps([{ body: 'text-only.sse' }, { body: 'text-only.sse' }]);
  assert.equal(await liveSmoke([], fake.deps), 0);
  assert.equal(fake.fetch.calls.length, 2);
  assert.deepEqual(fake.fetch.calls[0], fake.fetch.calls[1]);
  const { body } = fake.fetch.calls[0];
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, 'claude-haiku-5-5');
  assert.equal(body.tools.length, 1);
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'Reply with exactly: pong', cache_control: { type: 'ephemeral' } },
  ]);
  const lines = fake.stdout().split('\n');
  assert.equal(lines[0], 'Hello, world!');
  assert.equal(lines[1], '[1] stop_reason: end_turn');
  assert.match(lines[2], /^\[1\] usage: \{"input_tokens":25,/);
  assert.equal(lines[4], '[2] stop_reason: end_turn');
  assert.match(lines[5], /^\[2\] usage: \{/);
});

test('--model picks the model', async () => {
  const fake = fakeDeps([{ body: 'text-only.sse' }, { body: 'text-only.sse' }]);
  assert.equal(await liveSmoke(['--model', 'claude-opus-5-5'], fake.deps), 0);
  assert.equal(fake.fetch.calls[0].body.model, 'claude-opus-5-5');
});

test('an empty text reply exits 1', async () => {
  const empty = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"x","usage":{}}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  const fake = fakeDeps([{ body: 'text-only.sse' }, { body: empty }]);
  assert.equal(await liveSmoke([], fake.deps), 1);
});

test('an API error exits 1 and prints the verbatim message', async () => {
  const fake = fakeDeps([
    { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'credit balance is too low' } }) },
  ]);
  assert.equal(await liveSmoke([], fake.deps), 1);
  assert.equal(fake.stderr(), 'live-smoke: request 1 failed: 400 invalid_request_error: credit balance is too low\n');
});

test('an unknown argument exits 2 with usage', async () => {
  const fake = fakeDeps([]);
  assert.equal(await liveSmoke(['--bogus'], fake.deps), 2);
  assert.match(fake.stderr(), /unknown argument --bogus/);
});
