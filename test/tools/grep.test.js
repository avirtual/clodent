import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createGrep } from '../../src/tools/grep.js';
import { ctxFor, gitAdd, gitInit, plant, useTempDir } from './tmp-dir.js';

const grep = createGrep();

async function plainTree(t) {
  const dir = await useTempDir(t);
  await plant(dir, {
    'a.js': 'const foo = 1;\nconst bar = 2;\n',
    'b.txt': 'Foo bar\nfoo\n',
    'sub/c.js': 'foo();\n',
    'node_modules/dep/index.js': 'foo\n',
    '.git/config': 'foo\n',
    'bin.dat': Buffer.concat([Buffer.from('foo'), Buffer.from([0]), Buffer.from('foo')]),
  });
  return dir;
}

test('files_with_matches is the default, sorted, skipping node_modules, .git and binaries', async (t) => {
  const dir = await plainTree(t);
  const result = await grep.run({ pattern: 'foo' }, ctxFor(dir));
  assert.deepEqual(result, { content: ['a.js', 'b.txt', 'sub/c.js'].map((f) => join(dir, f)).join('\n'), isError: false });
});

test('content mode prints path:line:text, filtered by a basename glob', async (t) => {
  const dir = await plainTree(t);
  const result = await grep.run({ pattern: 'foo', output_mode: 'content', glob: '*.js' }, ctxFor(dir));
  assert.equal(result.content, `${join(dir, 'a.js')}:1:const foo = 1;\n${join(dir, 'sub/c.js')}:1:foo();`);
});

test('a glob containing / matches the relative path', async (t) => {
  const dir = await plainTree(t);
  const result = await grep.run({ pattern: 'foo', glob: 'sub/*.js' }, ctxFor(dir));
  assert.equal(result.content, join(dir, 'sub/c.js'));
});

test('count mode prints path:n and ignore_case widens the match', async (t) => {
  const dir = await plainTree(t);
  const strict = await grep.run({ pattern: 'foo', output_mode: 'count', path: 'b.txt' }, ctxFor(dir));
  const loose = await grep.run({ pattern: 'FOO', output_mode: 'count', path: 'b.txt', ignore_case: true }, ctxFor(dir));
  assert.equal(strict.content, `${join(dir, 'b.txt')}:1`);
  assert.equal(loose.content, `${join(dir, 'b.txt')}:2`);
});

test('no match is a plain result, not an error', async (t) => {
  const dir = await plainTree(t);
  assert.deepEqual(await grep.run({ pattern: 'FOO' }, ctxFor(dir)), { content: 'No matches found', isError: false });
});

test('an invalid regex is an error carrying the SyntaxError message', async (t) => {
  const dir = await plainTree(t);
  let message;
  try {
    new RegExp('(');
  } catch (err) {
    message = err.message;
  }
  assert.deepEqual(await grep.run({ pattern: '(' }, ctxFor(dir)), { content: message, isError: true });
});

test('a malformed glob is an error naming the glob, not the path', async (t) => {
  const dir = await plainTree(t);
  const result = await grep.run({ pattern: 'foo', glob: '[z-a]' }, ctxFor(dir));
  assert.equal(result.isError, true);
  assert.match(result.content, /^Invalid glob \[z-a\]: /);
});

test('an abort during listing is an error, not an empty result', async (t) => {
  const dir = await plainTree(t);
  const result = await grep.run({ pattern: 'foo' }, ctxFor(dir, { signal: AbortSignal.abort() }));
  assert.deepEqual(result, { content: 'Search aborted', isError: true });
});

test('a missing path is an error', async (t) => {
  const dir = await plainTree(t);
  const result = await grep.run({ pattern: 'foo', path: 'missing' }, ctxFor(dir));
  assert.deepEqual(result, { content: `File does not exist: ${join(dir, 'missing')}`, isError: true });
});

test('an unknown output_mode is an error', async (t) => {
  const dir = await plainTree(t);
  const result = await grep.run({ pattern: 'foo', output_mode: 'lines' }, ctxFor(dir));
  assert.equal(result.isError, true);
});

test('head_limit cuts the output and says so', async (t) => {
  const dir = await useTempDir(t);
  await plant(dir, { 'many.txt': 'hit\n'.repeat(10) });
  const result = await grep.run({ pattern: 'hit', output_mode: 'content', head_limit: 3 }, ctxFor(dir));
  const lines = result.content.split('\n');
  assert.deepEqual(lines.slice(0, 3), [1, 2, 3].map((n) => `${join(dir, 'many.txt')}:${n}:hit`));
  assert.equal(lines[3], '[clay: showing the first 3 of 10 lines; raise head_limit to see more]');
  assert.equal(lines.length, 4);
});

test('head_limit defaults to 250 lines', async (t) => {
  const dir = await useTempDir(t);
  await plant(dir, { 'many.txt': 'hit\n'.repeat(300) });
  const lines = (await grep.run({ pattern: 'hit', output_mode: 'content' }, ctxFor(dir))).content.split('\n');
  assert.equal(lines.length, 251);
  assert.equal(lines[250], '[clay: showing the first 250 of 300 lines; raise head_limit to see more]');
});

test('CRLF line endings do not reach the regex or the output', async (t) => {
  const dir = await useTempDir(t);
  await plant(dir, { 'crlf.txt': 'foo\r\nbar\r\n' });
  const result = await grep.run({ pattern: 'foo$', output_mode: 'content' }, ctxFor(dir));
  assert.equal(result.content, `${join(dir, 'crlf.txt')}:1:foo`);
});

test('inside a git work tree .gitignore is respected and untracked files are searched', async (t) => {
  const dir = await useTempDir(t);
  gitInit(dir);
  await plant(dir, {
    '.gitignore': 'ignored.js\nbuild/\n',
    'tracked.js': 'foo\n',
    'untracked.js': 'foo\n',
    'ignored.js': 'foo\n',
    'build/out.js': 'foo\n',
  });
  gitAdd(dir, 'tracked.js');
  const result = await grep.run({ pattern: 'foo' }, ctxFor(dir));
  assert.equal(result.content, [join(dir, 'tracked.js'), join(dir, 'untracked.js')].join('\n'));
});

test('a path that is itself git-ignored is searched by walking it', async (t) => {
  const dir = await useTempDir(t);
  gitInit(dir);
  await plant(dir, {
    '.gitignore': 'node_modules/\n',
    'src/a.js': 'foo\n',
    'node_modules/pkg/index.js': 'foo\n',
    'node_modules/pkg/lib/util.js': 'foo\n',
  });
  const result = await grep.run({ pattern: 'foo', path: 'node_modules/pkg' }, ctxFor(dir));
  assert.equal(result.content, [join(dir, 'node_modules/pkg/index.js'), join(dir, 'node_modules/pkg/lib/util.js')].join('\n'));
  const top = await grep.run({ pattern: 'foo' }, ctxFor(dir));
  assert.equal(top.content, join(dir, 'src/a.js'));
});
