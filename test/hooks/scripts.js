import { execFileSync } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function script(dir, name, body) {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/bash\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

export function hookOutput(fields) {
  return `printf '%s\\n' '${JSON.stringify({ hookSpecificOutput: fields })}'`;
}

export function entry(command, extra = {}) {
  return { type: 'command', command, timeout: null, onFailure: null, ...extra };
}

export function group(matcher, ...entries) {
  return { matcher, hooks: entries.map((e) => (typeof e === 'string' ? entry(e) : e)) };
}

export function settingsWith(hooks, extra = {}) {
  return { hooks, statusLine: null, env: {}, extraDirs: [], ...extra };
}

export function isGone(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === 'ESRCH';
  }
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return state === '' || state.startsWith('Z');
  } catch {
    return true;
  }
}
