import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASK_DENIAL, decide, hookPaths } from '../../src/agent/permission.js';

const tool = (name, kind) => ({ name, kind });
const READ = tool('Read', 'read');
const WRITE = tool('Write', 'write');
const BASH = tool('Bash', 'exec');

test('yolo allows every kind', () => {
  for (const t of [READ, WRITE, BASH]) assert.deepEqual(decide(t, {}, 'yolo'), { allow: true });
});

test('read-only allows read tools and denies write tools by name', () => {
  assert.deepEqual(decide(READ, {}, 'read-only'), { allow: true });
  assert.deepEqual(decide(WRITE, {}, 'read-only'), { allow: false, reason: '--read-only: Write is not allowed' });
});

test('read-only runs a read-only Bash command and refuses any other with the reason', () => {
  assert.deepEqual(decide(BASH, { command: 'ls' }, 'read-only'), { allow: true });
  assert.deepEqual(decide(BASH, { command: 'rm x' }, 'read-only'), { allow: false, reason: '--read-only: Bash command is not read-only (rm is not a read-only command)' });
  assert.deepEqual(decide(BASH, {}, 'read-only'), { allow: false, reason: '--read-only: Bash command is not read-only (empty command)' });
});

test('ask runs a read-only Bash command without asking', () => {
  assert.deepEqual(decide(BASH, { command: 'ls' }, 'ask'), { allow: true });
  for (const [t, command] of [[BASH, 'rm x'], [tool('Other', 'exec'), 'ls']]) {
    const verdict = decide(t, { command }, 'ask');
    assert.deepEqual([verdict.allow, verdict.reason], [false, ASK_DENIAL], `${t.name} ${command}`);
  }
});

test('the Bash command is classified against the working directory, so a recursive search with no path from / is not read-only', () => {
  assert.deepEqual(decide(BASH, { command: 'grep -r KEY' }, 'read-only', '/'), { allow: false, reason: '--read-only: Bash command is not read-only (grep may search /proc)' });
  assert.deepEqual(decide(BASH, { command: 'grep -r KEY' }, 'ask', '/'), { allow: false, ask: true, reason: ASK_DENIAL });
  assert.deepEqual(decide(BASH, { command: 'grep -r KEY' }, 'read-only', '/work'), { allow: true });
});

test('ask allows read tools and marks write and exec as an ask, with the rerun hint as the refusal', () => {
  assert.deepEqual(decide(READ, {}, 'ask'), { allow: true });
  assert.deepEqual(decide(WRITE, {}, 'ask'), { allow: false, ask: true, reason: ASK_DENIAL });
  assert.deepEqual(decide(BASH, {}, 'ask'), { allow: false, ask: true, reason: ASK_DENIAL });
  assert.equal(ASK_DENIAL, 'permission required: run clodent without -p to approve it, or pass --yolo');
});

test('an unknown mode or kind is treated as deny, never allow', () => {
  assert.equal(decide(WRITE, {}, undefined).allow, false);
  assert.deepEqual(decide(READ, {}, undefined), { allow: false, reason: 'unknown permission mode undefined' });
  assert.equal(decide(READ, {}, 'sometimes').allow, false);
  assert.equal(decide(tool('X', 'weird'), {}, 'read-only').allow, false);
});

test('accept-edits allows read and write tools and a read-only Bash command, and asks for any other Bash command', () => {
  const EDIT = tool('Edit', 'write');
  for (const t of [READ, WRITE, EDIT]) assert.deepEqual(decide(t, { file_path: 'x' }, 'accept-edits'), { allow: true }, t.name);
  assert.deepEqual(decide(BASH, { command: 'ls' }, 'accept-edits'), { allow: true });
  assert.deepEqual(decide(BASH, { command: 'rm x' }, 'accept-edits'), { allow: false, ask: true, reason: ASK_DENIAL });
  assert.deepEqual(decide(tool('Other', 'exec'), { command: 'ls' }, 'accept-edits'), { allow: false, ask: true, reason: ASK_DENIAL });
});

test('accept-edits asks for a Write or Edit whose path, resolved against the cwd, is inside a .git directory', () => {
  const EDIT = tool('Edit', 'write');
  const asked = { allow: false, ask: true, reason: ASK_DENIAL };
  for (const [t, file_path, cwd] of [
    [WRITE, '.git/config', '/repo'],
    [EDIT, '/repo/.git/hooks/pre-commit', '/elsewhere'],
    [WRITE, 'config', '/repo/.git'],
    [WRITE, '../.git/config', '/repo/src'],
    [WRITE, 'sub/.GIT/config', '/repo'],
    [EDIT, 'x/../.git/info/attributes', '/repo'],
    [WRITE, '.git', '/repo'],
  ]) {
    assert.deepEqual(decide(t, { file_path }, 'accept-edits', cwd), asked, `${file_path} in ${cwd}`);
  }
  for (const file_path of ['.gitignore', '.github/ci.yml', '.git/../x', 'src/a.git']) {
    assert.deepEqual(decide(WRITE, { file_path }, 'accept-edits', '/repo'), { allow: true }, file_path);
  }
  assert.deepEqual(decide(WRITE, { file_path: '.git/config' }, 'yolo', '/repo'), { allow: true });
});

const HOOKED = {
  hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'bash "$CLODENT_PROJECT_DIR/scripts/pre.sh"' }] }] },
  statusLine: { type: 'command', command: '~/bin/status.sh' },
};
const SCOPE = { dirs: ['/extra'], protect: hookPaths(HOOKED, { cwd: '/work', env: {}, home: '/home/u' }) };
const ASKED = { allow: false, ask: true, reason: ASK_DENIAL };

test('hookPaths keeps the path words of every hook and statusLine command, expanded as the hook runner expands them', () => {
  assert.deepEqual(hookPaths(HOOKED, { cwd: '/work', env: {}, home: '/home/u' }), ['/work/scripts/pre.sh', '/home/u/bin/status.sh']);
  const forms = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'sh ${HOME}/a.sh $CLAUDE_PROJECT_DIR/b.sh ${CLODENT_PROJECT_DIR}/c.sh $HOMER/d.sh' }] }] } };
  assert.deepEqual(hookPaths(forms, { cwd: '/work', env: { HOME: '/home/v', CLAUDE_PROJECT_DIR: '/proj' }, home: '/home/u' }), [
    '/home/v/a.sh',
    '/proj/b.sh',
    '/work/c.sh',
    '/work/$HOMER/d.sh',
  ]);
});

test('accept-edits allows a Write inside the cwd or an extra dir', () => {
  for (const file_path of ['/work/a.js', 'src/b.js', '/extra/c.txt']) {
    assert.deepEqual(decide(WRITE, { file_path }, 'accept-edits', '/work', SCOPE), { allow: true }, file_path);
  }
});

test('accept-edits asks for a Write outside the cwd and the extra dirs, compared on whole path segments, or with no file_path', () => {
  for (const file_path of ['/work-other/x', '../x', '/home/u/.bashrc']) {
    assert.deepEqual(decide(WRITE, { file_path }, 'accept-edits', '/work', SCOPE), ASKED, file_path);
  }
  assert.deepEqual(decide(WRITE, {}, 'accept-edits', '/work', SCOPE), ASKED);
});

test('accept-edits asks for a Write with a .git, .clodent or .claude component in any case', () => {
  for (const file_path of ['/work/.clodent/hooks/pre.sh', '/work/.CLAUDE/settings.json', '/work/.git/config']) {
    assert.deepEqual(decide(WRITE, { file_path }, 'accept-edits', '/work', SCOPE), ASKED, file_path);
  }
});

test('accept-edits asks for a Write or Edit to a file a hook or statusLine command names, in any case', () => {
  for (const file_path of ['/work/scripts/pre.sh', '/home/u/bin/status.sh', '/work/SCRIPTS/pre.sh']) {
    assert.deepEqual(decide(WRITE, { file_path }, 'accept-edits', '/work', SCOPE), ASKED, file_path);
  }
  assert.deepEqual(decide(tool('Edit', 'write'), { file_path: 'scripts/pre.sh' }, 'accept-edits', '/work', SCOPE), ASKED);
});

test('accept-edits with no scope allows a Write inside the cwd only', () => {
  assert.deepEqual(decide(WRITE, { file_path: '/work/a.js' }, 'accept-edits', '/work'), { allow: true });
  assert.deepEqual(decide(WRITE, { file_path: '/extra/c.txt' }, 'accept-edits', '/work'), ASKED);
});
