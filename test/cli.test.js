import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FLAGS } from '../src/args.js';
import { main, NOT_YET } from '../src/cli.js';

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

async function run(argv) {
  const fake = fakeDeps();
  const code = await main(argv, fake.deps);
  return { code, stdout: fake.stdout(), stderr: fake.stderr() };
}

test('--version prints the package version and returns 0', async () => {
  assert.deepEqual(await run(['--version']), { code: 0, stdout: 'clay 0.0.1\n', stderr: '' });
  assert.deepEqual(await run(['-v']), { code: 0, stdout: 'clay 0.0.1\n', stderr: '' });
});

test('--help prints usage and returns 0', async () => {
  const res = await run(['--help']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /^usage: clay/);
  assert.equal(res.stderr, '');
  assert.equal((await run(['-h'])).stdout, res.stdout);
});

test('--help lists every flag with a description and marks the unimplemented ones', async () => {
  const { stdout } = await run(['--help']);
  for (const flag of FLAGS) {
    const names = flag.short ? `-${flag.short}, --${flag.long}` : `--${flag.long}`;
    const label = flag.arg ? `${names} <${flag.arg}>` : names;
    const line = stdout.split('\n').find((l) => l.trimStart().startsWith(`${label} `));
    assert.ok(line, `no help line for ${label}`);
    assert.ok(line.includes(flag.help), `help line for ${label} lacks its description`);
    assert.equal(line.endsWith('(not implemented yet)'), NOT_YET.has(flag.long), line);
  }
});

test('--help and --version win over flags that are not implemented yet', async () => {
  assert.equal((await run(['--yolo', '--help'])).code, 0);
  assert.equal((await run(['--model', 'x', '--version'])).stdout, 'clay 0.0.1\n');
});

test('a parse error prints the error and a pointer to --help, and returns 2', async () => {
  assert.deepEqual(await run(['--frobnicate']), {
    code: 2,
    stdout: '',
    stderr: 'clay: unknown option: --frobnicate\nclay: see --help\n',
  });
  assert.deepEqual(await run(['--effort', 'max']), {
    code: 2,
    stdout: '',
    stderr: 'clay: --effort must be low, medium or high, got "max"\nclay: see --help\n',
  });
  assert.equal((await run(['fix it'])).code, 2);
});

test('NOT_YET names only real flags and never --version or --help', () => {
  const names = new Set(FLAGS.map((f) => f.long));
  for (const name of NOT_YET) assert.ok(names.has(name), name);
  assert.equal(NOT_YET.has('version'), false);
  assert.equal(NOT_YET.has('help'), false);
});

test('a flag that is not implemented yet is refused with exit 2', async () => {
  assert.deepEqual(await run(['--model', 'x']), {
    code: 2,
    stdout: '',
    stderr: 'clay: --model is not implemented yet\n',
  });
  assert.deepEqual(await run(['--add-dir', '/a', '-p', 'go']), {
    code: 2,
    stdout: '',
    stderr: 'clay: --print is not implemented yet\nclay: --add-dir is not implemented yet\n',
  });
});

test('valid arguments with nothing to run return 1 with a message on stderr', async () => {
  assert.deepEqual(await run([]), { code: 1, stdout: '', stderr: 'clay: not implemented yet\n' });
});

test('bin/clay.js --version runs from any cwd', () => {
  const bin = fileURLToPath(new URL('../bin/clay.js', import.meta.url));
  const res = spawnSync(process.execPath, [bin, '--version'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'clay 0.0.1\n');
});

test('bin/clay.js exits 2 on a parse error', () => {
  const bin = fileURLToPath(new URL('../bin/clay.js', import.meta.url));
  const res = spawnSync(process.execPath, [bin, '--frobnicate'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.equal(res.stderr, 'clay: unknown option: --frobnicate\nclay: see --help\n');
});
