import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redrawLine } from '../../src/repl/repl.js';
import { cellWidth, clipRows, graphemes, linesRows, rowsOf, wrapWords } from '../../src/repl/width.js';

const ZWJ_CODER = '\u{1f469}\u200d\u{1f4bb}';
const E_ACUTE = 'e\u0301';

test('cellWidth counts graphemes as Unicode 6 xterm.js does: ASCII and single emoji 1, CJK, fullwidth and multi-code-point emoji 2, combining marks 0', () => {
  assert.equal(cellWidth('hello'), 5);
  assert.equal(cellWidth('日本語'), 6);
  assert.equal(cellWidth('한국'), 4);
  assert.equal(cellWidth('Ａ'), 2);
  assert.equal(cellWidth(ZWJ_CODER), 2);
  assert.equal(cellWidth('\u{1f44d}\u{1f3fd}'), 2);
  assert.equal(cellWidth('\u{1f1fa}\u{1f1f8}'), 2);
  assert.equal(cellWidth('❤\ufe0f'), 1);
  assert.equal(cellWidth('❤'), 1);
  assert.equal(cellWidth('✅'), 1);
  assert.equal(cellWidth('⚠\ufe0f'), 1);
  assert.equal(cellWidth('\u{1f916}'), 1);
  assert.equal(cellWidth('1\ufe0f\u20e3'), 1);
  assert.equal(cellWidth('\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}'), 1);
  assert.equal(cellWidth('\u3030\ufe0f'), 2);
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
  assert.equal(rowsOf('\u{1f916}'.repeat(80), 80), 1);
  assert.equal(rowsOf('\u{1f916}'.repeat(81), 80), 2);
  assert.equal(rowsOf(`${ZWJ_CODER.repeat(40)}${E_ACUTE}`, 80), 2);
  assert.equal(rowsOf(`${'x'.repeat(79)}\u0301`, 80), 1);
});

test('rowsOf moves a tab to the next stop of 8, never past the last column', () => {
  assert.equal(rowsOf(`${'x'.repeat(75)}\tyy`, 80), 2);
  assert.equal(rowsOf(`${'\t'.repeat(20)}y`, 80), 1);
});

test('redrawLine erases a 1-row line with \\r\\x1b[2K, and each row above it with \\x1b[A\\x1b[2K, then writes the new line', () => {
  assert.equal(redrawLine(1, '> ab'), '\r\x1b[2K> ab');
  assert.equal(redrawLine(3, '> '), '\r\x1b[2K\x1b[A\x1b[2K\x1b[A\x1b[2K> ');
});

test('cellWidth counts as 1 cell the blocks xterm.js draws narrow: enclosed ideographs, Tangut, kana supplement, ideographic symbols and Hangul Jamo Extended-A', () => {
  for (const char of ['\u{1f201}', '\u{1f250}', '\u{1f265}', '\u{16fe0}', '\u{17000}', '\u{18cff}', '\u{1b000}', '\u{1b2ff}', '\ua960', '\ua97f']) {
    assert.equal(cellWidth(char), 1, char.codePointAt(0).toString(16));
  }
  assert.equal(cellWidth('中あ한Ａ'), 8);
});

test('linesRows adds up the rows of each line of a text, a trailing line end counting the row the cursor is left on', () => {
  assert.equal(linesRows('abc', 80), 1);
  assert.equal(linesRows('abc\n', 80), 2);
  assert.equal(linesRows(`${'x'.repeat(81)}\nab`, 80), 3);
  assert.equal(linesRows('x'.repeat(80), 80), 1);
});

test('wrapWords breaks at the last space that fits, keeps a leading indent, and leaves a word wider than the width whole on its row', () => {
  assert.equal(wrapWords('one two three', 7), 'one two\nthree');
  assert.equal(wrapWords('  ✗ alpha beta', 10), '  ✗ alpha\nbeta');
  assert.equal(wrapWords('a /very/long/path/here b', 6), 'a\n/very/long/path/here\nb');
  assert.equal(wrapWords('fits exactly', 12), 'fits exactly');
  assert.equal(wrapWords('x  y', 1), 'x\ny');
  assert.equal(wrapWords('first\nsecond line', 6), 'first\nsecond\nline');
  assert.equal(wrapWords('日本 語', 4), '日本\n語');
});

test('clipRows keeps a text that fits and cuts a longer one to the rows given, ending in … within the last row', () => {
  assert.equal(clipRows('short', 10, 3), 'short');
  assert.equal(clipRows('x'.repeat(30), 10, 3), 'x'.repeat(30));
  assert.equal(clipRows('x'.repeat(31), 10, 3), `${'x'.repeat(29)}…`);
  assert.equal(clipRows('ab中cd', 3, 1), 'ab…');
  assert.equal(rowsOf(clipRows('中'.repeat(40), 9, 2), 9), 2);
});
