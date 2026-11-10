import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { lstat as fsLstat, realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGuard } from '../../src/permissions/guard.js';
import { parseRules } from '../../src/permissions/rules.js';

function tree(t, deps = {}) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'clodent-links-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  for (const dir of ['work', 'secret', 'asked', 'free']) mkdirSync(join(tmp, dir));
  const where = { file: '/etc/clodent/settings.json', cwd: join(tmp, 'work'), home: '/Users/u' };
  const lists = {
    deny: parseRules([`Edit(/${tmp}/secret/**)`], 'permissions.deny', where),
    ask: parseRules([`Edit(/${tmp}/asked/**)`], 'permissions.ask', where),
  };
  const guard = createGuard(lists, { platform: 'linux', home: '/Users/u', ...deps });
  const link = (target, name) => symlinkSync(target, join(tmp, 'work', name));
  const write = async (file, mode) => {
    const { ruled } = await guard.screen('Write', { file_path: file, content: '' }, join(tmp, 'work'), mode);
    return ruled && `${ruled.decision} ${ruled.rule.text}`;
  };
  return { tmp, link, write, guard };
}

test('a Write through a dangling symlink to a file a deny rule guards is denied', async (t) => {
  const { tmp, link, write } = tree(t);
  link(join(tmp, 'secret/new.txt'), 'out');
  assert.equal(await write('out'), `deny Edit(/${tmp}/secret/**)`);
});

test('a dangling symlink at an ancestor, and a chain of two relative dangling links, are followed to the denied path', async (t) => {
  const { tmp, link, write } = tree(t);
  link(join(tmp, 'secret/missing-dir'), 'dir');
  link('second', 'first');
  link('../secret/chain.txt', 'second');
  assert.equal(await write('dir/x.txt'), `deny Edit(/${tmp}/secret/**)`);
  assert.equal(await write('first'), `deny Edit(/${tmp}/secret/**)`);
});

test('a relative symlink in a subdirectory is read against its own directory, not the working directory', async (t) => {
  const { tmp, link, write } = tree(t);
  mkdirSync(join(tmp, 'work/sub'));
  link('../../secret/x', 'sub/rel');
  assert.equal(await write('sub/rel'), `deny Edit(/${tmp}/secret/**)`);
});

test('a link target with a trailing slash or repeated slashes is followed to the dangling link it names', async (t) => {
  const { tmp, link, write } = tree(t);
  link(`${tmp}/work/b/`, 'dir');
  link(`${tmp}//work//b//`, 'twice');
  link(`${tmp}/work/c\n/`, 'newline');
  link(join(tmp, 'secret/missing'), 'b');
  link(join(tmp, 'secret/missing'), 'c\n');
  assert.equal(await write('dir/x'), `deny Edit(/${tmp}/secret/**)`);
  assert.equal(await write('twice/x'), `deny Edit(/${tmp}/secret/**)`);
  assert.equal(await write('newline/x'), `deny Edit(/${tmp}/secret/**)`);
});

test('an unreadable entry under a symlinked ancestor still resolves the ancestor: a deny rule denies in every mode', async (t) => {
  const locked = /\/(?:s|secret)\/locked\/./;
  const eacces = (path) => Promise.reject(Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' }));
  const deps = { realpath: (path) => (locked.test(path) ? eacces(path) : fsRealpath(path)), lstat: (path) => (locked.test(path) ? eacces(path) : fsLstat(path)) };
  const { tmp, link, guard } = tree(t, deps);
  mkdirSync(join(tmp, 'secret/locked'));
  link(join(tmp, 'secret'), 's');
  for (const mode of ['ask', 'accept-edits', 'read-only', 'yolo']) {
    const { ruled } = await guard.screen('Write', { file_path: 's/locked/x', content: '' }, join(tmp, 'work'), mode);
    assert.deepEqual(ruled, { decision: 'deny', rule: ruled.rule }, mode);
    assert.equal(ruled.rule.text, `Edit(/${tmp}/secret/**)`, mode);
  }
});

test('an ask rule asks for a Write through a dangling symlink to the path it guards', async (t) => {
  const { tmp, link, write } = tree(t);
  link(join(tmp, 'asked/new.txt'), 'later');
  assert.equal(await write('later'), `ask Edit(/${tmp}/asked/**)`);
});

test('a symlink loop is uncertain: it asks, and the deny rule denies under --yolo, without hanging', async (t) => {
  const { tmp, link, guard } = tree(t);
  link('loop-b', 'loop-a');
  link('loop-a', 'loop-b');
  const cwd = join(tmp, 'work');
  const asked = (await guard.screen('Write', { file_path: 'loop-a', content: '' }, cwd, 'ask')).ruled;
  assert.equal(`${asked.decision} ${asked.rule.text}`, `ask Edit(/${tmp}/secret/**)`);
  assert.match(asked.reason, /loop-a may resolve to a path .* guards: it could not be resolved$/);
  const yolo = (await guard.screen('Write', { file_path: 'loop-a/x', content: '' }, cwd, 'yolo')).ruled;
  assert.equal(`${yolo.decision} ${yolo.rule.text}`, `deny Edit(/${tmp}/secret/**)`);
});

test('a dangling symlink to a path no rule guards is not denied', async (t) => {
  const { tmp, link, write } = tree(t);
  link(join(tmp, 'free/new.txt'), 'fine');
  link('../free/sub/new.txt', 'fine-relative');
  assert.equal(await write('fine'), null);
  assert.equal(await write('fine-relative'), null);
});
