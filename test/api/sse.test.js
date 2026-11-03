import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../../src/api/sse.js';
import { createFakeFetch, readFixture } from '../helpers/fake-fetch.js';

const FIXTURES = [
  'text-only.sse',
  'thinking-text.sse',
  'tool-use.sse',
  'error-mid-stream.sse',
  'cut-before-stop.sse',
];
const encoder = new TextEncoder();

function oracle(text) {
  return text
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((line) => line.startsWith('event: ')).slice('event: '.length);
      const data = lines.find((line) => line.startsWith('data: ')).slice('data: '.length);
      return { event, data: JSON.parse(data) };
    });
}

async function collect(iterable) {
  const out = [];
  for await (const item of parseSSE(iterable)) out.push(item);
  return out;
}

async function parseBody(body, chunkEvery) {
  const fetch = createFakeFetch([{ body, chunkEvery }]);
  const response = await fetch('https://example.test');
  return collect(response.body);
}

for (const name of FIXTURES) {
  for (const chunkEvery of [1, 7, undefined]) {
    test(`${name} parses identically with chunkEvery ${chunkEvery ?? 'whole'}`, async () => {
      const expected = oracle(readFixture(name));
      assert.ok(expected.length >= 4);
      assert.equal(expected[0].event, 'message_start');
      assert.deepEqual(await parseBody(name, chunkEvery), expected);
    });
  }
  test(`${name} parses identically with CRLF line endings at chunkEvery 1 and 7`, async () => {
    const text = readFixture(name);
    const expected = oracle(text);
    const crlf = text.replace(/\n/g, '\r\n');
    assert.deepEqual(await parseBody(crlf, 1), expected);
    assert.deepEqual(await parseBody(crlf, 7), expected);
  });
}

test('every fixture carries event lines and the ping fixture carries a ping', () => {
  for (const name of FIXTURES) {
    const text = readFixture(name);
    const blocks = text.split('\n\n').filter((block) => block.trim() !== '');
    for (const block of blocks) assert.match(block, /^event: \w+\ndata: /);
  }
  assert.ok(oracle(readFixture('text-only.sse')).some((e) => e.event === 'ping'));
  assert.ok(oracle(readFixture('error-mid-stream.sse')).some((e) => e.event === 'error'));
  assert.ok(!oracle(readFixture('cut-before-stop.sse')).some((e) => e.event === 'message_stop'));
});

test('a multibyte character split across chunks decodes intact', async () => {
  const bytes = encoder.encode('event: x\ndata: {"t":"café 🎉"}\n\n');
  const eAcute = encoder.encode('é');
  const splitAt = bytes.indexOf(eAcute[0]) + 1;
  const emojiAt = bytes.indexOf(0xf0) + 2;
  const chunks = [bytes.subarray(0, splitAt), bytes.subarray(splitAt, emojiAt), bytes.subarray(emojiAt)];
  assert.deepEqual(await collect(chunks), [{ event: 'x', data: { t: 'café 🎉' } }]);
});

test('a CRLF split between CR and LF is one line ending', async () => {
  const chunks = ['event: a\r', '\ndata: 1\r', '\n\r', '\nevent: b\r\ndata: 2\r\n\r\n'];
  assert.deepEqual(await collect(chunks.map((c) => encoder.encode(c))), [
    { event: 'a', data: 1 },
    { event: 'b', data: 2 },
  ]);
});

test('bare CR line endings are accepted', async () => {
  assert.deepEqual(await collect([encoder.encode('event: a\rdata: 1\r\rdata: 2\r\r')]), [
    { event: 'a', data: 1 },
    { event: 'message', data: 2 },
  ]);
});

test('multiple data lines are joined by a newline before parsing', async () => {
  const chunks = [encoder.encode('event: multi\ndata: {"a":\ndata: [1,\ndata: 2]}\n\n')];
  assert.deepEqual(await collect(chunks), [{ event: 'multi', data: { a: [1, 2] } }]);
});

test('comment lines and unknown fields are ignored', async () => {
  const text = ': keep-alive\nevent: a\nid: 7\nretry: 100\n: note\ndata: true\n\n:only a comment\n\n';
  assert.deepEqual(await collect([encoder.encode(text)]), [{ event: 'a', data: true }]);
});

test('a final event without a trailing blank line is still emitted', async () => {
  assert.deepEqual(await collect([encoder.encode('event: last\ndata: {"done":1}')]), [
    { event: 'last', data: { done: 1 } },
  ]);
  assert.deepEqual(await collect([encoder.encode('event: last\r\ndata: 5\r')]), [
    { event: 'last', data: 5 },
  ]);
});

test('field values without the optional space and blank-line event resets parse per the SSE rules', async () => {
  const text = 'event:a\ndata:{"x":1}\n\nevent: dropped\n\ndata: 2\n\n';
  assert.deepEqual(await collect([encoder.encode(text)]), [
    { event: 'a', data: { x: 1 } },
    { event: 'message', data: 2 },
  ]);
});

test('unparseable data throws an ApiError of type invalid_sse', async () => {
  await assert.rejects(collect([encoder.encode('event: a\ndata: {nope\n\n')]), {
    name: 'ApiError',
    type: 'invalid_sse',
  });
});
