const WIDE = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];
const ZERO_WIDTH = /^[\p{M}\u200b-\u200f\u2060-\u2064\ufeff]+$/u;
const EMOJI = /^\p{Emoji_Presentation}/u;
const EMOJI_BASE = /^\p{Emoji}/u;
const NOT_SPACING = /[\p{M}\p{Cf}]/gu;
const TAB_STOP = 8;

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function graphemes(text) {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

function isWide(cp) {
  return cp >= 0x1100 && WIDE.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function isEmoji(grapheme) {
  return EMOJI.test(grapheme) || (grapheme.includes('\ufe0f') && EMOJI_BASE.test(grapheme));
}

function graphemeWidth(grapheme) {
  const cp = grapheme.codePointAt(0);
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || ZERO_WIDTH.test(grapheme)) return 0;
  if (isWide(cp)) return 2;
  return isEmoji(grapheme) && [...grapheme.replace(NOT_SPACING, '')].length > 1 ? 2 : 1;
}

export function cellWidth(text) {
  return graphemes(text).reduce((cells, grapheme) => cells + graphemeWidth(grapheme), 0);
}

function place(cursor, grapheme, cols) {
  if (grapheme === '\t') {
    cursor.col = Math.max(cursor.col, Math.min(cols - 1, cursor.col - (cursor.col % TAB_STOP) + TAB_STOP));
    return;
  }
  const cells = graphemeWidth(grapheme);
  if (cells === 0) return;
  if (cursor.col + cells > cols) {
    cursor.row += 1;
    cursor.col = 0;
  }
  cursor.col += cells;
}

export function rowsOf(text, cols) {
  const cursor = { row: 0, col: 0 };
  for (const grapheme of graphemes(text)) place(cursor, grapheme, cols);
  return cursor.row + 1;
}

export function linesRows(text, cols) {
  return text.split('\n').reduce((rows, part) => rows + rowsOf(part, cols), 0);
}

export function clipRows(text, cols, maxRows) {
  if (rowsOf(text, cols) <= maxRows) return text;
  const cursor = { row: 0, col: 0 };
  let kept = '';
  for (const grapheme of graphemes(text)) {
    place(cursor, grapheme, cols);
    if (cursor.row > maxRows - 1 || (cursor.row === maxRows - 1 && cursor.col + 1 > cols)) break;
    kept += grapheme;
  }
  return `${kept}…`;
}

export function wrapWords(text, cols) {
  const rows = [];
  for (const part of text.split('\n')) {
    let row = null;
    for (const word of part.split(' ')) {
      if (row === null) {
        row = word;
      } else if (cellWidth(`${row} ${word}`) <= cols) {
        row = `${row} ${word}`;
      } else {
        rows.push(row.trimEnd());
        row = word === '' ? null : word;
      }
    }
    rows.push(row ?? '');
  }
  return rows.join('\n');
}
