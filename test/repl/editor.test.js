import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEditor } from '../../src/repl/editor.js';

test('backspace removes one grapheme: a whole ZWJ emoji, a letter with its combining accent, a flag', () => {
  const editor = createEditor();
  editor.insertText('x\u{1f469}‍\u{1f4bb}');
  editor.insertText('e');
  editor.insertText('́\u{1f1fa}\u{1f1f8}');
  editor.backspace();
  assert.equal(editor.echo(), 'x\u{1f469}‍\u{1f4bb}é');
  editor.backspace();
  assert.equal(editor.echo(), 'x\u{1f469}‍\u{1f4bb}');
  editor.backspace();
  assert.equal(editor.echo(), 'x');
  editor.backspace();
  assert.equal(editor.isEmpty(), true);
});
