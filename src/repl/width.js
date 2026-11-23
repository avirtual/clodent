const WIDE = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f200, 0x1f265],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];
const ZERO_WIDTH = /^[\p{M}\u200b-\u200f\u2060-\u2064\ufeff]+$/u;
const EMOJI = /^\p{Emoji_Presentation}/u;
const EMOJI_BASE = /^\p{Emoji}/u;
const TAB_STOP = 8;

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function graphemes(text) {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

function isWide(cp) {
  return cp >= 0x1100 && WIDE.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function graphemeWidth(grapheme) {
  const cp = grapheme.codePointAt(0);
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || ZERO_WIDTH.test(grapheme)) return 0;
  if (EMOJI.test(grapheme) || (grapheme.includes('\ufe0f') && EMOJI_BASE.test(grapheme))) return 2;
  return isWide(cp) ? 2 : 1;
}

export function cellWidth(text) {
  return graphemes(text).reduce((cells, grapheme) => cells + graphemeWidth(grapheme), 0);
}

export function rowsOf(text, cols) {
  let row = 0;
  let col = 0;
  for (const grapheme of graphemes(text)) {
    if (grapheme === '\t') {
      col = Math.max(col, Math.min(cols - 1, col - (col % TAB_STOP) + TAB_STOP));
      continue;
    }
    const cells = graphemeWidth(grapheme);
    if (cells === 0) continue;
    if (col + cells > cols) {
      row += 1;
      col = 0;
    }
    col += cells;
  }
  return row + 1;
}
