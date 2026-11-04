import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAGS } from '../src/args.js';
import { main, NOT_YET } from '../src/cli.js';
import { createFakeFetch } from './helpers/fake-fetch.js';
import { sse } from './helpers/sse-builder.js';
import { cleanEnv, plant, useTempDir } from './tools/tmp-dir.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const COST_LINE = /^\[clodent:cost\] \$\d+\.\d{4} \(in \d+, cache-read \d+, cache-write \d+, out \d+\)$/m;
const TOTAL_LINE = /^\[clodent:cost\] session total \$\d+\.\d{4} /m;
const SESSION_LINE = /^\[clodent:session\] [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOME = mkdtempSync(join(tmpdir(), 'clodent-cli-home-'));
after(() => rmSync(HOME, { recursive: true, force: true }));

function fakeDeps({ responses = [], env = {}, cwd = tmpdir(), ...extra } = {}) {
  const out = [];
  const err = [];
  const signals = {};
  const fetch = createFakeFetch(responses);
  const deps = {
    stdout: { write: (chunk) => out.push(chunk) },
    stderr: { write: (chunk) => err.push(chunk) },
    stdin: null,
    env,
    cwd,
    homedir: HOME,
    platform: 'darwin',
    fetch,
    sleep: async () => {},
    random: () => 0.5,
    now: () => 0,
    clock: () => new Date(2026, 10, 4),
    onSignal: (name, handler) => {
      signals[name] = handler;
      return () => delete signals[name];
    },
    ...extra,
  };
  return { deps, fetch, signals, stdout: () => out.join(''), stderr: () => err.join('') };
}

async function run(argv, options) {
  const fake = fakeDeps(options);
  const code = await main(argv, fake.deps);
  return Object.defineProperty({ code, stdout: fake.stdout(), stderr: fake.stderr() }, 'fetch', { value: fake.fetch });
}

const KEY = { ANTHROPIC_API_KEY: 'sk-test' };
const textReply = (text, stopReason = 'end_turn') => ({ body: sse({ blocks: [{ type: 'text', text }], stopReason }) });
const toolReply = (name, input) => ({
  body: sse({ blocks: [{ type: 'tool_use', id: 'toolu_1', name, input }], stopReason: 'tool_use', usage: { input_tokens: 1000 } }),
});

test('--version prints the package version and returns 0', async () => {
  assert.deepEqual(await run(['--version']), { code: 0, stdout: `clodent ${VERSION}\n`, stderr: '' });
  assert.deepEqual(await run(['-v']), { code: 0, stdout: `clodent ${VERSION}\n`, stderr: '' });
});

test('--help prints usage and returns 0', async () => {
  const res = await run(['--help']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /^usage: clodent/);
  assert.equal(res.stderr, '');
  assert.equal((await run(['-h'])).stdout, res.stdout);
});

test('--help lists every flag with a description and marks the unimplemented ones', async () => {
  const { stdout } = await run(['--help']);
  for (const flag of FLAGS) {
    const names = [flag.short && `-${flag.short}`, `--${flag.long}`, flag.alias && `--${flag.alias}`].filter(Boolean).join(', ');
    const label = flag.arg ? `${names} <${flag.arg}>` : names;
    const line = stdout.split('\n').find((l) => l.trimStart().startsWith(`${label} `));
    assert.ok(line, `no help line for ${label}`);
    assert.ok(line.includes(flag.help), `help line for ${label} lacks its description`);
    assert.equal(line.endsWith('(not implemented yet)'), NOT_YET.has(flag.long), line);
  }
});

test('--help and --version win over flags that are not implemented yet', async () => {
  assert.equal((await run(['--yolo', '--help'])).code, 0);
  assert.equal((await run(['--model', 'x', '--version'])).stdout, `clodent ${VERSION}\n`);
});

test('a parse error prints the error and a pointer to --help, and returns 2', async () => {
  assert.deepEqual(await run(['--frobnicate']), {
    code: 2,
    stdout: '',
    stderr: 'clodent: unknown option: --frobnicate\nclodent: see --help\n',
  });
  assert.deepEqual(await run(['--effort', 'ultra']), {
    code: 2,
    stdout: '',
    stderr: 'clodent: --effort must be low, medium, high, xhigh or max, got "ultra"\nclodent: see --help\n',
  });
  assert.deepEqual(await run(['--cache-ttl', '2h']), {
    code: 2,
    stdout: '',
    stderr: 'clodent: --cache-ttl must be 5m or 1h, got "2h"\nclodent: see --help\n',
  });
  assert.deepEqual(await run(['--permission-mode', 'plan', '--yolo']), {
    code: 2,
    stdout: '',
    stderr: 'clodent: --yolo and --permission-mode cannot be combined\nclodent: see --help\n',
  });
  assert.equal((await run(['fix it'])).code, 2);
});

test('NOT_YET names only real flags and never --version or --help', () => {
  const names = new Set(FLAGS.map((f) => f.long));
  for (const name of NOT_YET) assert.ok(names.has(name), name);
  assert.equal(NOT_YET.has('version'), false);
  assert.equal(NOT_YET.has('help'), false);
});

test('a missing --settings file exits 2 with the loader error, before any request', async (t) => {
  const cwd = await useTempDir(t);
  const res = await run(['-p', 'go', '--settings', 'missing.json'], { env: KEY, cwd });
  assert.deepEqual([res.code, res.stdout, res.stderr], [2, '', `clodent: settings file not found: ${join(cwd, 'missing.json')}\n`]);
  assert.equal(res.fetch.calls.length, 0);
});

test('NOT_YET is empty: every flag is implemented', () => {
  assert.deepEqual([...NOT_YET], []);
});

test('without -p clodent starts the REPL, which exits 2 before reading stdin when ANTHROPIC_API_KEY is unset', async () => {
  const res = await run([]);
  assert.deepEqual([res.code, res.stdout, res.stderr], [2, '', 'clodent: ANTHROPIC_API_KEY is not set\n']);
  assert.equal((await run(['--model', 'x', '--yolo'])).stderr, 'clodent: ANTHROPIC_API_KEY is not set\n');
});

test('README ### Flags marks exactly the NOT_YET flags as parsed; not yet implemented', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.split('\n### Flags\n')[1].split('\n### ')[0];
  const rows = section.split('\n').filter((line) => line.startsWith('| `'));
  const status = new Map(
    rows.map((row) => {
      const cells = row.split('|').map((cell) => cell.trim());
      return [cells[1].match(/`--([A-Za-z-]+)/)[1], cells[2]];
    }),
  );
  assert.deepEqual([...status.keys()].sort(), FLAGS.map((flag) => flag.long).sort());
  for (const [name, text] of status) {
    assert.equal(text === 'parsed; not yet implemented', NOT_YET.has(name), `${name}: ${text}`);
  }
});

test('-p without ANTHROPIC_API_KEY exits 2 before any request', async () => {
  const res = await run(['-p', 'hi']);
  assert.deepEqual([res.code, res.stdout, res.stderr], [2, '', 'clodent: ANTHROPIC_API_KEY is not set\n']);
  assert.equal(res.fetch.calls.length, 0);
});

test('-p prints only the answer on stdout, the cost and total on stderr, and exits 0', async (t) => {
  const cwd = await useTempDir(t);
  const res = await run(['-p', 'hi'], { env: KEY, cwd, responses: [{ body: 'text-only.sse' }] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, 'Hello, world!\n');
  const lines = res.stderr.split('\n');
  assert.match(lines[0], SESSION_LINE);
  assert.equal(lines[1], '[clodent:cost] $0.0004 (in 25, cache-read 0, cache-write 0, out 15)');
  assert.match(lines[2], TOTAL_LINE);
  assert.equal(lines.length, 4);
});

test('-p sends the flags: model, effort, system prompt parts and add-dir', async (t) => {
  const cwd = await useTempDir(t);
  await plant(cwd, { 'extra.md': 'appended from file' });
  const res = await run(
    ['-p', 'hi', '--model', 'claude-haiku-5-5', '--effort', 'low', '--system-prompt', 'BASE', '--append-system-prompt', 'MORE',
      '--append-system-prompt-file', 'extra.md', '--add-dir', '/shared'],
    { env: KEY, cwd, responses: [{ body: 'text-only.sse' }] },
  );
  assert.equal(res.code, 0, res.stderr);
  const { body } = res.fetch.calls[0];
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.deepEqual(body.output_config, { effort: 'low' });
  const system = body.system[0].text;
  assert.ok(system.startsWith('BASE\n\n# Environment'), system);
  assert.match(system, /\nDate: 2026-11-04\nModel: claude-haiku-5-5\nAdditional directories:\n\/shared\n/);
  assert.ok(system.endsWith('MORE\n\nappended from file'), system);
  assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }]);
});

test('-p with an unreadable prompt file exits 2 before any request', async (t) => {
  const cwd = await useTempDir(t);
  const res = await run(['-p', 'hi', '--system-prompt-file', 'missing.md'], { env: KEY, cwd });
  assert.equal(res.code, 2);
  assert.equal(res.stderr, `clodent: cannot read --system-prompt-file ${cwd}/missing.md: ENOENT\n`);
  assert.equal(res.fetch.calls.length, 0);
});

test('-p exits 1 on an API error, with the message verbatim', async (t) => {
  const cwd = await useTempDir(t);
  const res = await run(['-p', 'hi'], {
    env: KEY,
    cwd,
    responses: [{ status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'credit balance is too low' } }) }],
  });
  assert.equal(res.code, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /^clodent: credit balance is too low\n/m);
  assert.match(res.stderr, COST_LINE);
});

test('-p exits 1 when max_tokens cuts the answer, still printing the text', async (t) => {
  const cwd = await useTempDir(t);
  const res = await run(['-p', 'hi'], { env: KEY, cwd, responses: [textReply('partial', 'max_tokens')] });
  assert.equal(res.code, 1);
  assert.equal(res.stdout, 'partial\n');
  assert.match(res.stderr, /^clodent: response hit max_tokens$/m);
});

test('-p under the default ask mode denies Write and says why on stderr', async (t) => {
  const cwd = await useTempDir(t);
  const res = await run(['-p', 'write it'], {
    env: KEY,
    cwd,
    responses: [toolReply('Write', { file_path: 'x.txt', content: 'x' }), textReply('could not')],
  });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, 'could not\n');
  assert.match(res.stderr, /^● Write x\.txt\n {2}✗ permission required: run clodent without -p to approve it, or pass --yolo$/m);
});

test('--budget below the first request cost stops before the second: exit 1 and the budget line', async (t) => {
  const cwd = await useTempDir(t);
  const res = await run(['-p', 'go', '--budget', '0.001'], {
    env: KEY,
    cwd,
    responses: [toolReply('Read', { file_path: 'nope.md' }), textReply('never')],
  });
  assert.equal(res.code, 1);
  assert.equal(res.fetch.calls.length, 1);
  assert.match(res.stderr, /^\[clodent:budget\] stopped: spent \$0\.0044, next request est\. \$0\.0044, budget \$0\.0010$/m);
  assert.match(res.stderr, COST_LINE);
  assert.match(res.stderr, TOTAL_LINE);
});

test('SIGINT during -p kills the running Bash, awaits it, and exits 130', async (t) => {
  const cwd = await useTempDir(t);
  let sleepPid;
  let signals;
  let bashExit;
  const spawn = (...args) => {
    const child = nodeSpawn(...args);
    child.on('exit', (exitCode, signal) => {
      bashExit = { exitCode, signal };
    });
    child.stdout.on('data', (chunk) => {
      sleepPid ??= Number(String(chunk).trim());
      signals.SIGINT?.();
    });
    return child;
  };
  const fake = fakeDeps({
    env: { ...cleanEnv(KEY), CLODENT_HOME: join(HOME, 'sigint') },
    cwd,
    spawn,
    responses: [toolReply('Bash', { command: 'sleep 30 & echo $!; wait' })],
  });
  signals = fake.signals;
  const code = await main(['-p', 'run it', '--yolo'], fake.deps);
  assert.equal(code, 130);
  assert.deepEqual(bashExit, { exitCode: null, signal: 'SIGTERM' });
  assert.ok(Number.isInteger(sleepPid) && sleepPid > 0, String(sleepPid));
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(sleepPid)], { encoding: 'utf8' });
  const stat = ps.stdout.trim();
  assert.ok(stat === '' || stat.startsWith('Z'), `sleep ${sleepPid} still running: ${stat}`);
  assert.equal(fake.fetch.calls.length, 1);
  assert.deepEqual(fake.signals, {});
  assert.match(fake.stderr(), /^clodent: interrupted$/m);
  assert.match(fake.stderr(), TOTAL_LINE);
});

test('bin/clodent.js --version runs from any cwd', () => {
  const bin = fileURLToPath(new URL('../bin/clodent.js', import.meta.url));
  const res = spawnSync(process.execPath, [bin, '--version'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `clodent ${VERSION}\n`);
});

test('bin/clodent.js exits 2 on a parse error', () => {
  const bin = fileURLToPath(new URL('../bin/clodent.js', import.meta.url));
  const res = spawnSync(process.execPath, [bin, '--frobnicate'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.equal(res.stderr, 'clodent: unknown option: --frobnicate\nclodent: see --help\n');
});
