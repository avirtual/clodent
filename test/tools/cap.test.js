import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESULT_MAX_BYTES, capResult, createCapSink } from '../../src/tools/cap.js';

const MARKER = /\n\[clay: truncated (\d+) bytes\]\n/;

function split(capped) {
  const match = MARKER.exec(capped);
  return {
    head: capped.slice(0, match.index),
    omitted: Number(match[1]),
    tail: capped.slice(match.index + match[0].length),
  };
}

function viaSink(text, chunkSize) {
  const sink = createCapSink();
  const buf = Buffer.from(text, 'utf8');
  for (let i = 0; i < buf.length; i += chunkSize) sink.push(buf.subarray(i, i + chunkSize));
  return sink.text();
}

test('RESULT_MAX_BYTES is 32 KiB', () => {
  assert.equal(RESULT_MAX_BYTES, 32768);
});

test('text under the cap is returned unchanged', () => {
  assert.equal(capResult('hello\nworld'), 'hello\nworld');
  assert.equal(capResult(''), '');
});

test('text exactly at the cap is returned unchanged', () => {
  const text = `${'é'.repeat(16000)}${'x'.repeat(768)}`;
  assert.equal(Buffer.byteLength(text), RESULT_MAX_BYTES);
  assert.equal(capResult(text), text);
});

test('one byte over the cap keeps 16384 head and tail bytes and reports 1 truncated byte', () => {
  const text = `${'a'.repeat(16384)}X${'b'.repeat(16384)}`;
  assert.equal(capResult(text), `${'a'.repeat(16384)}\n[clay: truncated 1 bytes]\n${'b'.repeat(16384)}`);
});

test('a multibyte char straddling either cut point is dropped whole', () => {
  const emoji = '😀';
  const text = `${'a'.repeat(16382)}${emoji}${'m'.repeat(1000)}${emoji}${'c'.repeat(16382)}`;
  assert.equal(capResult(text), `${'a'.repeat(16382)}\n[clay: truncated 1008 bytes]\n${'c'.repeat(16382)}`);
});

test('the marker count is exactly the bytes removed', () => {
  const unit = 'aé€😀\n';
  const text = unit.repeat(9000);
  const { head, omitted, tail } = split(capResult(text));
  assert.ok(text.startsWith(head));
  assert.ok(text.endsWith(tail));
  assert.equal(Buffer.byteLength(head) + omitted + Buffer.byteLength(tail), Buffer.byteLength(text));
  assert.ok(Buffer.byteLength(head) <= 16384 && Buffer.byteLength(head) > 16380);
  assert.ok(Buffer.byteLength(tail) <= 16384 && Buffer.byteLength(tail) > 16380);
});

test('the streaming sink matches capResult for every size and chunking', () => {
  const unit = 'xé€😀';
  for (const length of [0, 10, 3277, 6553, 6554, 30000, 100000]) {
    const text = unit.repeat(length).slice(0, length * 3);
    for (const chunkSize of [1, 7, 4096, 1 << 20]) {
      if (chunkSize === 1 && text.length > 30000) continue;
      assert.equal(viaSink(text, chunkSize), capResult(text), `length ${length} chunk ${chunkSize}`);
    }
  }
});
