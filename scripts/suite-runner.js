import { readdirSync } from 'node:fs';
import path from 'node:path';

const TIMEOUT_MS = 120000;
const SKIPPED_DIRS = new Set(['node_modules', 'fixtures']);
const ERROR_LINE = /^\w*Error\b/;

export function parseArgs(argv, cwd, root) {
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

export function discover(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
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

function errorLine(err) {
  const cause = err?.cause ?? err;
  if (typeof cause === 'string') return firstLine(cause);
  return firstLine(cause?.message || String(cause));
}

function fileEntry(state, file) {
  let entry = state.files.get(file);
  if (!entry) {
    entry = { seen: [], failedBelow: [], reported: false, failed: false, stderrError: undefined };
    state.files.set(file, entry);
  }
  return entry;
}

function recordFailure(state, deps, data, name, reason) {
  state.fail += 1;
  const file = data.file ? path.relative(deps.cwd, data.file) : '?';
  deps.stdout.write(`FAIL ${file}: ${name ?? file} — ${reason}\n`);
}

function onFileResult(type, data, entry, state, deps) {
  if (type !== 'test:fail' || entry.failed) return;
  entry.failed = true;
  const useStderr = !entry.reported && entry.stderrError !== undefined;
  recordFailure(state, deps, data, undefined, useStderr ? entry.stderrError : errorLine(data.details?.error));
}

function onTestResult(type, data, entry, state, deps) {
  const level = data.nesting;
  const hasChildren = entry.seen[level + 1] === true;
  const failedBelow = entry.failedBelow[level + 1] === true;
  entry.seen.length = level + 1;
  entry.failedBelow.length = level + 1;
  entry.seen[level] = true;
  entry.reported = true;
  const leaf = !hasChildren && data.details?.type !== 'suite';
  let counted = false;
  if (data.skip !== undefined) {
    if (leaf) state.skipped += 1;
  } else if (data.todo === undefined) {
    if (type === 'test:fail' && !failedBelow) {
      counted = true;
      entry.failed = true;
      recordFailure(state, deps, data, data.name, errorLine(data.details?.error));
    } else if (type === 'test:pass' && leaf) {
      state.pass += 1;
    }
  }
  entry.failedBelow[level] = entry.failedBelow[level] === true || failedBelow || counted;
}

function onEvent({ type, data }, state, deps) {
  if (type === 'test:stdout' || type === 'test:stderr') {
    deps.stderr.write(data.message);
    if (type === 'test:stdout') return;
    const entry = fileEntry(state, data.file ?? '?');
    if (entry.stderrError === undefined) {
      entry.stderrError = data.message.split('\n').find((line) => ERROR_LINE.test(line));
    }
    return;
  }
  if (type !== 'test:pass' && type !== 'test:fail') return;
  const entry = fileEntry(state, data.file ?? '?');
  if (data.nesting === 0 && data.name === data.file) onFileResult(type, data, entry, state, deps);
  else onTestResult(type, data, entry, state, deps);
}

export async function main(argv, deps) {
  const opts = parseArgs(argv, deps.cwd, deps.root);
  if (opts.error) {
    deps.stderr.write(`run-tests: ${opts.error}\n`);
    return 2;
  }
  const files = opts.files.length ? opts.files : discover(opts.dir);
  const state = { pass: 0, fail: 0, skipped: 0, files: new Map() };
  if (files.length) {
    const events = deps.run({ files, concurrency: true, isolation: 'process', timeout: TIMEOUT_MS });
    for await (const event of events) onEvent(event, state, deps);
  }
  if (state.skipped) deps.stdout.write(`SKIPPED: ${state.skipped}\n`);
  deps.stdout.write(`TOTALS: ${state.pass} pass, ${state.fail} fail, ${state.pass + state.fail} tests\n`);
  return state.fail === 0 ? 0 : 1;
}
