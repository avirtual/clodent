import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ASK_DENIAL } from '../../src/agent/permission.js';
import { ASK_LINE, PASTE_ON } from '../../src/repl/repl.js';
import { SANDBOX_NOTICE } from '../../src/settings/sandbox.js';
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

test('Grep and Glob at a symlink to a directory above a denied path do not list or search the denied files', GUARD, async (t) => {
  const { home, cwd, dir, user } = await setup(t);
  await plant(user, { '.ssh/id_rsa': 'BEGIN KEY', 'notes.txt': 'BEGIN note' });
  symlinkSync(user, join(cwd, 'h'));
  const settings = writeSettings(dir, { permissions: { deny: ['Read(~/.ssh)'] } });
  const uses = [
    ['Grep', { pattern: 'BEGIN', path: 'h', output_mode: 'content' }],
    ['Glob', { pattern: '**/*', path: 'h' }],
  ];
  const res = await runMain(['-p', 'go', '--settings', settings], { home, cwd, env: { HOME: user }, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(results(res), [`${join(cwd, 'h/notes.txt')}:1:BEGIN note`, join(cwd, 'h/notes.txt')]);
});

test('Grep and Glob hide files an ask rule matches unless --yolo, and never ask per file', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  await plant(cwd, { 'a.txt': 'needle', 'secret/b.txt': 'needle' });
  const settings = writeSettings(dir, { permissions: { ask: ['Read(./secret)'] } });
  const uses = () => toolsReply([['Grep', { pattern: 'needle' }], ['Glob', { pattern: '**/*' }]]);
  const both = `${join(cwd, 'a.txt')}\n${join(cwd, 'secret/b.txt')}`;
  for (const [flags, expected] of [[[], join(cwd, 'a.txt')], [['--read-only'], join(cwd, 'a.txt')], [['--yolo'], both]]) {
    const res = await runMain(['-p', 'go', ...flags, '--settings', settings], { home, cwd, responses: [uses(), textReply('done')] });
    assert.equal(res.code, 0, res.stderr);
    const [grep, glob] = results(res);
    assert.equal(grep, expected, flags.join(' '));
    assert.deepEqual(glob.split('\n').sort(), expected.split('\n'), flags.join(' '));
  }
  const repl = startRepl(['--settings', settings], { home, cwd, replies: [uses(), textReply('done')] });
  await repl.prompts(1);
  repl.stdin.type('look\r');
  await repl.prompts(2);
  assert.deepEqual(repl.fetch.calls[1].body.messages.at(-1).content.map((block) => block.content), [join(cwd, 'a.txt'), join(cwd, 'a.txt')]);
  assert.equal(repl.out.text.includes(ASK_LINE), false);
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
});

test('in the REPL, a Grep or Glob whose root an ask rule matches asks once and, allowed, lists the files under it', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  await plant(cwd, { 'secret/b.txt': 'needle' });
  const settings = writeSettings(dir, { permissions: { ask: ['Read(./secret)'] } });
  const grep = toolsReply([['Grep', { pattern: 'needle', path: 'secret' }]]);
  const glob = toolsReply([['Glob', { pattern: '*', path: 'secret' }]]);
  const repl = startRepl(['--settings', settings], { home, cwd, replies: [grep, textReply('done'), glob, textReply('done')] });
  for (const [n, call] of [[1, 1], [2, 3]]) {
    await repl.prompts(n);
    repl.stdin.type('look\r');
    await repl.until(ASK_LINE, n);
    repl.stdin.type('y\r');
    await repl.prompts(n + 1);
    assert.equal(repl.fetch.calls[call].body.messages.at(-1).content[0].content, join(cwd, 'secret/b.txt'), `call ${call}`);
  }
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
});

test('Grep and Glob hide a symlink in the searched tree whose target a Read rule denies', GUARD, async (t) => {
  const { home, cwd, dir, user } = await setup(t);
  await plant(user, { '.ssh/id_rsa': 'BEGIN KEY' });
  await plant(cwd, { 'notes.txt': 'BEGIN note' });
  symlinkSync(join(user, '.ssh/id_rsa'), join(cwd, 'k'));
  symlinkSync(join(cwd, 'notes.txt'), join(cwd, 'n'));
  const settings = writeSettings(dir, { permissions: { deny: ['Read(~/.ssh)'] } });
  const uses = [
    ['Grep', { pattern: 'BEGIN', output_mode: 'content' }],
    ['Glob', { pattern: '*' }],
  ];
  const res = await runMain(['-p', 'go', '--settings', settings], { home, cwd, env: { HOME: user }, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  const [grep, glob] = results(res);
  assert.deepEqual(grep.split('\n'), [`${join(cwd, 'n')}:1:BEGIN note`, `${join(cwd, 'notes.txt')}:1:BEGIN note`]);
  assert.deepEqual(glob.split('\n').sort(), [join(cwd, 'n'), join(cwd, 'notes.txt')]);
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
  assert.match(repl.out.text, /\n\[clodent:permit Read toolu_1\] a\.txt\nAllow\? \[y\/n\] $/);
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
  assert.deepEqual(res.calls[0].body.tools.map((tool) => tool.name), ['Edit', 'Glob', 'Grep', 'Read', 'Write']);
  assert.deepEqual(results(res), ['unknown tool Bash']);
});

test('the system prompt names only the tools in the request: a bare Bash or Grep deny drops the name from it', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  for (const removed of ['Bash', 'Grep']) {
    const settings = writeSettings(dir, { permissions: { deny: [removed] } }, `${removed}.json`);
    const res = await runMain(['-p', 'go', '--settings', settings], { home, cwd, responses: [textReply('done')] });
    assert.equal(res.code, 0, res.stderr);
    const [system] = res.calls[0].body.system;
    assert.match(system.text, /^- (Reach for the file tools first|Use the file tools): Read to view a file/m, removed);
    assert.doesNotMatch(system.text, new RegExp(`\\b${removed}\\b`), removed);
    assert.equal(res.calls[0].body.tools.some((tool) => tool.name === removed), false, removed);
  }
});

test('a bare Bash deny leaves every mention of a shell out of the system prompt; with Bash sent it says it runs shell commands', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const settings = writeSettings(dir, { permissions: { deny: ['Bash'] } });
  const bare = await runMain(['-p', 'go', '--settings', settings], { home, cwd, responses: [textReply('done')] });
  assert.equal(bare.code, 0, bare.stderr);
  assert.doesNotMatch(bare.calls[0].body.system[0].text, /shell/i);
  assert.match(bare.calls[0].body.system[0].text, /you read and search files, and edit and create them\. /);
  const sent = await runMain(['-p', 'go'], { home, cwd, responses: [textReply('done')] });
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.calls[0].body.system[0].text, /you read and search files, edit and create them, and run shell commands\. /);
});

test('a bare Read deny leaves reading files out of the system prompt', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const settings = writeSettings(dir, { permissions: { deny: ['Read'] } });
  const res = await runMain(['-p', 'go', '--settings', settings], { home, cwd, responses: [textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.calls[0].body.tools.some((tool) => tool.name === 'Read'), false);
  assert.doesNotMatch(res.calls[0].body.system[0].text, /read (and search )?files/);
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

test('a malformed rule, sandbox shape or --disallowedTools entry exits 2 with its message, before SessionStart and any request', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const marker = join(dir, 'session-started');
  const hooks = { SessionStart: [hookGroup('', `touch ${JSON.stringify(marker)}`)] };
  const malformed = writeSettings(dir, { hooks, permissions: { deny: ['Read(x'] } }, 'malformed.json');
  const badSandbox = writeSettings(dir, { hooks, sandbox: { enabled: true, filesystem: { denyRead: '~/.ssh' } } }, 'sandbox.json');
  const exits = async (argv, stderr) => {
    const res = await runMain(['-p', 'go', ...argv], { home, cwd, responses: [textReply('never')] });
    assert.deepEqual([res.code, res.stdout, res.stderr, res.calls.length], [2, '', stderr, 0], argv.join(' '));
  };
  await exits(['--settings', malformed], `clodent: settings ${malformed}: permissions.deny[0] "Read(x": unbalanced parenthesis\n`);
  await exits(['--settings', badSandbox], `clodent: settings ${badSandbox}: sandbox.filesystem.denyRead is not an array\n`);
  const plain = writeSettings(dir, { hooks }, 'plain.json');
  await exits(['--settings', plain, '--disallowedTools', 'Bash Edit()'], 'clodent: --disallowedTools: "Edit()": empty () on Edit\n');
  const homeSandbox = writeSettings(home, { hooks, sandbox: { enabled: true, credentials: { envVars: [{ mode: 'deny' }] } } });
  await exits([], `clodent: settings ${homeSandbox}: sandbox.credentials.envVars[0].name is not a string\n`);
  const repl = startRepl([], { home, cwd });
  assert.equal(await repl.done, 2);
  assert.equal(repl.out.text.includes(PASTE_ON), false);
  assert.equal(repl.err.text, `clodent: settings ${homeSandbox}: sandbox.credentials.envVars[0].name is not a string\n`);
  assert.equal(repl.fetch.calls.length, 0);
  assert.equal(existsSync(marker), false);
});

function guardedFixture(user) {
  return JSON.parse(readFileSync(FIXTURE, 'utf8').replaceAll('/Users/<user>', user));
}

test('the Clodex guarded-hand settings, sandbox block included, boot with the sandbox notice, guard the seat secrets and leave its work dirs usable', GUARD, async (t) => {
  const { home, cwd, dir, user } = await setup(t);
  const guarded = guardedFixture(user);
  assert.equal(guarded.sandbox.enabled, true);
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
  assert.equal(res.stderr.split('\n')[1], `clodent: settings ${settings}: ${SANDBOX_NOTICE}`);
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

test('a path only the sandbox denyRead names is refused to Read and to a Bash cat, under --dangerously-skip-permissions', GUARD, async (t) => {
  const { home, cwd, dir, user } = await setup(t);
  const guarded = guardedFixture(user);
  guarded.sandbox.filesystem.denyRead.push(join(user, 'vault'));
  const settings = writeSettings(dir, guarded);
  await plant(user, { 'vault/k.txt': 'KEY', 'open/o.txt': 'open' });
  const uses = [
    ['Read', { file_path: join(user, 'vault/k.txt') }],
    ['Bash', { command: 'cat ~/vault/k.txt' }],
    ['Bash', { command: 'cat ~/open/o.txt' }],
  ];
  const res = await runMain(['-p', 'go', '--dangerously-skip-permissions', '--settings', settings], { home, cwd, env: { HOME: user }, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(results(res), [denied(`Read(/${user}/vault)`), denied(`Read(/${user}/vault)`), 'open\n[exit 0]']);
});

test('sandbox credentials envVars are absent from Bash env, while hooks keep the full environment', GUARD, async (t) => {
  const { home, cwd, dir, user } = await setup(t);
  const seen = join(dir, 'hook-env.txt');
  const hook = await script(dir, 'pre.sh', `cat > /dev/null\nprintf '%s %s' "$GITHUB_TOKEN" "$AWS_ACCESS_KEY_ID" > ${JSON.stringify(seen)}`);
  const settings = writeSettings(dir, { ...guardedFixture(user), hooks: { PreToolUse: [hookGroup('Bash', hook)] } });
  const uses = [['Bash', { command: "env | grep -E '^(GITHUB_TOKEN|AWS_ACCESS_KEY_ID|KEEP_ME)='" }]];
  const env = { HOME: user, GITHUB_TOKEN: 'ghp_secret', AWS_ACCESS_KEY_ID: 'AKIA', KEEP_ME: 'kept' };
  const res = await runMain(['-p', 'go', '--yolo', '--settings', settings], { home, cwd, env, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(results(res), ['KEEP_ME=kept\n[exit 0]']);
  assert.equal(readFileSync(seen, 'utf8'), 'ghp_secret AKIA');
});

test('--disallowedTools and --disallowed-tools add deny rules after the settings ones, enforced under --dangerously-skip-permissions', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  await plant(cwd, { 'a.txt': 'alpha', 'b.txt': 'beta' });
  const settings = writeSettings(dir, { permissions: { deny: ['Read(./a.txt)'] } });
  const uses = [
    ['Read', { file_path: 'a.txt' }],
    ['Read', { file_path: 'b.txt' }],
    ['Bash', { command: 'git push origin' }],
    ['Bash', { command: 'echo ok' }],
    ['Write', { file_path: 'c.txt', content: 'c' }],
  ];
  const argv = ['-p', 'go', '--dangerously-skip-permissions', '--settings', settings, '--disallowedTools', 'Read(./a.txt),Read(./b.txt) WebFetch', '--disallowed-tools', 'Bash(git push:*), Write'];
  const res = await runMain(argv, { home, cwd, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.calls[0].body.tools.map((tool) => tool.name), ['Bash', 'Edit', 'Glob', 'Grep', 'Read']);
  assert.deepEqual(results(res), [denied('Read(./a.txt)'), denied('Read(./b.txt)'), denied('Bash(git push:*)'), 'ok\n[exit 0]', 'unknown tool Write']);
  assert.equal(existsSync(join(cwd, 'c.txt')), false);
});

test('--disallowedTools Bash leaves Bash out of the request tools and every system prompt; sandbox rules remove no tool', GUARD, async (t) => {
  const { home, cwd, dir, user } = await setup(t);
  const named = (res, call = 0) => [res.calls[call].body.tools.map((tool) => tool.name), res.calls[call].body.system[0].text.includes('Bash')];
  const res = await runMain(['-p', 'go', '--disallowedTools', 'Bash'], { home, cwd, responses: [textReply('ok')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(named(res), [['Edit', 'Glob', 'Grep', 'Read', 'Write'], false]);
  const repl = startRepl(['--disallowed-tools', 'Bash'], { home, cwd, replies: [textReply('ok')] });
  await repl.prompts(1);
  repl.stdin.type('/model claude-haiku-5-5\r');
  await repl.prompts(2);
  repl.stdin.type('hi\r');
  await repl.prompts(3);
  assert.deepEqual(named(repl.fetch), [['Edit', 'Glob', 'Grep', 'Read', 'Write'], false]);
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
  const settings = writeSettings(dir, guardedFixture(user));
  const guarded = await runMain(['-p', 'go', '--settings', settings], { home, cwd, env: { HOME: user }, responses: [textReply('ok')] });
  assert.equal(guarded.code, 0, guarded.stderr);
  assert.deepEqual(named(guarded), [['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'], true]);
});
