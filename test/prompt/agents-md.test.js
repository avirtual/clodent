import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverAgentsMd,
  FILE_CAP_BYTES,
  findGitRoot,
  TOTAL_CAP_BYTES,
  TRUNCATED_MARKER,
} from '../../src/prompt/agents-md.js';
import { DIR, fakeFs } from './fake-fs.js';

test('files run from the git root down to cwd, skipping dirs without AGENTS.md', () => {
  const fs = fakeFs({
    '/AGENTS.md': 'above the repo',
    '/repo/.git': DIR,
    '/repo/AGENTS.md': 'root rules\n',
    '/repo/pkg/AGENTS.md': 'pkg rules',
    '/repo/pkg/src/lib/AGENTS.md': 'lib rules',
  });
  const { gitRoot, files } = discoverAgentsMd('/repo/pkg/src/lib', fs);
  assert.equal(gitRoot, '/repo');
  assert.deepEqual(files, [
    { path: '/repo/AGENTS.md', text: 'root rules\n' },
    { path: '/repo/pkg/AGENTS.md', text: 'pkg rules' },
    { path: '/repo/pkg/src/lib/AGENTS.md', text: 'lib rules' },
  ]);
});

test('a worktree .git file marks the root and stops the walk', () => {
  const fs = fakeFs({
    '/main/.git': DIR,
    '/main/AGENTS.md': 'main checkout rules',
    '/main/wt/.git': 'gitdir: /main/.git/worktrees/wt\n',
    '/main/wt/AGENTS.md': 'worktree rules',
    '/main/wt/sub/AGENTS.md': 'sub rules',
  });
  assert.equal(findGitRoot('/main/wt/sub', fs), '/main/wt');
  const { files } = discoverAgentsMd('/main/wt/sub', fs);
  assert.deepEqual(files.map((f) => f.path), ['/main/wt/AGENTS.md', '/main/wt/sub/AGENTS.md']);
});

test('cwd at the git root reads only the root file', () => {
  const fs = fakeFs({ '/repo/.git': DIR, '/repo/AGENTS.md': 'root', '/AGENTS.md': 'outside' });
  assert.deepEqual(discoverAgentsMd('/repo', fs).files, [{ path: '/repo/AGENTS.md', text: 'root' }]);
});

test('with no git root only cwd is read', () => {
  const fs = fakeFs({ '/a/AGENTS.md': 'parent', '/a/b/AGENTS.md': 'cwd' });
  const { gitRoot, files } = discoverAgentsMd('/a/b', fs);
  assert.equal(gitRoot, null);
  assert.deepEqual(files, [{ path: '/a/b/AGENTS.md', text: 'cwd' }]);
  assert.deepEqual(fs.reads, ['/a/b/AGENTS.md']);
});

test('an AGENTS.md that is a directory or unreadable is skipped', () => {
  const fs = fakeFs({ '/r/.git': DIR, '/r/AGENTS.md': DIR, '/r/x/AGENTS.md': 'x' });
  fs.stat = ((stat) => (path) => {
    if (path === '/r/x/AGENTS.md') return { isFile: () => true };
    return stat(path);
  })(fs.stat);
  const readFile = fs.readFile;
  fs.readFile = (path) => {
    if (path === '/r/x/AGENTS.md') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return readFile(path);
  };
  assert.deepEqual(discoverAgentsMd('/r/x', fs).files, []);
});

test('each file is capped at 32 KiB with a marker', () => {
  const fs = fakeFs({ '/r/.git': DIR, '/r/AGENTS.md': 'a'.repeat(FILE_CAP_BYTES + 100), '/r/s/AGENTS.md': 'small' });
  const { files } = discoverAgentsMd('/r/s', fs);
  assert.equal(files[0].text, `${'a'.repeat(FILE_CAP_BYTES)}\n${TRUNCATED_MARKER}`);
  assert.equal(files[1].text, 'small');
});

test('a file of exactly 32 KiB is not truncated', () => {
  const fs = fakeFs({ '/r/.git': DIR, '/r/AGENTS.md': 'a'.repeat(FILE_CAP_BYTES) });
  assert.equal(discoverAgentsMd('/r', fs).files[0].text, 'a'.repeat(FILE_CAP_BYTES));
});

test('the cap counts bytes and never splits a multi-byte character', () => {
  const fs = fakeFs({ '/r/.git': DIR, '/r/AGENTS.md': `a${'é'.repeat(FILE_CAP_BYTES)}` });
  const [file] = discoverAgentsMd('/r', fs).files;
  const body = file.text.slice(0, -TRUNCATED_MARKER.length - 1);
  assert.equal(body, `a${'é'.repeat((FILE_CAP_BYTES - 2) / 2)}`);
  assert.ok(!body.includes('�'));
});

test('the total is capped at 96 KiB, spending the budget on the most specific files first', () => {
  const size = 30 * 1024;
  const fs = fakeFs({
    '/r/.git': DIR,
    '/r/AGENTS.md': 'r'.repeat(size),
    '/r/a/AGENTS.md': 'a'.repeat(size),
    '/r/a/b/AGENTS.md': 'b'.repeat(size),
    '/r/a/b/c/AGENTS.md': 'c'.repeat(size),
    '/r/a/b/c/d/AGENTS.md': 'd'.repeat(size),
  });
  const { files } = discoverAgentsMd('/r/a/b/c/d', fs);
  assert.deepEqual(files.map((f) => f.path), ['/r', '/r/a', '/r/a/b', '/r/a/b/c', '/r/a/b/c/d'].map((d) => `${d}/AGENTS.md`));
  assert.equal(files[4].text, 'd'.repeat(size));
  assert.equal(files[3].text, 'c'.repeat(size));
  assert.equal(files[2].text, 'b'.repeat(size));
  assert.equal(files[1].text, `${'a'.repeat(TOTAL_CAP_BYTES - 3 * size)}\n${TRUNCATED_MARKER}`);
  assert.equal(files[0].text, TRUNCATED_MARKER);
  const kept = files.reduce((sum, f) => sum + Buffer.byteLength(f.text.replace(`\n${TRUNCATED_MARKER}`, '').replace(TRUNCATED_MARKER, '')), 0);
  assert.equal(kept, TOTAL_CAP_BYTES);
});
