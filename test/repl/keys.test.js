import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyParser, PASTE_END, PASTE_START } from '../../src/repl/keys.js';

function parse(...chunks) {
  const parser = createKeyParser();
  return chunks.flatMap((chunk) => parser.feed(chunk));
}

function merged(tokens) {
  const out = [];
  for (const token of tokens) {
    const last = out.at(-1);
    if (token.type === 'text' && last?.type === 'text') last.text += token.text;
    else out.push({ ...token });
  }
  return out;
}

function splits(input) {
  const out = [];
  for (let i = 0; i <= input.length; i++) out.push([input.slice(0, i), input.slice(i)]);
  return out;
}

const text = (value) => ({ type: 'text', text: value });
const paste = (value) => ({ type: 'paste', text: value });
const ENTER = { type: 'enter' };
const BACKSPACE = { type: 'backspace' };
const ctrl = (key) => ({ type: 'ctrl', key });

test('printable runs, including UTF-8, are one text token; each control key is its own token', () => {
  assert.deepEqual(parse('héllo wörld 🙂 日本'), [text('héllo wörld 🙂 日本')]);
  assert.deepEqual(parse('ab\x7fc\x08d'), [text('ab'), BACKSPACE, text('c'), BACKSPACE, text('d')]);
  assert.deepEqual(parse('\x03\x04\x15\x17'), [ctrl('c'), ctrl('d'), ctrl('u'), ctrl('w')]);
});

test('\\r, \\n and \\r\\n are one enter each, also when \\r\\n is split across chunks', () => {
  assert.deepEqual(parse('a\rb\nc\r\nd'), [text('a'), ENTER, text('b'), ENTER, text('c'), ENTER, text('d')]);
  assert.deepEqual(parse('a\r', '\nb'), [text('a'), ENTER, text('b')]);
  assert.deepEqual(parse('\r\r'), [ENTER, ENTER]);
  assert.deepEqual(parse('\n\n'), [ENTER, ENTER]);
});

test('other control bytes and escape sequences outside a paste are dropped; ESC + other byte drops only the ESC', () => {
  assert.deepEqual(merged(parse('a\x01\x02\tb\x1b[Ac\x1b[1;5Dd\x1bOPe\x1b[?2004hf')), [text('abcdef')]);
  assert.deepEqual(merged(parse('\x1bx')), [text('x')]);
  assert.deepEqual(merged(parse('a\x1b[201~b')), [text('ab')]);
});

test('a bracketed paste is one token; \\r and \\r\\n become \\n, controls except \\n and \\t are dropped, ESC sequences kept out', () => {
  const input = `x${PASTE_START}l1\rl2\r\nl3\n\tt\x01\x7f\x1b[31mred\x1b[0m\x1bOP${PASTE_START}z${PASTE_END}\ry`;
  assert.deepEqual(parse(input), [text('x'), paste('l1\nl2\nl3\n\ttredz'), ENTER, text('y')]);
  assert.deepEqual(parse(`${PASTE_START}/clear${PASTE_END}`), [paste('/clear')]);
  assert.deepEqual(parse(`${PASTE_START}${PASTE_END}`), [paste('')]);
});

test('paste markers split at every byte offset give the same tokens', () => {
  const input = `ab${PASTE_START}one\rtwo${PASTE_END}\r`;
  const expected = [text('ab'), paste('one\ntwo'), ENTER];
  for (const [head, tail] of splits(input)) {
    assert.deepEqual(merged(parse(head, tail)), expected, JSON.stringify([head, tail]));
  }
  assert.deepEqual(merged(parse(...input)), expected);
});

test('a paste body split across chunks is held until the end marker', () => {
  const parser = createKeyParser();
  assert.deepEqual(parser.feed(`${PASTE_START}first line\r`), []);
  assert.deepEqual(parser.feed('second\r\n'), []);
  assert.deepEqual(parser.feed(`third${PASTE_END.slice(0, 3)}`), []);
  assert.deepEqual(parser.feed(`${PASTE_END.slice(3)}\r`), [paste('first line\nsecond\nthird'), ENTER]);
});

test('a lone ESC or an unfinished CSI or SS3 is held until the next feed', () => {
  const parser = createKeyParser();
  assert.deepEqual(parser.feed('a\x1b'), [text('a')]);
  assert.deepEqual(parser.feed('[1'), []);
  assert.deepEqual(parser.feed(';2Hb\x1bO'), [text('b')]);
  assert.deepEqual(parser.feed('Qc'), [text('c')]);
});
