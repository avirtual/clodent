import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ASK_DENIAL } from '../../src/agent/permission.js';
import { ASK_LINE, PASTE_ON } from '../../src/repl/repl.js';
import { SANDBOX_REFUSAL } from '../../src/settings/load.js';
import { hookGroup, runMain, strip, textReply, toolsReply, writeSettings } from '../helpers/run-main.js';
import { hookOutput, script } from '../hooks/scripts.js';
import { startRepl } from '../repl/harness.js';
import { plant, useTempDir } from '../tools/tmp-dir.js';

const GUARD = { timeout: 5000 };
const FIXTURE = new URL('./fixtures/clodex-guarded-settings.json', import.meta.url);

async function setup(t) {
  return { home: await useTempDir(t), cwd: await useTempDir(t), dir: await useTempDir(t), user: await useTempDir(t) };
}

function results(res, call = 1) {
  return strip(res.calls[call].body.messages).at(-1).content.map((block) => block.content);
}

const denied = (rule) => `denied by settings rule ${rule}`;

test('Read, Edit and Write calls a deny rule matches are refused under --yolo, and the turn goes on', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  await plant(cwd, { 'secret/a.txt': 'top secret', 'locked/b.txt': 'b' });
  const settings = writeSettings(dir, { permissions: { deny: ['Read(./secret)', 'Edit(./locked/**)'] } });
  const uses = [
    ['Read', { file_path: 'secret/a.txt' }],
    ['Edit', { file_path: 'secret/a.txt', old_string: 'top', new_string: 'x' }],
    ['Write', { file_path: 'locked/b.txt', content: 'w' }],
    ['Edit', { file_path: 'locked/b.txt', old_string: 'b', new_string: 'c' }],
    ['Write', { file_path: 'locked/new/c.txt', content: 'c' }],
  ];
  const res = await runMain(['-p', 'go', '--yolo', '--settings', settings], { home, cwd, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(results(res), [denied('Read(./secret)'), denied('Read(./secret)'), denied('Edit(./locked/**)'), denied('Edit(./locked/**)'), denied('Edit(./locked/**)')]);
  assert.equal(readFileSync(join(cwd, 'secret/a.txt'), 'utf8'), 'top secret');
  assert.equal(readFileSync(join(cwd, 'locked/b.txt'), 'utf8'), 'b');
  assert.equal(existsSync(join(cwd, 'locked/new')), false);
});

test('a path through a symlink into a denied directory is refused, for an existing and a new file', GUARD, async (t) => {
  const { home, cwd, dir, user } = await setup(t);
  await plant(user, { '.ssh/id_rsa': 'KEY' });
  symlinkSync(join(user, '.ssh'), join(cwd, 'x'));
  const settings = writeSettings(dir, { permissions: { deny: ['Read(~/.ssh)', 'Edit(~/.ssh)'] } });
  const uses = [
    ['Read', { file_path: 'x/id_rsa' }],
    ['Write', { file_path: 'x/new/key', content: 'k' }],
  ];
  const res = await runMain(['-p', 'go', '--yolo', '--settings', settings], { home, cwd, env: { HOME: user }, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(results(res), [denied('Read(~/.ssh)'), denied('Edit(~/.ssh)')]);
  assert.equal(existsSync(join(user, '.ssh/new')), false);
});

test('a PreToolUse allow overrides neither a deny rule nor an ask rule', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const allow = await script(dir, 'allow.sh', `cat > /dev/null\n${hookOutput({ hookEventName: 'PreToolUse', permissionDecision: 'allow' })}`);
  const settings = writeSettings(dir, {
    hooks: { PreToolUse: [hookGroup('', allow)] },
    permissions: { deny: ['Write(./out.txt)'], ask: ['Write(./ask.txt)'] },
  });
  const uses = [
    ['Write', { file_path: 'out.txt', content: 'x' }],
    ['Write', { file_path: 'ask.txt', content: 'x' }],
    ['Write', { file_path: 'ok.txt', content: 'x' }],
  ];
  const res = await runMain(['-p', 'go', '--settings', settings], { home, cwd, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(results(res), [denied('Write(./out.txt)'), ASK_DENIAL, `Wrote 1 bytes to ${join(cwd, 'ok.txt')}`]);
  assert.deepEqual(['out.txt', 'ask.txt', 'ok.txt'].map((name) => existsSync(join(cwd, name))), [false, false, true]);
});

test('Grep and Glob skip files a Read rule denies, and refuse a denied root', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  await plant(cwd, { 'a.txt': 'needle', 'secret/b.txt': 'needle', 'deep/secret.key': 'needle' });
  const settings = writeSettings(dir, { permissions: { deny: ['Read(./secret)', 'Read(./**/*.key)'] } });
  const uses = [
    ['Grep', { pattern: 'needle' }],
    ['Glob', { pattern: '**/*' }],
    ['Grep', { pattern: 'needle', path: 'secret' }],
    ['Glob', { pattern: '*', path: 'secret' }],
    ['Grep', { pattern: 'needle', path: 'deep/secret.key' }],
  ];
  const res = await runMain(['-p', 'go', '--settings', settings], { home, cwd, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(results(res), [join(cwd, 'a.txt'), join(cwd, 'a.txt'), denied('Read(./secret)'), denied('Read(./secret)'), denied('Read(./**/*.key)')]);
});

test('an ask rule refuses in -p and under --read-only, runs under --yolo, and asks in the REPL; a deny never asks', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  await plant(cwd, { 'a.txt': 'alpha' });
  const settings = writeSettings(dir, { permissions: { ask: ['Read(./a.txt)'], deny: ['Write(./b.txt)'] } });
  const read = () => toolsReply([['Read', { file_path: 'a.txt' }]]);
  const shown = '     1\talpha';
  for (const [flags, expected] of [[[], ASK_DENIAL], [['--read-only'], ASK_DENIAL], [['--yolo'], shown]]) {
    const res = await runMain(['-p', 'go', ...flags, '--settings', settings], { home, cwd, responses: [read(), textReply('done')] });
    assert.deepEqual(results(res), [expected], flags.join(' '));
  }

  const write = toolsReply([['Write', { file_path: 'b.txt', content: 'b' }]]);
  const repl = startRepl(['--settings', settings], { home, cwd, replies: [read(), textReply('done'), write, textReply('done')] });
  await repl.prompts(1);
  repl.stdin.type('read\r');
  await repl.until(ASK_LINE);
  assert.match(repl.out.text, /\n\[clay:permit Read toolu_1\] a\.txt\nAllow\? \[y\/n\] $/);
  repl.stdin.type('y\r');
  await repl.prompts(2);
  assert.equal(repl.fetch.calls[1].body.messages.at(-1).content[0].content, shown);
  repl.stdin.type('write\r');
  await repl.prompts(3);
  assert.equal(repl.fetch.calls[3].body.messages.at(-1).content[0].content, denied('Write(./b.txt)'));
  assert.equal(repl.out.text.split(ASK_LINE).length - 1, 1);
  assert.equal(existsSync(join(cwd, 'b.txt')), false);
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
});

test('a bare Bash deny drops Bash from the request tools, so a call takes the unknown-tool path; foreign names are ignored', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const settings = writeSettings(dir, { permissions: { deny: ['Bash', 'WebFetch', 'Agent(claude-code-guide)', 'mcp__clodex__dm'] } });
  const res = await runMain(['-p', 'go', '--yolo', '--settings', settings], { home, cwd, responses: [toolsReply([['Bash', { command: 'echo hi' }]]), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.calls[0].body.tools.map((tool) => tool.name), ['Read', 'Write', 'Edit', 'Grep', 'Glob']);
  assert.deepEqual(results(res), ['unknown tool Bash']);
});

test('Bash under --yolo: a Read path mention and a Bash(prefix:*) rule deny; an Edit path passes a read-only command only', GUARD, async (t) => {
  const { home, cwd, dir, user } = await setup(t);
  await plant(user, { '.ssh/id_rsa': 'KEY', 'notes/n.txt': 'note' });
  const settings = writeSettings(dir, { permissions: { deny: ['Read(~/.ssh)', 'Edit(~/notes)', 'Bash(git push:*)'] } });
  const uses = [
    ['Bash', { command: 'cat ~/.ssh/id_rsa' }],
    ['Bash', { command: 'cat ~/notes/n.txt' }],
    ['Bash', { command: 'rm ~/notes/n.txt' }],
    ['Bash', { command: 'true && git push origin' }],
  ];
  const res = await runMain(['-p', 'go', '--yolo', '--settings', settings], { home, cwd, env: { HOME: user }, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(results(res), [denied('Read(~/.ssh)'), 'note\n[exit 0]', denied('Edit(~/notes)'), denied('Bash(git push:*)')]);
  assert.equal(existsSync(join(user, 'notes/n.txt')), true);
});

test('sandbox.enabled: true and a malformed rule exit 2 with clay: settings <path>: <message>, before SessionStart and any request', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const marker = join(dir, 'session-started');
  const hooks = { SessionStart: [hookGroup('', `touch ${JSON.stringify(marker)}`)] };
  const fixture = writeSettings(dir, { ...JSON.parse(readFileSync(FIXTURE, 'utf8')), hooks }, 'guarded.json');
  const malformed = writeSettings(dir, { hooks, permissions: { deny: ['Read(x'] } }, 'malformed.json');
  const exits = async (argv, stderr) => {
    const res = await runMain(['-p', 'go', ...argv], { home, cwd, responses: [textReply('never')] });
    assert.deepEqual([res.code, res.stdout, res.stderr, res.calls.length], [2, '', stderr, 0], argv.join(' '));
  };
  await exits(['--settings', fixture], `clay: settings ${fixture}: ${SANDBOX_REFUSAL}\n`);
  await exits(['--settings', malformed], `clay: settings ${malformed}: permissions.deny[0] "Read(x": unbalanced parenthesis\n`);
  const homeSandbox = writeSettings(home, { hooks, sandbox: { enabled: true } });
  await exits([], `clay: settings ${homeSandbox}: ${SANDBOX_REFUSAL}\n`);
  const repl = startRepl([], { home, cwd });
  assert.equal(await repl.done, 2);
  assert.equal(repl.out.text.includes(PASTE_ON), false);
  assert.equal(repl.err.text, `clay: settings ${homeSandbox}: ${SANDBOX_REFUSAL}\n`);
  assert.equal(repl.fetch.calls.length, 0);
  assert.equal(existsSync(marker), false);
});

test('the Clodex guarded-hand settings, sandbox stripped, guard the seat secrets and leave its work dirs usable', GUARD, async (t) => {
  const { home, cwd, dir, user } = await setup(t);
  const guarded = JSON.parse(readFileSync(FIXTURE, 'utf8').replaceAll('/Users/<user>', user));
  assert.equal(guarded.sandbox.enabled, true);
  delete guarded.sandbox;
  const settings = writeSettings(dir, guarded);
  await plant(user, { '.ssh/id_rsa': 'KEY', '.clodex/messages/m.txt': 'msg' });
  const uses = [
    ['Read', { file_path: join(user, '.ssh/id_rsa') }],
    ['Write', { file_path: join(user, '.clodex/sessions/x/f.txt'), content: 'f' }],
    ['Read', { file_path: join(user, '.clodex/messages/m.txt') }],
    ['Write', { file_path: join(user, '.clodex/projects/p/f.txt'), content: 'p' }],
    ['Bash', { command: 'cat ~/.ssh/id_rsa' }],
    ['Bash', { command: 'cat ~/.clodex/messages/m.txt' }],
    ['Bash', { command: 'rm ~/.clodex/messages/m.txt' }],
  ];
  const res = await runMain(['-p', 'go', '--yolo', '--settings', settings], { home, cwd, env: { HOME: user }, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(results(res), [
    denied('Read(~/.ssh)'),
    denied(`Edit(/${user}/.clodex/sessions/**)`),
    '     1\tmsg',
    `Wrote 1 bytes to ${join(user, '.clodex/projects/p/f.txt')}`,
    denied('Read(~/.ssh)'),
    'msg\n[exit 0]',
    denied(`Edit(/${user}/.clodex/messages/**)`),
  ]);
  assert.equal(existsSync(join(user, '.clodex/sessions/x')), false);
});
