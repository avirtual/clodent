import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFetch, readFixture } from '../helpers/fake-fetch.js';

async function chunksOf(response) {
  const out = [];
  for await (const chunk of response.body) out.push(chunk);
  return out;
}

test('records each call with url, lowercased headers and the JSON-parsed body', async () => {
  const fetch = createFakeFetch([{ body: 'ok' }, { body: 'ok' }]);
  await fetch('https://api.test/v1', { method: 'POST', headers: { 'X-Api-Key': 'k' }, body: '{"a":1}' });
  await fetch(new URL('https://api.test/v2'), { body: 'not json' });
  assert.deepEqual(fetch.calls, [
    { url: 'https://api.test/v1', headers: { 'x-api-key': 'k' }, body: { a: 1 } },
    { url: 'https://api.test/v2', headers: {}, body: 'not json' },
  ]);
  assert.equal(fetch.remaining(), 0);
});

test('returns a real Response with the given status and headers', async () => {
  const fetch = createFakeFetch([{ status: 529, headers: { 'request-id': 'req_1' }, body: 'busy' }]);
  const response = await fetch('https://api.test');
  assert.ok(response instanceof Response);
  assert.equal(response.status, 529);
  assert.equal(response.ok, false);
  assert.equal(response.headers.get('request-id'), 'req_1');
  assert.equal(await response.text(), 'busy');
});

test('a body ending in .sse loads that fixture', async () => {
  const fetch = createFakeFetch([{ body: 'text-only.sse' }]);
  assert.equal(await (await fetch('https://api.test')).text(), readFixture('text-only.sse'));
});

test('chunkEvery splits the body every n bytes, even inside a multibyte character', async () => {
  const fetch = createFakeFetch([{ body: 'aé🎉', chunkEvery: 2 }], {});
  const chunks = await chunksOf(await fetch('https://api.test'));
  assert.deepEqual(chunks.map((c) => c.length), [2, 2, 2, 1]);
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'aé🎉');
});

test('a fetch-level chunkEvery applies to responses without their own', async () => {
  const fetch = createFakeFetch([{ body: 'abcdef' }, { body: 'abcdef', chunkEvery: 4 }], { chunkEvery: 3 });
  assert.deepEqual((await chunksOf(await fetch('u'))).map((c) => c.length), [3, 3]);
  assert.deepEqual((await chunksOf(await fetch('u'))).map((c) => c.length), [4, 2]);
});

test('an array body is sent chunk by chunk and an Error in it errors the stream', async () => {
  const fetch = createFakeFetch([{ body: ['ab', 'cd'] }, { body: ['ab', new TypeError('terminated')] }]);
  assert.deepEqual((await chunksOf(await fetch('u'))).map((c) => Buffer.from(c).toString()), ['ab', 'cd']);
  const broken = await fetch('u');
  await assert.rejects(chunksOf(broken), /terminated/);
});

test('an error response rejects the call with that error', async () => {
  const failure = new TypeError('fetch failed');
  const fetch = createFakeFetch([{ error: failure }]);
  await assert.rejects(fetch('u'), (err) => err === failure);
});

test('running out of responses throws loudly', async () => {
  const fetch = createFakeFetch([{ body: 'one' }]);
  await fetch('u');
  await assert.rejects(fetch('https://api.test/late'), /fake-fetch: no response left for call 2 \(https:\/\/api.test\/late\)/);
});

test('an abort errors the body stream with the signal reason', async () => {
  const controller = new AbortController();
  const fetch = createFakeFetch([{ body: 'abcdef', chunkEvery: 1 }]);
  const response = await fetch('u', { signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read(), (err) => err === controller.signal.reason);
});
