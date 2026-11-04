import { execFile as nodeExecFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { toolEnv } from './env.js';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const NO_FSMONITOR = ['-c', 'core.fsmonitor='];
const GIT_ARGS = [...NO_FSMONITOR, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'];

function gitFiles(root, { env, signal, execFile }) {
  return new Promise((done) => {
    execFile('git', GIT_ARGS, { cwd: root, env, signal, maxBuffer: 1 << 30 }, (err, stdout) => {
      if (err) done(null);
      else done([...new Set(stdout.split('\0').filter(Boolean))]);
    });
  });
}

function gitIgnored(root, { env, signal, execFile }) {
  return new Promise((done) => {
    execFile('git', [...NO_FSMONITOR, 'check-ignore', '-q', '.'], { cwd: root, env, signal }, (err) => done(!err));
  });
}

async function walk(root, signal) {
  const out = [];
  const pending = [''];
  while (pending.length > 0 && !signal?.aborted) {
    const dir = pending.pop();
    let entries;
    try {
      entries = await readdir(dir ? join(root, dir) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (!entry.isDirectory()) out.push(rel);
      else if (!SKIP_DIRS.has(entry.name)) pending.push(rel);
    }
  }
  return out;
}

export async function listFiles(root, { env, envDeny, signal, execFile = nodeExecFile } = {}) {
  const git = { env: toolEnv(env, envDeny), signal, execFile };
  if (await gitIgnored(root, git)) return walk(root, signal);
  const tracked = await gitFiles(root, git);
  return tracked ?? walk(root, signal);
}
