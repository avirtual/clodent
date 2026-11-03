import { readdirSync } from 'node:fs';
import path from 'node:path';
import { run } from 'node:test';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 120000;
const SKIPPED_DIRS = new Set(['node_modules', 'fixtures']);
const ERROR_LINE = /^\w*Error\b/;

function parseArgs(argv, cwd, root) {
  const opts = { dir: path.join(root, 'test'), files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') {
      if (argv[i + 1] === undefined) return { error: '--dir needs a path' };
      i += 1;
      opts.dir = path.resolve(cwd, argv[i]);
    } else if (arg.startsWith('--reporter=')) {
      continue;
    } else if (arg.startsWith('-')) {
      return { error: `unknown option ${arg}` };
    } else {
      opts.files.push(path.resolve(cwd, arg));
    }
  }
  return opts;
}

function discover(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT' && current === dir) return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found.sort();
}

function firstLine(text) {
  return String(text).split('\n').find((line) => line.trim()) ?? '';
}

function failureLine(data, state) {
  const err = data.details?.error;
  if (err?.exitCode !== undefined && state.stderrErrors.has(data.file)) {
    return state.stderrErrors.get(data.file);
  }
  const cause = err?.cause ?? err;
  if (typeof cause === 'string') return firstLine(cause);
  return firstLine(cause?.message || String(cause));
}

function onEvent({ type, data }, state, deps) {
  if (type === 'test:stdout' || type === 'test:stderr') {
    deps.stderr.write(data.message);
    if (type === 'test:stderr' && data.file && !state.stderrErrors.has(data.file)) {
      const line = data.message.split('\n').find((l) => ERROR_LINE.test(l));
      if (line) state.stderrErrors.set(data.file, line);
    }
    return;
  }
  if (type !== 'test:pass' && type !== 'test:fail') return;
  if (data.details?.type === 'suite') return;
  if (data.skip !== undefined) {
    state.skipped += 1;
    return;
  }
  if (data.todo !== undefined) return;
  if (type === 'test:pass') {
    state.pass += 1;
    return;
  }
  state.fail += 1;
  const file = data.file ? path.relative(deps.cwd, data.file) : '?';
  const name = data.name === data.file ? file : data.name;
  deps.stdout.write(`FAIL ${file}: ${name} — ${failureLine(data, state)}\n`);
}

async function main(argv, deps) {
  const opts = parseArgs(argv, deps.cwd, deps.root);
  if (opts.error) {
    deps.stderr.write(`run-tests: ${opts.error}\n`);
    return 2;
  }
  const files = opts.files.length ? opts.files : discover(opts.dir);
  const state = { pass: 0, fail: 0, skipped: 0, stderrErrors: new Map() };
  if (files.length) {
    const events = deps.run({ files, concurrency: true, isolation: 'process', timeout: TIMEOUT_MS });
    for await (const event of events) onEvent(event, state, deps);
  }
  if (state.skipped) deps.stdout.write(`SKIPPED: ${state.skipped}\n`);
  deps.stdout.write(`TOTALS: ${state.pass} pass, ${state.fail} fail, ${state.pass + state.fail} tests\n`);
  return state.fail === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
  root: fileURLToPath(new URL('..', import.meta.url)),
  run,
});
