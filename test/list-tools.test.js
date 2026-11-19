import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { createTools } from '../src/tools/index.js';
import { createFakeFetch } from './helpers/fake-fetch.js';
import { useTempDir } from './tools/tmp-dir.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const BIN = fileURLToPath(new URL('../bin/clodent.js', import.meta.url));
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

async function run(argv, { env = {}, cwd, homedir = cwd, responses = [] } = {}) {
  const out = [];
  const err = [];
  const fetch = createFakeFetch(responses);
  const deps = {
    stdout: { write: (chunk) => out.push(chunk) },
    stderr: { write: (chunk) => err.push(chunk) },
    stdin: null,
    env,
    cwd,
    homedir,
    platform: 'darwin',
    fetch,
    sleep: async () => {},
    random: () => 0.5,
    now: () => 0,
    clock: () => new Date(2026, 10, 4),
    onSignal: () => () => {},
  };
  const code = await main(argv, deps);
  return { code, stdout: out.join(''), stderr: err.join(''), calls: fetch.calls };
}

function spawnBin(args, { env = {}, cwd }) {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

async function listing(t) {
  const cwd = await useTempDir(t);
  const res = await run(['--list-tools'], { cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, '');
  return res.stdout;
}

test('--list-tools prints one JSON line: v 1, the package version and the tools in createTools order', async (t) => {
  const stdout = await listing(t);
  assert.equal(stdout.indexOf('\n'), stdout.length - 1);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed), ['v', 'version', 'tools']);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.version, VERSION);
  assert.deepEqual(
    parsed.tools.map((tool) => tool.name),
    createTools().map((tool) => tool.name),
  );
});

test('--list-tools lists every createTools tool with exactly its name, kind, description and input_schema', async (t) => {
  const { tools } = JSON.parse(await listing(t));
  const built = createTools();
  assert.equal(tools.length, built.length);
  for (const [i, tool] of built.entries()) {
    assert.deepEqual(tools[i], { name: tool.name, kind: tool.kind, description: tool.description, input_schema: tool.input_schema });
  }
});

test('--list-tools entries match the tool definitions the agent sends to the API', async (t) => {
  const { tools } = JSON.parse(await listing(t));
  const cwd = await useTempDir(t);
  const res = await run(['-p', 'hi'], {
    cwd,
    env: { ANTHROPIC_API_KEY: 'sk-test', CLODENT_HOME: join(cwd, 'home') },
    responses: [{ body: 'text-only.sse' }],
  });
  assert.equal(res.code, 0, res.stderr);
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const sent = res.calls[0].body.tools.map(({ cache_control: _cache, ...definition }) => definition);
  assert.deepEqual(
    sent.sort(byName),
    tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })).sort(byName),
  );
});

test('every listed name is a host-safe identifier, unique, and there are 1 to 64 of them', async (t) => {
  const { tools } = JSON.parse(await listing(t));
  assert.ok(tools.length >= 1 && tools.length <= 64, String(tools.length));
  for (const { name } of tools) assert.match(name, NAME);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
});

test('--list-tools ignores every other flag and makes no request', async (t) => {
  const expected = await listing(t);
  const cwd = await useTempDir(t);
  const argvs = [
    ['--list-tools', '-p', 'hi'],
    ['-p', 'hi', '--output-format', 'stream-json', '--list-tools'],
    ['--list-tools', '--read-only', '--disallowedTools', 'Bash,WebSearch', '--model', 'x', '--effort', 'low'],
    ['--list-tools', '--yolo', '--add-dir', '/nowhere', '--system-prompt-file', '/nowhere/prompt.md'],
  ];
  for (const argv of argvs) {
    const res = await run(argv, { cwd, env: { ANTHROPIC_API_KEY: 'sk-test' } });
    assert.deepEqual({ code: res.code, stdout: res.stdout, stderr: res.stderr }, { code: 0, stdout: expected, stderr: '' }, argv.join(' '));
    assert.equal(res.calls.length, 0);
  }
});

test('--help and --version win over --list-tools', async (t) => {
  const cwd = await useTempDir(t);
  for (const argv of [['--list-tools', '--help'], ['-h', '--list-tools']]) {
    const res = await run(argv, { cwd });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /^usage: clodent/);
  }
  for (const argv of [['--list-tools', '--version'], ['-v', '--list-tools']]) {
    assert.deepEqual(await run(argv, { cwd }), { code: 0, stdout: `clodent ${VERSION}\n`, stderr: '', calls: [] });
  }
});

test('bin --list-tools runs in an empty env with settings that deny Bash and still lists Bash', async (t) => {
  const expected = await listing(t);
  const cwd = await useTempDir(t);
  writeFileSync(join(cwd, 'deny.json'), JSON.stringify({ permissions: { deny: ['Bash'] } }));
  const res = spawnBin(['--list-tools', '--settings', 'deny.json', '--disallowedTools', 'Bash'], { cwd, env: {} });
  assert.deepEqual(res, { code: 0, stdout: expected, stderr: '' });
  assert.ok(JSON.parse(res.stdout).tools.some((tool) => tool.name === 'Bash'));
});

test('bin --list-tools never reads settings: unparseable CLODENT_HOME settings and missing or broken --settings files', async (t) => {
  const expected = await listing(t);
  const cwd = await useTempDir(t);
  const home = join(cwd, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'settings.json'), '{ not json');
  writeFileSync(join(cwd, 'broken.json'), '{"permissions":');
  const env = { CLODENT_HOME: home, HOME: cwd };
  for (const args of [[], ['--settings', 'missing.json'], ['--settings', 'broken.json'], ['--settings', 'missing.json', '--settings', 'broken.json']]) {
    assert.deepEqual(spawnBin(['--list-tools', ...args], { cwd, env }), { code: 0, stdout: expected, stderr: '' }, args.join(' '));
  }
});

test('bin --list-tools writes nothing: an empty CLODENT_HOME and an unwritable HOME stay empty', async (t) => {
  const expected = await listing(t);
  const root = await useTempDir(t);
  const cwd = join(root, 'cwd');
  const home = join(root, 'clodent-home');
  const locked = join(root, 'locked');
  for (const dir of [cwd, home, locked]) mkdirSync(dir);
  chmodSync(locked, 0o555);
  assert.deepEqual(spawnBin(['--list-tools'], { cwd, env: { CLODENT_HOME: home, HOME: locked } }), { code: 0, stdout: expected, stderr: '' });
  assert.deepEqual(spawnBin(['--list-tools'], { cwd, env: { HOME: locked } }), { code: 0, stdout: expected, stderr: '' });
  for (const dir of [cwd, home, locked]) assert.deepEqual(readdirSync(dir), [], dir);
});

test('bin --list-tools with CLODENT_HOME and HOME at a missing directory creates nothing', async (t) => {
  const expected = await listing(t);
  const root = await useTempDir(t);
  const cwd = join(root, 'cwd');
  mkdirSync(cwd);
  const missing = join(root, 'missing');
  const res = spawnBin(['--list-tools'], { cwd, env: { CLODENT_HOME: join(missing, '.clodent'), HOME: missing } });
  assert.deepEqual(res, { code: 0, stdout: expected, stderr: '' });
  assert.equal(existsSync(missing), false);
  assert.deepEqual(readdirSync(root), ['cwd']);
  assert.deepEqual(readdirSync(cwd), []);
});
