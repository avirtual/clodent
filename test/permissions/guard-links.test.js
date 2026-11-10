import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGuard } from '../../src/permissions/guard.js';
import { parseRules } from '../../src/permissions/rules.js';

function tree(t) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'clodent-links-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  for (const dir of ['work', 'secret', 'asked', 'free']) mkdirSync(join(tmp, dir));
  const where = { file: '/etc/clodent/settings.json', cwd: join(tmp, 'work'), home: '/Users/u' };
  const lists = {
    deny: parseRules([`Edit(/${tmp}/secret/**)`], 'permissions.deny', where),
    ask: parseRules([`Edit(/${tmp}/asked/**)`], 'permissions.ask', where),
  };
  const guard = createGuard(lists, { platform: 'linux', home: '/Users/u' });
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
  assert.match(asked.reason, /loop-a may resolve to a path .* guards: its symlinks could not be followed$/);
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
