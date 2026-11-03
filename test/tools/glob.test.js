import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createGlob } from '../../src/tools/glob.js';
import { ctxFor, gitAdd, gitInit, plant, setMtime, useTempDir } from './tmp-dir.js';

const glob = createGlob();

async function plainTree(t) {
  const dir = await useTempDir(t);
  await plant(dir, {
    'a.js': '',
    'b.ts': '',
    'c.md': '',
    'sub/d.js': '',
    'sub/deep/e.js': '',
    'node_modules/m.js': '',
    '.git/x.js': '',
  });
  await setMtime(join(dir, 'a.js'), 1000);
  await setMtime(join(dir, 'b.ts'), 2000);
  await setMtime(join(dir, 'c.md'), 3000);
  await setMtime(join(dir, 'sub/d.js'), 4000);
  await setMtime(join(dir, 'sub/deep/e.js'), 5000);
  return dir;
}

async function names(dir, input) {
  const result = await glob.run(input, ctxFor(dir));
  assert.equal(result.isError, false, result.content);
  return result.content.split('\n').map((line) => (line.startsWith(`${dir}/`) ? line.slice(dir.length + 1) : line));
}

test('*.js stays at the top level while **/*.js spans directories, newest first', async (t) => {
  const dir = await plainTree(t);
  assert.deepEqual(await names(dir, { pattern: '*.js' }), ['a.js']);
  assert.deepEqual(await names(dir, { pattern: '**/*.js' }), ['sub/deep/e.js', 'sub/d.js', 'a.js']);
});

test('mtime orders results newest first', async (t) => {
  const dir = await plainTree(t);
  await setMtime(join(dir, 'a.js'), 9000);
  assert.deepEqual(await names(dir, { pattern: '**/*.js' }), ['a.js', 'sub/deep/e.js', 'sub/d.js']);
});

test('braces, classes and ? are supported', async (t) => {
  const dir = await plainTree(t);
  assert.deepEqual(await names(dir, { pattern: '*.{js,ts}' }), ['b.ts', 'a.js']);
  assert.deepEqual(await names(dir, { pattern: '[ab].*' }), ['b.ts', 'a.js']);
  assert.deepEqual(await names(dir, { pattern: '?.md' }), ['c.md']);
  assert.deepEqual(await names(dir, { pattern: 'sub/**' }), ['sub/deep/e.js', 'sub/d.js']);
});

test('path narrows the root and a leading ./ is ignored', async (t) => {
  const dir = await plainTree(t);
  assert.deepEqual(await names(dir, { pattern: './*.js', path: 'sub' }), ['sub/d.js']);
});

test('no match is a plain result, not an error', async (t) => {
  const dir = await plainTree(t);
  assert.deepEqual(await glob.run({ pattern: '*.py' }, ctxFor(dir)), { content: 'No files matched', isError: false });
});

test('a missing or non-directory path is an error', async (t) => {
  const dir = await plainTree(t);
  const missing = await glob.run({ pattern: '*', path: 'nope' }, ctxFor(dir));
  const file = await glob.run({ pattern: '*', path: 'a.js' }, ctxFor(dir));
  assert.deepEqual(missing, { content: `File does not exist: ${join(dir, 'nope')}`, isError: true });
  assert.deepEqual(file, { content: `${join(dir, 'a.js')} is not a directory`, isError: true });
});

test('results are capped at 1000 with a note', async (t) => {
  const dir = await useTempDir(t);
  await plant(dir, Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`f${i}.txt`, ''])));
  const lines = (await glob.run({ pattern: '*.txt' }, ctxFor(dir))).content.split('\n');
  assert.equal(lines.length, 1001);
  assert.equal(lines[1000], '[clay: showing the 1000 newest of 1001 matches; narrow the pattern]');
});

test('inside a git work tree .gitignore is respected, also from a subdirectory', async (t) => {
  const dir = await useTempDir(t);
  gitInit(dir);
  await plant(dir, {
    '.gitignore': 'ignored.js\nbuild/\n',
    'tracked.js': '',
    'untracked.js': '',
    'ignored.js': '',
    'build/out.js': '',
    'pkg/inner.js': '',
    'pkg/ignored.js': '',
  });
  gitAdd(dir, 'tracked.js');
  await setMtime(join(dir, 'tracked.js'), 2000);
  await setMtime(join(dir, 'untracked.js'), 1000);
  await setMtime(join(dir, 'pkg/inner.js'), 3000);
  assert.deepEqual(await names(dir, { pattern: '**/*.js' }), ['pkg/inner.js', 'tracked.js', 'untracked.js']);
  assert.deepEqual(await names(dir, { pattern: '*.js', path: 'pkg' }), ['pkg/inner.js']);
});
