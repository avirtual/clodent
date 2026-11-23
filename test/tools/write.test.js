import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RESULT_MAX_BYTES, capResult } from '../../src/tools/cap.js';
import { createWrite } from '../../src/tools/write.js';
import { ctxFor, useTempDir } from './tmp-dir.js';

const write = createWrite();

test('creates parent directories and reports the byte count', async (t) => {
  const dir = await useTempDir(t);
  const result = await write.run({ file_path: 'a/b/c.txt', content: 'hello' }, ctxFor(dir));
  const path = join(dir, 'a/b/c.txt');
  assert.deepEqual(result, { content: `Wrote 5 bytes to ${path}`, isError: false, structured: { type: 'create', filePath: path, content: 'hello', structuredPatch: [] } });
  assert.equal(await readFile(path, 'utf8'), 'hello');
});

test('overwrites an existing file', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 'f.txt');
  await writeFile(path, 'old content that is longer');
  const result = await write.run({ file_path: path, content: 'new' }, ctxFor(dir));
  assert.equal(await readFile(path, 'utf8'), 'new');
  assert.deepEqual(result.structured, {
    type: 'update',
    filePath: path,
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old content that is longer', '+new'] }],
  });
});

test('an update patch keeps three lines of context and splits hunks more than six lines apart', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 'f.txt');
  const old = Array.from({ length: 15 }, (_, i) => `L${i + 1}`);
  await writeFile(path, `${old.join('\n')}\n`);
  const next = old.map((line) => (line === 'L3' ? 'X3' : line === 'L13' ? 'X13' : line));
  next.splice(14, 0, 'added');
  const result = await write.run({ file_path: path, content: `${next.join('\n')}\n` }, ctxFor(dir));
  assert.deepEqual(result.structured.structuredPatch, [
    { oldStart: 1, oldLines: 6, newStart: 1, newLines: 6, lines: [' L1', ' L2', '-L3', '+X3', ' L4', ' L5', ' L6'] },
    { oldStart: 10, oldLines: 6, newStart: 10, newLines: 7, lines: [' L10', ' L11', ' L12', '-L13', '+X13', ' L14', '+added', ' L15'] },
  ]);
});

test('a created file records its content capped like a tool result, and an oversized update patch is empty', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 'big.txt');
  const big = 'x'.repeat(RESULT_MAX_BYTES + 10);
  const created = await write.run({ file_path: path, content: big }, ctxFor(dir));
  assert.deepEqual(created.structured, { type: 'create', filePath: path, content: capResult(big), structuredPatch: [] });
  const updated = await write.run({ file_path: path, content: 'y'.repeat(RESULT_MAX_BYTES + 10) }, ctxFor(dir));
  assert.deepEqual(updated.structured, { type: 'update', filePath: path, structuredPatch: [] });
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
