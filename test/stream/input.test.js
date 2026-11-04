import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineSplitter } from '../../src/stream/input.js';

function split(cap) {
  const lines = [];
  const warnings = [];
  const splitter = lineSplitter({ onLine: (line) => lines.push(line), warn: (warning) => warnings.push(warning), cap });
  return { lines, warnings, splitter };
}

test('a line of exactly the cap is read; a longer one warns once, is dropped across chunks up to its newline, and the next line is read', () => {
  const { lines, warnings, splitter } = split(4);
  for (const chunk of ['abcd\nab', 'cde', 'fg', 'h\r\nok\r\n', 'ta', 'il']) splitter.push(chunk);
  splitter.end();
  assert.deepEqual(lines, ['abcd', 'ok', 'tail']);
  assert.deepEqual(warnings, ['stdin: ignoring a line over 4 bytes']);
});

test('the cap counts UTF-8 bytes, and an oversized unterminated line at EOF is dropped', () => {
  const { lines, warnings, splitter } = split(4);
  splitter.push('é€\néé\nabcde');
  splitter.end();
  assert.deepEqual(lines, ['éé']);
  assert.deepEqual(warnings, ['stdin: ignoring a line over 4 bytes', 'stdin: ignoring a line over 4 bytes']);
});
