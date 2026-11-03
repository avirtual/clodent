import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWrite } from '../../src/tools/write.js';
import { ctxFor, useTempDir } from './tmp-dir.js';

const write = createWrite();

test('creates parent directories and reports the byte count', async (t) => {
  const dir = await useTempDir(t);
  const result = await write.run({ file_path: 'a/b/c.txt', content: 'hello' }, ctxFor(dir));
  const path = join(dir, 'a/b/c.txt');
  assert.deepEqual(result, { content: `Wrote 5 bytes to ${path}`, isError: false });
  assert.equal(await readFile(path, 'utf8'), 'hello');
});

test('overwrites an existing file', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 'f.txt');
  await writeFile(path, 'old content that is longer');
  await write.run({ file_path: path, content: 'new' }, ctxFor(dir));
  assert.equal(await readFile(path, 'utf8'), 'new');
});

test('counts bytes, not characters', async (t) => {
  const dir = await useTempDir(t);
  const result = await write.run({ file_path: 'u.txt', content: 'é😀' }, ctxFor(dir));
  assert.match(result.content, /^Wrote 6 bytes to /);
});

test('writing over a directory is an error, not a throw', async (t) => {
  const dir = await useTempDir(t);
  await mkdir(join(dir, 'sub'));
  const result = await write.run({ file_path: 'sub', content: 'x' }, ctxFor(dir));
  assert.equal(result.isError, true);
  assert.match(result.content, /^Cannot write /);
});

test('missing content is an error', async (t) => {
  const dir = await useTempDir(t);
  const result = await write.run({ file_path: 'f.txt' }, ctxFor(dir));
  assert.deepEqual(result, { content: 'content must be a string', isError: true });
});
