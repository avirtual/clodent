import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return { ...env, ...extra };
}

export async function useTempDir(t) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'clodent-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function plant(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

export async function setMtime(path, seconds) {
  await utimes(path, seconds, seconds);
}

export function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, env: cleanEnv(), stdio: 'ignore' });
}

export function gitAdd(dir, ...paths) {
  execFileSync('git', ['add', '--', ...paths], { cwd: dir, env: cleanEnv(), stdio: 'ignore' });
}

export function ctxFor(cwd, extra = {}) {
  return { cwd, env: cleanEnv(), ...extra };
}
