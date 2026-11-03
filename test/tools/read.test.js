import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRead } from '../../src/tools/read.js';
import { ctxFor, useTempDir } from './tmp-dir.js';

const read = createRead();

test('lines come back cat -n style', async (t) => {
  const dir = await useTempDir(t);
  await writeFile(join(dir, 'f.txt'), 'one\ntwo\n');
  const result = await read.run({ file_path: join(dir, 'f.txt') }, ctxFor(dir));
  assert.deepEqual(result, { content: '     1\tone\n     2\ttwo', isError: false });
});

test('a relative path resolves against ctx.cwd', async (t) => {
  const dir = await useTempDir(t);
  await writeFile(join(dir, 'f.txt'), 'x');
  const result = await read.run({ file_path: 'f.txt' }, ctxFor(dir));
  assert.deepEqual(result, { content: '     1\tx', isError: false });
});

test('offset is a 1-based line and limit counts lines', async (t) => {
  const dir = await useTempDir(t);
  await writeFile(join(dir, 'f.txt'), Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n'));
  const result = await read.run({ file_path: 'f.txt', offset: 3, limit: 2 }, ctxFor(dir));
  assert.equal(result.content, '     3\tL3\n     4\tL4');
});

test('limit defaults to 2000 lines', async (t) => {
  const dir = await useTempDir(t);
  await writeFile(join(dir, 'f.txt'), 'x\n'.repeat(2500));
  const lines = (await read.run({ file_path: 'f.txt' }, ctxFor(dir))).content.split('\n');
  assert.equal(lines.length, 2000);
  assert.equal(lines.at(-1), '  2000\tx');
});

test('a line over 2000 chars is cut with an ellipsis', async (t) => {
  const dir = await useTempDir(t);
  await writeFile(join(dir, 'f.txt'), `${'a'.repeat(2500)}\nshort\n`);
  const result = await read.run({ file_path: 'f.txt' }, ctxFor(dir));
  assert.equal(result.content, `     1\t${'a'.repeat(2000)}…\n     2\tshort`);
});

test('a missing file is an error', async (t) => {
  const dir = await useTempDir(t);
  const result = await read.run({ file_path: 'nope.txt' }, ctxFor(dir));
  assert.deepEqual(result, { content: `File does not exist: ${join(dir, 'nope.txt')}`, isError: true });
});

test('a directory is an error', async (t) => {
  const dir = await useTempDir(t);
  await mkdir(join(dir, 'sub'));
  const result = await read.run({ file_path: 'sub' }, ctxFor(dir));
  assert.equal(result.isError, true);
  assert.match(result.content, /is a directory/);
});

test('a device or other non-regular file is an error', async (t) => {
  const dir = await useTempDir(t);
  const result = await read.run({ file_path: '/dev/null' }, ctxFor(dir));
  assert.deepEqual(result, { content: '/dev/null is not a regular file', isError: true });
});

test('a binary file (NUL in the first 8 KiB) is an error', async (t) => {
  const dir = await useTempDir(t);
  await writeFile(join(dir, 'b.bin'), Buffer.concat([Buffer.from('a'.repeat(8000)), Buffer.from([0]), Buffer.from('tail')]));
  const result = await read.run({ file_path: 'b.bin' }, ctxFor(dir));
  assert.equal(result.isError, true);
  assert.match(result.content, /binary/);
});

test('a NUL after the first 8 KiB does not make the file binary', async (t) => {
  const dir = await useTempDir(t);
  await writeFile(join(dir, 'late.txt'), Buffer.concat([Buffer.from('a'.repeat(8192)), Buffer.from([0])]));
  const result = await read.run({ file_path: 'late.txt' }, ctxFor(dir));
  assert.equal(result.isError, false);
});

test('an offset past EOF is an error', async (t) => {
  const dir = await useTempDir(t);
  await writeFile(join(dir, 'f.txt'), 'a\nb\nc\n');
  const result = await read.run({ file_path: 'f.txt', offset: 4 }, ctxFor(dir));
  assert.equal(result.isError, true);
  assert.match(result.content, /offset 4 is past the end .* \(3 lines\)/);
});

test('an empty file returns a note saying it is empty', async (t) => {
  const dir = await useTempDir(t);
  await writeFile(join(dir, 'e.txt'), '');
  const result = await read.run({ file_path: 'e.txt' }, ctxFor(dir));
  assert.deepEqual(result, { content: `${join(dir, 'e.txt')} is empty (0 bytes)`, isError: false });
});

test('a non-string file_path is an error, not a throw', async (t) => {
  const dir = await useTempDir(t);
  const result = await read.run({ file_path: 42 }, ctxFor(dir));
  assert.deepEqual(result, { content: 'file_path must be a string', isError: true });
});
