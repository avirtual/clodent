import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_TIMEOUT_MS, streamMessage } from '../../src/api/stream.js';
import { buildRequest } from '../../src/api/request.js';
import { createFakeFetch, STALL } from '../helpers/fake-fetch.js';

const request = buildRequest(
  { model: 'claude-opus-5-5', system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
  { env: { ANTHROPIC_API_KEY: 'sk-test' } },
);

function sse(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function clock(...times) {
  const queue = [...times];
  return () => queue.shift();
}

function depsFor(responses, overrides = {}) {
  const fetch = createFakeFetch(responses);
  const sleeps = [];
  return {
    fetch,
    sleeps,
    deps: {
      fetch,
      sleep: async (ms) => sleeps.push(ms),
      random: () => 0.5,
      now: clock(1000, 1250),
      ...overrides,
    },
  };
}

function recorder() {
  const log = [];
  return {
    log,
    handlers: {
      onText: (text, index) => log.push(['text', index, text]),
      onThinking: (text, index) => log.push(['thinking', index, text]),
      onBlockStart: (block, index) => log.push(['start', index, block.type]),
      onBlockStop: (block, index) => log.push(['stop', index, block.type]),
    },
  };
}

for (const chunkEvery of [1, 7, undefined]) {
  test(`text-only assembles at chunkEvery ${chunkEvery ?? 'whole'}`, async () => {
    const { deps } = depsFor([{ body: 'text-only.sse', chunkEvery, headers: { 'request-id': 'req_011' } }]);
    const { handlers, log } = recorder();
    const result = await streamMessage(request, deps, handlers);
    assert.deepEqual(result, {
      message: {
        id: 'msg_01TextOnlyFixture000000',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'Hello, world!' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 25,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
          output_tokens: 15,
          service_tier: 'standard',
        },
      },
      requestId: 'req_011',
      durationMs: 250,
    });
    assert.deepEqual(log, [
      ['start', 0, 'text'],
      ['text', 0, 'Hello'],
      ['text', 0, ', world!'],
      ['stop', 0, 'text'],
    ]);
  });

  test(`thinking + signature + text assembles at chunkEvery ${chunkEvery ?? 'whole'}`, async () => {
    const { deps } = depsFor([{ body: 'thinking-text.sse', chunkEvery }]);
    const { handlers, log } = recorder();
    const { message, requestId } = await streamMessage(request, deps, handlers);
    assert.equal(requestId, null);
    assert.deepEqual(message.content, [
      {
        type: 'thinking',
        thinking: 'The user wants a café → crème answer. Keep it short ✓',
        signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds',
      },
      { type: 'text', text: 'Café crème — done 🎉' },
    ]);
    assert.deepEqual(log.filter(([kind]) => kind === 'thinking').map(([, i]) => i), [0, 0]);
    assert.deepEqual(log.filter(([kind]) => kind === 'text').map(([, i, t]) => [i, t]), [
      [1, 'Café crème — '],
      [1, 'done 🎉'],
    ]);
  });

  test(`tool_use input split over deltas is parsed at chunkEvery ${chunkEvery ?? 'whole'}`, async () => {
    const { deps } = depsFor([{ body: 'tool-use.sse', chunkEvery }]);
    const stops = [];
    const { message } = await streamMessage(request, deps, {
      onBlockStop: (block) => stops.push(structuredClone(block)),
    });
    assert.equal(message.stop_reason, 'tool_use');
    assert.deepEqual(message.content[1], {
      type: 'tool_use',
      id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
      name: 'Read',
      input: { file_path: '/tmp/notes.md', limit: 40 },
    });
    assert.deepEqual(stops[1].input, { file_path: '/tmp/notes.md', limit: 40 });
    assert.equal(message.usage.output_tokens, 89);
  });
}

test('usage merges message_delta values over message_start, keeping unknown fields and ignoring nulls', async () => {
  const body = sse([
    ['message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: { input_tokens: 10, output_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 4 }, server_tool_use: null } } }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7, input_tokens: null, cache_read_input_tokens: 3 } }],
    ['message_delta', { type: 'message_delta', delta: {}, usage: { output_tokens: 9 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
  const { deps } = depsFor([{ body }]);
  const { message } = await streamMessage(request, deps);
  assert.deepEqual(message.usage, {
    input_tokens: 10,
    output_tokens: 9,
    cache_creation: { ephemeral_5m_input_tokens: 4 },
    server_tool_use: null,
    cache_read_input_tokens: 3,
  });
  assert.equal(message.stop_reason, 'end_turn');
});

test('a stop_sequence from message_delta is kept', async () => {
  const body = sse([
    ['message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'stop_sequence', stop_sequence: 'END' }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
  const { message } = await streamMessage(request, depsFor([{ body }]).deps);
  assert.equal(message.stop_reason, 'stop_sequence');
  assert.equal(message.stop_sequence, 'END');
});

test('unknown events and delta types are ignored; unknown and redacted blocks are kept verbatim', async () => {
  const body = sse([
    ['message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['brand_new_event', { type: 'brand_new_event', payload: 1 }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'citations_delta', citation: { cited_text: 'x' } } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'future_block', payload: { a: 1 } } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'future_delta', more: 2 } }],
    ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    ['ping', { type: 'ping' }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
  const { message } = await streamMessage(request, depsFor([{ body }]).deps);
  assert.deepEqual(message.content, [
    { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix' },
    { type: 'text', text: 'hi' },
    { type: 'future_block', payload: { a: 1 } },
  ]);
});

test('a tool_use block with no input deltas gets an empty object input', async () => {
  const body = sse([
    ['message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'Glob', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_stop', { type: 'message_stop' }],
  ]);
  const { message } = await streamMessage(request, depsFor([{ body }]).deps);
  assert.deepEqual(message.content[0].input, {});
});

test('unparseable tool input throws ApiError invalid_tool_json', async () => {
  const body = sse([
    ['message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path": "/a' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_stop', { type: 'message_stop' }],
  ]);
  await assert.rejects(streamMessage(request, depsFor([{ body, headers: { 'request-id': 'req_9' } }]).deps), {
    name: 'ApiError',
    type: 'invalid_tool_json',
    requestId: 'req_9',
  });
});

test('a stream cut before message_stop throws incomplete_stream', async () => {
  const { deps, fetch } = depsFor([{ body: 'cut-before-stop.sse', chunkEvery: 7 }]);
  await assert.rejects(streamMessage(request, deps), {
    name: 'ApiError',
    type: 'incomplete_stream',
    status: null,
  });
  assert.equal(fetch.calls.length, 1);
});

test('a mid-stream error event throws with status null and is not retried', async () => {
  const { deps, fetch, sleeps } = depsFor([
    { body: 'error-mid-stream.sse', headers: { 'request-id': 'req_err' } },
    { body: 'text-only.sse' },
  ]);
  const texts = [];
  await assert.rejects(streamMessage(request, deps, { onText: (t) => texts.push(t) }), {
    name: 'ApiError',
    type: 'overloaded_error',
    message: 'Overloaded',
    status: null,
    requestId: 'req_err',
  });
  assert.deepEqual(texts, ['Partial']);
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('the request is POSTed with its headers and JSON body', async () => {
  const { deps, fetch } = depsFor([{ body: 'text-only.sse' }]);
  await streamMessage(request, deps);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(fetch.calls[0].headers, request.headers);
  assert.deepEqual(fetch.calls[0].body, request.body);
});

test('onUsage reports message_start input fields with the last message_delta output, 0 before any delta', async () => {
  const body = sse([
    ['message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 4, output_tokens: 1 } } }],
    ['message_delta', { type: 'message_delta', delta: {}, usage: { output_tokens: 7, cache_read_input_tokens: 99 } }],
    ['message_delta', { type: 'message_delta', delta: {}, usage: { output_tokens: 9 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
  const reports = [];
  await streamMessage(request, depsFor([{ body }]).deps, { onUsage: (usage) => reports.push(usage) });
  const start = { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 4 };
  assert.deepEqual(reports, [{ ...start, output_tokens: 0 }, { ...start, output_tokens: 7 }, { ...start, output_tokens: 9 }]);
});

async function settled(promise) {
  const pending = Symbol('pending');
  const outcome = promise.then((value) => ({ value }), (error) => ({ error }));
  return Promise.race([outcome, new Promise((resolve) => setImmediate(() => resolve(pending)))]).then((value) => (value === pending ? 'pending' : value));
}

const startEvent = ['message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: { input_tokens: 5 } } }];

test('a body that stalls after the first event fails as a network error once the injected idle limit passes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { deps, fetch } = depsFor([{ body: [sse([startEvent]), STALL] }], { idleTimeoutMs: 50 });
  const running = streamMessage(request, deps);
  assert.equal(await settled(running), 'pending');
  t.mock.timers.tick(49);
  assert.equal(await settled(running), 'pending');
  t.mock.timers.tick(1);
  const { error } = await settled(running);
  assert.equal(error.name, 'ApiError');
  assert.deepEqual([error.type, error.message, error.status], ['network_error', 'stream idle for 0.05s', null]);
  assert.equal(fetch.calls.length, 1);
});

test('a body that stalls before any event is retried, and the default idle limit is 300 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(IDLE_TIMEOUT_MS, 300_000);
  const { deps, fetch, sleeps } = depsFor([{ body: [STALL] }, { body: [sse([startEvent]), STALL] }]);
  const running = streamMessage(request, deps);
  assert.equal(await settled(running), 'pending');
  t.mock.timers.tick(299_999);
  assert.equal(await settled(running), 'pending');
  t.mock.timers.tick(1);
  assert.equal(await settled(running), 'pending');
  assert.deepEqual([fetch.calls.length, sleeps], [2, [1000]]);
  t.mock.timers.tick(300_000);
  const { error } = await settled(running);
  assert.deepEqual([error.type, error.message], ['network_error', 'stream idle for 300s']);
});

test('an SSE event over the injected cap fails the attempt as a network error', async () => {
  const big = ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'x'.repeat(200) } }];
  const { deps, fetch } = depsFor([{ body: sse([startEvent, big]), chunkEvery: 16 }], { maxEventChars: 128 });
  await assert.rejects(streamMessage(request, deps), { name: 'ApiError', type: 'network_error', message: 'SSE event over 128 chars', status: null });
  assert.equal(fetch.calls.length, 1);
});
