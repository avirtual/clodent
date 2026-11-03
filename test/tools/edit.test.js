import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEdit } from '../../src/tools/edit.js';
import { ctxFor, useTempDir } from './tmp-dir.js';

const edit = createEdit();

async function fileWith(t, content) {
  const dir = await useTempDir(t);
  const path = join(dir, 'f.txt');
  await writeFile(path, content);
  return { dir, path };
}

test('replaces a unique match', async (t) => {
  const { dir, path } = await fileWith(t, 'alpha beta gamma\n');
  const result = await edit.run({ file_path: 'f.txt', old_string: 'beta', new_string: 'BETA' }, ctxFor(dir));
  assert.deepEqual(result, { content: `Edited ${path}: 1 replacement(s)`, isError: false });
  assert.equal(await readFile(path, 'utf8'), 'alpha BETA gamma\n');
});

test('replace_all replaces every match and counts them', async (t) => {
  const { dir, path } = await fileWith(t, 'x-x-x');
  const result = await edit.run({ file_path: path, old_string: 'x', new_string: 'yy', replace_all: true }, ctxFor(dir));
  assert.equal(result.content, `Edited ${path}: 3 replacement(s)`);
  assert.equal(await readFile(path, 'utf8'), 'yy-yy-yy');
});

test('more than one match without replace_all is an error that says how many', async (t) => {
  const { dir, path } = await fileWith(t, 'x-x-x');
  const result = await edit.run({ file_path: path, old_string: 'x', new_string: 'y' }, ctxFor(dir));
  assert.equal(result.isError, true);
  assert.match(result.content, /matches 3 times/);
  assert.equal(await readFile(path, 'utf8'), 'x-x-x');
});

test('a missing file is an error', async (t) => {
  const { dir } = await fileWith(t, '');
  const result = await edit.run({ file_path: 'nope.txt', old_string: 'a', new_string: 'b' }, ctxFor(dir));
  assert.deepEqual(result, { content: `File does not exist: ${join(dir, 'nope.txt')}`, isError: true });
});

test('an empty old_string is an error', async (t) => {
  const { dir } = await fileWith(t, 'abc');
  const result = await edit.run({ file_path: 'f.txt', old_string: '', new_string: 'b' }, ctxFor(dir));
  assert.deepEqual(result, { content: 'old_string is empty', isError: true });
});

test('old_string equal to new_string is an error', async (t) => {
  const { dir } = await fileWith(t, 'abc');
  const result = await edit.run({ file_path: 'f.txt', old_string: 'b', new_string: 'b' }, ctxFor(dir));
  assert.equal(result.isError, true);
  assert.match(result.content, /identical/);
});

test('old_string not found is an error', async (t) => {
  const { dir, path } = await fileWith(t, 'abc');
  const result = await edit.run({ file_path: 'f.txt', old_string: 'zzz', new_string: 'b' }, ctxFor(dir));
  assert.deepEqual(result, { content: `old_string not found in ${path}`, isError: true });
});

test('a CRLF file stays byte-identical outside the replacement', async (t) => {
  const { dir, path } = await fileWith(t, 'line1\r\nfoo\r\nline3\r\n');
  await edit.run({ file_path: 'f.txt', old_string: 'foo', new_string: 'bar' }, ctxFor(dir));
  assert.deepEqual(await readFile(path), Buffer.from('line1\r\nbar\r\nline3\r\n'));
});

test('a file without a trailing newline keeps none', async (t) => {
  const { dir, path } = await fileWith(t, 'a\nfoo');
  await edit.run({ file_path: 'f.txt', old_string: 'foo', new_string: 'bar' }, ctxFor(dir));
  assert.equal(await readFile(path, 'utf8'), 'a\nbar');
});

test('non-UTF-8 bytes elsewhere in the file survive', async (t) => {
  const original = Buffer.concat([Buffer.from([0xff, 0xfe, 0x80]), Buffer.from('naïve foo'), Buffer.from([0xc3])]);
  const { dir, path } = await fileWith(t, original);
  await edit.run({ file_path: 'f.txt', old_string: 'naïve foo', new_string: 'naïve bar' }, ctxFor(dir));
  const expected = Buffer.concat([Buffer.from([0xff, 0xfe, 0x80]), Buffer.from('naïve bar'), Buffer.from([0xc3])]);
  assert.deepEqual(await readFile(path), expected);
});

test('replacement text is literal, not a regex replacement pattern', async (t) => {
  const { dir, path } = await fileWith(t, 'a.b');
  await edit.run({ file_path: 'f.txt', old_string: '.', new_string: "$&$'" }, ctxFor(dir));
  assert.equal(await readFile(path, 'utf8'), "a$&$'b");
});
