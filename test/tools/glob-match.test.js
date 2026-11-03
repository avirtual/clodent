import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandBraces, globToRegExp } from '../../src/tools/glob-match.js';

function check(glob, yes, no) {
  const regex = globToRegExp(glob);
  for (const path of yes) assert.ok(regex.test(path), `${glob} should match ${path}`);
  for (const path of no) assert.ok(!regex.test(path), `${glob} should not match ${path}`);
}

test('* and ? never cross /', () => {
  check('*.js', ['a.js', '.js'], ['sub/a.js', 'a.jsx']);
  check('src/?.js', ['src/a.js'], ['src/ab.js', 'src//.js', 'src/a/b.js']);
});

test('** spans zero or more directories', () => {
  check('**/*.js', ['a.js', 'x/a.js', 'x/y/z/a.js'], ['a.ts']);
  check('a/**/b.js', ['a/b.js', 'a/x/b.js', 'a/x/y/b.js'], ['ab.js', 'a/xb.js']);
  check('a/**', ['a/b', 'a/b/c'], ['a', 'ab/c']);
  check('**', ['a', 'a/b/c'], []);
  check('a**b', ['ab', 'axxb'], ['a/b']);
});

test('braces expand, nested too', () => {
  assert.deepEqual(expandBraces('*.{js,ts}'), ['*.js', '*.ts']);
  assert.deepEqual(expandBraces('{a,{b,c}}.txt'), ['a.txt', 'b.txt', 'c.txt']);
  check('{src,test}/**/*.{js,mjs}', ['src/a.js', 'test/x/b.mjs'], ['lib/a.js', 'src/a.ts']);
  check('{a}.js', ['{a}.js'], ['a.js']);
  check('{a,b.js', ['{a,b.js'], ['a']);
});

test('character classes, ranges and negation', () => {
  check('[abc].js', ['a.js', 'c.js'], ['d.js', 'ab.js']);
  check('[a-c]x', ['bx'], ['dx']);
  check('[!a]x', ['bx'], ['ax', '/x']);
  check('[x', ['[x'], ['x']);
});

test('regex metacharacters are literal', () => {
  check('a.b+c(d)|e$', ['a.b+c(d)|e$'], ['axbbc(d)|e$']);
  check('\\*.js', ['*.js'], ['a.js']);
});
