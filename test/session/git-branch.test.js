import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gitBranch } from '../../src/session/git-branch.js';
import { plant, useTempDir } from '../tools/tmp-dir.js';

function inside(root) {
  const statInside = (path) => {
    if (!path.startsWith(root)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return statSync(path);
  };
  return { readFileSync, statSync: statInside };
}

test('gitBranch reads ref: refs/heads/<b> from .git/HEAD at the git root, from any subdirectory', async (t) => {
  const dir = await useTempDir(t);
  await plant(dir, { '.git/HEAD': 'ref: refs/heads/feature/x-1\n', 'a/b/keep.txt': '' });
  assert.equal(gitBranch(dir, inside(dir)), 'feature/x-1');
  assert.equal(gitBranch(join(dir, 'a/b'), inside(dir)), 'feature/x-1');
});

test('gitBranch follows a gitdir: file, as a worktree has, relative or absolute', async (t) => {
  const dir = await useTempDir(t);
  await plant(dir, {
    'main/.git/worktrees/wt/HEAD': 'ref: refs/heads/wt-branch\n',
    'wt/.git': 'gitdir: ../main/.git/worktrees/wt\n',
    'abs/.git': `gitdir: ${join(dir, 'main/.git/worktrees/wt')}\n`,
  });
  assert.equal(gitBranch(join(dir, 'wt'), inside(dir)), 'wt-branch');
  assert.equal(gitBranch(join(dir, 'abs'), inside(dir)), 'wt-branch');
});

test('a detached HEAD gives HEAD; no repo, an unreadable HEAD or a bad gitdir file gives an empty string', async (t) => {
  const dir = await useTempDir(t);
  await plant(dir, {
    'detached/.git/HEAD': '0123456789abcdef0123456789abcdef01234567\n',
    'nohead/.git/config': '',
    'badfile/.git': 'not a pointer\n',
    'plain/keep.txt': '',
  });
  assert.equal(gitBranch(join(dir, 'detached'), inside(dir)), 'HEAD');
  assert.equal(gitBranch(join(dir, 'nohead'), inside(dir)), '');
  assert.equal(gitBranch(join(dir, 'badfile'), inside(dir)), '');
  assert.equal(gitBranch(join(dir, 'plain'), inside(dir)), '');
});
