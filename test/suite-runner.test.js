import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover, parseArgs } from '../scripts/suite-runner.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('parseArgs defaults to test/ under the repo root, not cwd', () => {
  assert.deepEqual(parseArgs([], '/c', '/r'), { dir: '/r/test', files: [] });
});

test('parseArgs resolves --dir and file arguments against cwd', () => {
  assert.deepEqual(parseArgs(['--dir', 'x/y'], '/c', '/r'), { dir: '/c/x/y', files: [] });
  assert.deepEqual(parseArgs(['--reporter=dot', 'a.test.js'], '/c', '/r'), { dir: '/r/test', files: ['/c/a.test.js'] });
});

test('parseArgs rejects an unknown option and a --dir without a path', () => {
  assert.equal(parseArgs(['--bogus'], '/c', '/r').error, 'unknown option --bogus');
  assert.equal(parseArgs(['--dir'], '/c', '/r').error, '--dir needs a path');
});

test('discover finds the suite under test/ and skips fixtures', () => {
  const files = discover(path.join(ROOT, 'test'));
  assert.ok(files.includes(path.join(ROOT, 'test', 'run-tests.test.js')));
  assert.ok(files.every((file) => !file.includes(`${path.sep}fixtures${path.sep}`)), files.join('\n'));
  assert.deepEqual(files, [...files].sort());
});

test('discover throws on a directory that does not exist', () => {
  assert.throws(() => discover(path.join(ROOT, 'test', 'no-such-dir')), { code: 'ENOENT' });
});
