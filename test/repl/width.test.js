import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redrawLine } from '../../src/repl/repl.js';
import { cellWidth, graphemes, rowsOf } from '../../src/repl/width.js';

const ZWJ_CODER = '\u{1f469}\u200d\u{1f4bb}';
const E_ACUTE = 'e\u0301';

test('cellWidth counts graphemes: ASCII 1, CJK and fullwidth 2, emoji and ZWJ sequences 2, combining marks 0', () => {
  assert.equal(cellWidth('hello'), 5);
  assert.equal(cellWidth('日本語'), 6);
  assert.equal(cellWidth('한국'), 4);
  assert.equal(cellWidth('Ａ'), 2);
  assert.equal(cellWidth(ZWJ_CODER), 2);
  assert.equal(cellWidth('\u{1f44d}\u{1f3fd}'), 2);
  assert.equal(cellWidth('\u{1f1fa}\u{1f1f8}'), 2);
  assert.equal(cellWidth('❤\ufe0f'), 2);
  assert.equal(cellWidth('❤'), 1);
  assert.equal(cellWidth(E_ACUTE), 1);
  assert.equal(cellWidth('\u0301'), 0);
  assert.equal(cellWidth(`a${ZWJ_CODER}b${E_ACUTE}日`), 7);
  assert.deepEqual(graphemes(`x${ZWJ_CODER}${E_ACUTE}`), ['x', ZWJ_CODER, E_ACUTE]);
});

test('rowsOf counts the rows a line uses up to its cursor, wrapping a wide character that does not fit', () => {
  assert.equal(rowsOf('', 80), 1);
  assert.equal(rowsOf('x'.repeat(80), 80), 1);
  assert.equal(rowsOf('x'.repeat(81), 80), 2);
  assert.equal(rowsOf(`> ${'x'.repeat(160)}`, 80), 3);
  assert.equal(rowsOf(`${'x'.repeat(79)}日`, 80), 2);
  assert.equal(rowsOf(`${'x'.repeat(78)}日`, 80), 1);
  assert.equal(rowsOf('日'.repeat(5), 9), 2);
  assert.equal(rowsOf(ZWJ_CODER.repeat(40), 80), 1);
  assert.equal(rowsOf(`${ZWJ_CODER.repeat(40)}${E_ACUTE}`, 80), 2);
  assert.equal(rowsOf(`${'x'.repeat(79)}\u0301`, 80), 1);
});

test('redrawLine erases a 1-row line with \\r\\x1b[2K, and each row above it with \\x1b[A\\x1b[2K, then writes the new line', () => {
  assert.equal(redrawLine(1, '> ab'), '\r\x1b[2K> ab');
  assert.equal(redrawLine(3, '> '), '\r\x1b[2K\x1b[A\x1b[2K\x1b[A\x1b[2K> ');
});
