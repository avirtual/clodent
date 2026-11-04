import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamMessage, backoffMs, MAX_ATTEMPTS } from '../../src/api/stream.js';
import { ApiError, parseRetryAfter } from '../../src/api/errors.js';
import { buildRequest } from '../../src/api/request.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';

const request = buildRequest(
  { model: 'claude-opus-5-5', system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
  { env: { ANTHROPIC_API_KEY: 'sk-test' } },
);

const CREDIT_MESSAGE =
  'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';

function errorBody(type, message) {
  return JSON.stringify({ type: 'error', error: { type, message } });
}

const overloaded = { status: 529, body: errorBody('overloaded_error', 'Overloaded') };

function setup(responses, { random = () => 0.5, signal } = {}) {
  const fetch = createFakeFetch(responses);
  const sleeps = [];
  let t = 0;
  const deps = {
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random,
    now: () => (t += 10),
    signal,
  };
  return { fetch, sleeps, deps };
}

test('529 then 200 succeeds after one backoff sleep', async () => {
  const { fetch, sleeps, deps } = setup([overloaded, { body: 'text-only.sse' }]);
  const { message } = await streamMessage(request, deps);
  assert.equal(message.content[0].text, 'Hello, world!');
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(sleeps, [1000]);
});

test('every retryable status is retried', async () => {
  for (const status of [429, 500, 502, 503, 504, 529]) {
    const { fetch, deps } = setup([{ status, body: 'oops' }, { body: 'text-only.sse' }]);
    await streamMessage(request, deps);
    assert.equal(fetch.calls.length, 2, `status ${status}`);
  }
});

test('retry-after seconds are honored instead of the backoff, capped at 60s', async () => {
  const { sleeps, deps } = setup([
    { status: 429, headers: { 'retry-after': '7' }, body: errorBody('rate_limit_error', 'slow down') },
    { status: 429, headers: { 'retry-after': '600' }, body: errorBody('rate_limit_error', 'slow down') },
    { body: 'text-only.sse' },
  ]);
  await streamMessage(request, deps);
  assert.deepEqual(sleeps, [7000, 60000]);
});

test('parseRetryAfter ignores missing, blank, negative and non-numeric values', () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('-1'), null);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT'), null);
  assert.equal(parseRetryAfter('1.5'), 1500);
});

test('backoff doubles per attempt with ±20% jitter from deps.random', () => {
  assert.deepEqual([0, 1, 2].map((n) => backoffMs(n, () => 0.5)), [1000, 2000, 4000]);
  assert.equal(backoffMs(0, () => 0), 800);
  assert.equal(backoffMs(2, () => 1), 4800);
});

test('400 credit error makes one call and surfaces the API message verbatim', async () => {
  const { fetch, sleeps, deps } = setup([
    {
      status: 400,
      headers: { 'request-id': 'req_credit' },
      body: errorBody('invalid_request_error', CREDIT_MESSAGE),
    },
    { body: 'text-only.sse' },
  ]);
  const err = await streamMessage(request, deps).then(
    () => assert.fail('expected a rejection'),
    (e) => e,
  );
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 400);
  assert.equal(err.type, 'invalid_request_error');
  assert.equal(err.message, CREDIT_MESSAGE);
  assert.equal(err.requestId, 'req_credit');
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('401, 403 and 404 never retry', async () => {
  for (const status of [401, 403, 404]) {
    const { fetch, deps } = setup([{ status, body: errorBody('authentication_error', 'no') }, { body: 'text-only.sse' }]);
    await assert.rejects(streamMessage(request, deps), { status });
    assert.equal(fetch.calls.length, 1);
  }
});

test('four 529s give up after four calls with the last error', async () => {
  const { fetch, sleeps, deps } = setup([overloaded, overloaded, overloaded, overloaded, { body: 'text-only.sse' }]);
  await assert.rejects(streamMessage(request, deps), {
    name: 'ApiError',
    status: 529,
    type: 'overloaded_error',
    message: 'Overloaded',
  });
  assert.equal(MAX_ATTEMPTS, 4);
  assert.equal(fetch.calls.length, 4);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
});

test('a non-JSON error body keeps its first 500 characters as the message', async () => {
  const html = `<html>${'x'.repeat(1000)}</html>`;
  const { deps } = setup([{ status: 418, body: html }]);
  await assert.rejects(streamMessage(request, deps), (err) => {
    assert.equal(err.status, 418);
    assert.equal(err.type, 'http_error');
    assert.equal(err.message, html.slice(0, 500));
    return true;
  });
});

test('fetch network errors are retried; non-network errors propagate unchanged', async () => {
  const { fetch, deps } = setup([{ error: new TypeError('fetch failed') }, { body: 'text-only.sse' }]);
  await streamMessage(request, deps);
  assert.equal(fetch.calls.length, 2);

  const boom = new RangeError('bug');
  const second = setup([{ error: boom }, { body: 'text-only.sse' }]);
  await assert.rejects(streamMessage(request, second.deps), (err) => err === boom);
  assert.equal(second.fetch.calls.length, 1);
});

test('four network errors give up as ApiError network_error with the cause', async () => {
  const cause = new TypeError('fetch failed');
  const { fetch, deps } = setup([{ error: cause }, { error: cause }, { error: cause }, { error: cause }]);
  await assert.rejects(streamMessage(request, deps), (err) => {
    assert.equal(err.type, 'network_error');
    assert.equal(err.status, null);
    assert.equal(err.cause, cause);
    return true;
  });
  assert.equal(fetch.calls.length, 4);
});

test('a network error message shows a URL without its user name and password', async () => {
  const cause = new TypeError('Request cannot be constructed from a URL that includes credentials: https://u:FAKEPW@h/v1/messages');
  const { deps } = setup([{ error: cause }, { error: cause }, { error: cause }, { error: cause }]);
  await assert.rejects(streamMessage(request, deps), (err) => {
    assert.equal(err.message, 'Request cannot be constructed from a URL that includes credentials: https://h/v1/messages');
    assert.doesNotMatch(err.message, /FAKEPW/);
    return true;
  });
});

test('a body read error before the first event is retried; after it, it is not', async () => {
  const early = setup([{ body: [new TypeError('terminated')] }, { body: 'text-only.sse' }]);
  await streamMessage(request, early.deps);
  assert.equal(early.fetch.calls.length, 2);

  const firstEvent = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"x","usage":{}}}\n\n';
  const late = setup([{ body: [firstEvent, new TypeError('terminated')] }, { body: 'text-only.sse' }]);
  await assert.rejects(streamMessage(request, late.deps), { type: 'network_error', status: null });
  assert.equal(late.fetch.calls.length, 1);
});

test('running out of fake responses fails loudly instead of retrying', async () => {
  const { fetch, deps } = setup([]);
  await assert.rejects(streamMessage(request, deps), /fake-fetch: no response left/);
  assert.equal(fetch.calls.length, 1);
});

test('an already-aborted signal rejects with its AbortError and makes no retry', async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetch, deps } = setup([{ body: 'text-only.sse' }], { signal: controller.signal });
  await assert.rejects(streamMessage(request, deps), (err) => err === controller.signal.reason && err.name === 'AbortError');
  assert.equal(fetch.calls.length, 0);
});

test('aborting during the read rethrows the AbortError unchanged', async () => {
  const controller = new AbortController();
  const { fetch, deps } = setup([{ body: 'text-only.sse', chunkEvery: 7 }, { body: 'text-only.sse' }], {
    signal: controller.signal,
  });
  const texts = [];
  await assert.rejects(
    streamMessage(request, deps, {
      onText: (text) => {
        texts.push(text);
        controller.abort();
      },
    }),
    (err) => err === controller.signal.reason && err.name === 'AbortError',
  );
  assert.deepEqual(texts, ['Hello']);
  assert.equal(fetch.calls.length, 1);
});

test('an abort while fetching is rethrown unchanged, not retried', async () => {
  const controller = new AbortController();
  const fetch = async (url, init) => {
    controller.abort();
    throw init.signal.reason;
  };
  const sleeps = [];
  await assert.rejects(
    streamMessage(request, {
      fetch,
      sleep: async (ms) => sleeps.push(ms),
      random: () => 0.5,
      now: () => 0,
      signal: controller.signal,
    }),
    (err) => err === controller.signal.reason,
  );
  assert.deepEqual(sleeps, []);
});

test('an abort during a retry sleep stops before the next call', async () => {
  const controller = new AbortController();
  const fetch = createFakeFetch([overloaded, { body: 'text-only.sse' }]);
  await assert.rejects(
    streamMessage(request, {
      fetch,
      sleep: async (ms, signal) => {
        assert.equal(signal, controller.signal);
        controller.abort();
      },
      random: () => 0.5,
      now: () => 0,
      signal: controller.signal,
    }),
    (err) => err === controller.signal.reason,
  );
  assert.equal(fetch.calls.length, 1);
});
