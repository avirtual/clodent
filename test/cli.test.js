import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';

function fakeDeps() {
  const out = [];
  const err = [];
  const deps = {
    stdout: { write: (chunk) => out.push(chunk) },
    stderr: { write: (chunk) => err.push(chunk) },
    env: {},
    cwd: tmpdir(),
  };
  return { deps, stdout: () => out.join(''), stderr: () => err.join('') };
}

test('--version prints the package version and returns 0', async () => {
  const fake = fakeDeps();
  assert.equal(await main(['--version'], fake.deps), 0);
  assert.equal(fake.stdout(), 'clay 0.0.1\n');
  assert.equal(fake.stderr(), '');
});

test('--help prints usage and returns 0', async () => {
  const fake = fakeDeps();
  assert.equal(await main(['--help'], fake.deps), 0);
  assert.match(fake.stdout(), /^usage: clay/);
  assert.equal(fake.stderr(), '');
});

test('an unknown argument returns 1 with a message on stderr', async () => {
  const fake = fakeDeps();
  assert.equal(await main(['--frobnicate'], fake.deps), 1);
  assert.equal(fake.stdout(), '');
  assert.equal(fake.stderr(), 'clay: not implemented yet\n');
});

test('bin/clay.js --version runs from any cwd', () => {
  const bin = fileURLToPath(new URL('../bin/clay.js', import.meta.url));
  const res = spawnSync(process.execPath, [bin, '--version'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'clay 0.0.1\n');
});
