import { join, resolve } from 'node:path';
import { findGitRoot } from '../prompt/agents-md.js';

const HEADS = /^ref:\s*refs\/heads\/(.+?)\s*$/;

function read(path, readFileSync) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function gitDirOf(root, { readFileSync, statSync }) {
  const dotGit = join(root, '.git');
  if (statSync(dotGit).isDirectory()) return dotGit;
  const pointer = read(dotGit, readFileSync)?.match(/^gitdir:\s*(.+?)\s*$/m);
  return pointer ? resolve(root, pointer[1]) : null;
}

export function gitBranch(cwd, deps) {
  try {
    const root = findGitRoot(cwd, { stat: deps.statSync });
    if (root === null) return '';
    const gitDir = gitDirOf(root, deps);
    const head = gitDir === null ? null : read(join(gitDir, 'HEAD'), deps.readFileSync);
    if (head === null) return '';
    return head.trim().match(HEADS)?.[1] ?? 'HEAD';
  } catch {
    return '';
  }
}
