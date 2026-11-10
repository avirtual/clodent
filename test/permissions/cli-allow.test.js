import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ASK_DENIAL } from '../../src/agent/permission.js';
import { hookGroup, runMain, strip, textReply, toolsReply, writeSettings } from '../helpers/run-main.js';
import { plant, useTempDir } from '../tools/tmp-dir.js';

const GUARD = { timeout: 5000 };

async function setup(t) {
  return { home: await useTempDir(t), cwd: await useTempDir(t), dir: await useTempDir(t), user: await useTempDir(t) };
}

function results(res, call = 1) {
  return strip(res.calls[call].body.messages).at(-1).content.map((block) => block.content);
}

test('settings permissions.allow and --allowedTools run matching calls in -p without asking; other calls and --read-only still refuse', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const settings = writeSettings(dir, { permissions: { allow: ['Write(./src/**)'] } });
  const uses = [
    ['Write', { file_path: 'src/a.txt', content: 'a' }],
    ['Write', { file_path: 'lib/b.txt', content: 'b' }],
    ['Bash', { command: 'touch made.txt' }],
    ['Bash', { command: 'touch x.txt && rm made.txt' }],
  ];
  const argv = ['-p', 'go', '--settings', settings, '--allowedTools', 'Bash(touch:*),Edit', '--allowed-tools', 'WebFetch'];
  const res = await runMain(argv, { home, cwd, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr.includes('ignoring'), false, res.stderr);
  const [wrote, refused, touched, compound] = results(res);
  assert.deepEqual([wrote, refused, compound], [`Wrote 1 bytes to ${join(cwd, 'src/a.txt')}`, ASK_DENIAL, ASK_DENIAL]);
  assert.notEqual(touched, ASK_DENIAL);
  assert.deepEqual(['src/a.txt', 'lib/b.txt', 'made.txt', 'x.txt'].map((name) => existsSync(join(cwd, name))), [true, false, true, false]);

  const readOnly = await runMain(['-p', 'go', '--read-only', '--settings', settings], { home, cwd, responses: [toolsReply([uses[0]]), textReply('done')] });
  assert.deepEqual(results(readOnly), ['--read-only: Write is not allowed']);
});

test('under an allow rule, writes to a hook script, .git and through a symlink out of the allowed directory still ask', GUARD, async (t) => {
  const { home, cwd, dir, user } = await setup(t);
  await plant(cwd, { 'hooks/stop.sh': 'exit 0\n', 'src/keep.txt': 'k', '.git/config': 'c' });
  symlinkSync(user, join(cwd, 'src/link'));
  const settings = writeSettings(dir, {
    hooks: { Stop: [hookGroup('', `bash ${join(cwd, 'hooks/stop.sh')}`)] },
    permissions: { allow: ['Write(./**)', 'Bash'] },
  });
  const uses = [
    ['Write', { file_path: 'hooks/stop.sh', content: 'evil' }],
    ['Bash', { command: 'echo evil > hooks/stop.sh' }],
    ['Write', { file_path: '.git/config', content: 'evil' }],
    ['Write', { file_path: 'src/link/out.txt', content: 'evil' }],
    ['Write', { file_path: 'src/ok.txt', content: 'ok' }],
  ];
  const res = await runMain(['-p', 'go', '--settings', settings], { home, cwd, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(results(res), [ASK_DENIAL, ASK_DENIAL, ASK_DENIAL, ASK_DENIAL, `Wrote 2 bytes to ${join(cwd, 'src/ok.txt')}`]);
  assert.deepEqual([readFileSync(join(cwd, 'hooks/stop.sh'), 'utf8'), readFileSync(join(cwd, '.git/config'), 'utf8')], ['exit 0\n', 'c']);
  assert.equal(existsSync(join(user, 'out.txt')), false);
});

test('under an allow rule, a Bash write to a hook script that does not exist yet asks; a bare hook word such as node is not protected', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  await plant(cwd, { 'hooks/readme.txt': 'r' });
  const settings = writeSettings(dir, {
    hooks: { PreCompact: [hookGroup('', `node ${join(cwd, 'hooks/later.js')}`)] },
    permissions: { allow: ['Bash'] },
  });
  const uses = [
    ['Bash', { command: 'echo evil > hooks/later.js' }],
    ['Bash', { command: 'touch node' }],
  ];
  const res = await runMain(['-p', 'go', '--settings', settings], { home, cwd, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  const [script, bare] = results(res);
  assert.equal(script, ASK_DENIAL);
  assert.notEqual(bare, ASK_DENIAL);
  assert.deepEqual(['hooks/later.js', 'node'].map((name) => existsSync(join(cwd, name))), [false, true]);
});

test('a malformed --allowedTools or permissions.allow entry exits 2 with its message before any request', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const exits = async (argv, stderr) => {
    const res = await runMain(['-p', 'go', ...argv], { home, cwd, responses: [textReply('never')] });
    assert.deepEqual([res.code, res.stdout, res.stderr, res.calls.length], [2, '', stderr, 0], argv.join(' '));
  };
  await exits(['--allowedTools', 'Bash(git log:*) Edit()'], 'clodent: --allowedTools: "Edit()": empty () on Edit\n');
  await exits(['--allowed-tools', 'read'], 'clodent: --allowedTools: "read": tool name "read" is not exactly Read\n');
  const malformed = writeSettings(dir, { permissions: { allow: ['Bash(ls:*)', 'Read(x'] } });
  await exits(['--settings', malformed], `clodent: settings ${malformed}: permissions.allow[1] "Read(x": unbalanced parenthesis\n`);
  const parsed = await runMain(['-p', 'go', '--allowedTools', 'Bash(git log:*),Edit'], { home, cwd, responses: [textReply('fine')] });
  assert.deepEqual([parsed.code, parsed.stdout], [0, 'fine\n']);
});
