import { dirname, join } from 'node:path';

export const FILE_CAP_BYTES = 32 * 1024;
export const TOTAL_CAP_BYTES = 96 * 1024;
export const TRUNCATED_MARKER = '[clodent: AGENTS.md truncated]';

function exists(path, deps) {
  try {
    deps.stat(path);
    return true;
  } catch {
    return false;
  }
}

export function findGitRoot(cwd, deps) {
  let dir = cwd;
  for (;;) {
    if (exists(join(dir, '.git'), deps)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isFile(path, deps) {
  try {
    return deps.stat(path).isFile();
  } catch {
    return false;
  }
}

function readIfFile(path, deps) {
  try {
    if (!deps.stat(path).isFile()) return null;
    return deps.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function capBytes(text, max) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return { text, bytes: buf.length, truncated: false };
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), bytes: end, truncated: true };
}

function dirsRootToCwd(cwd, gitRoot) {
  if (gitRoot === null) return [cwd];
  const dirs = [cwd];
  let dir = cwd;
  while (dir !== gitRoot) {
    dir = dirname(dir);
    dirs.push(dir);
  }
  return dirs.reverse();
}

export function discoverAgentsMd(cwd, deps) {
  const gitRoot = findGitRoot(cwd, deps);
  const dirs = dirsRootToCwd(cwd, gitRoot);
  const found = [];
  for (const dir of dirs) {
    const path = join(dir, 'AGENTS.md');
    const text = readIfFile(path, deps);
    if (text !== null && text.trim() !== '') found.push({ path, text });
  }
  let remaining = TOTAL_CAP_BYTES;
  for (let i = found.length - 1; i >= 0; i--) {
    const capped = capBytes(found[i].text, Math.min(FILE_CAP_BYTES, remaining));
    remaining -= capped.bytes;
    if (capped.truncated) found[i].text = [capped.text.trimEnd(), TRUNCATED_MARKER].filter(Boolean).join('\n');
  }
  const claudeMdOnly = found.length === 0 && dirs.some((dir) => isFile(join(dir, 'CLAUDE.md'), deps));
  return { gitRoot, files: found, claudeMdOnly };
}
