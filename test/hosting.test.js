import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASK_DENIAL } from '../src/agent/permission.js';
import { ASK_LINE, PASTE_ON } from '../src/repl/repl.js';
import { transcriptPath } from '../src/session/paths.js';
import { hookGroup, readJsonl, runMain, strip, textReply, toolsReply, writeSettings } from './helpers/run-main.js';
import { hookOutput, script } from './hooks/scripts.js';
import { count, PROMPT_MARK, startRepl } from './repl/harness.js';
import { plant, useTempDir } from './tools/tmp-dir.js';

const GUARD = { timeout: 10000 };
const COMMON = ['type', 'uuid', 'parentUuid', 'sessionId', 'timestamp', 'cwd', 'isSidechain', 'version', 'entrypoint', 'userType', 'gitBranch'];

async function setup(t) {
  const home = await useTempDir(t);
  const cwd = await useTempDir(t);
  const dir = await useTempDir(t);
  const log = join(dir, 'hooks.jsonl');
  const logger = await script(dir, 'log.sh', `cat >> ${JSON.stringify(log)}`);
  return { home, cwd, dir, log, logger };
}

function results(res, call = 1) {
  return strip(res.calls[call].body.messages).at(-1).content.map((block) => block.content);
}

async function exit(repl) {
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
}

test('the accepted-and-ignored flags warn once each on stderr: in -p right after the session line, in the REPL before it', GUARD, async (t) => {
  const { home, cwd } = await setup(t);
  const argv = [
    '--plugin-dir', 'a', '--plugin-dir', 'b', '--agents', '{"r":{}}', '--mcp-config', 'm.json', '--mcp-config', 'n.json',
    '--strict-mcp-config', '--allowed-tools', 'Read', '--allowedTools', 'Bash(git:*)', '--dangerously-bypass-hook-trust',
  ];
  const names = ['allowedTools', 'plugin-dir', 'agents', 'mcp-config', 'strict-mcp-config', 'dangerously-bypass-hook-trust'];
  const warned = names.map((name) => `clodent: ignoring --${name}: not supported\n`).join('');
  const res = await runMain(['-p', 'go', ...argv], { home, cwd, responses: [textReply('ok')] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, 'ok\n');
  assert.ok(res.stderr.startsWith(`[clodent:session] ${res.id}\n${warned}[clodent:cost]`), res.stderr);
  const repl = startRepl(argv, { home, cwd });
  await repl.prompts(1);
  assert.equal(repl.err.text, warned);
  assert.equal(repl.out.text, `[clodent:session] ${repl.sessionIds()[0]}\n${PROMPT_MARK}`);
  await exit(repl);
});

test('--permission-mode and --dangerously-skip-permissions act as their modes and name them in permission_mode', GUARD, async (t) => {
  const { home, cwd, dir, log, logger } = await setup(t);
  const settings = writeSettings(dir, { hooks: { SessionStart: [hookGroup('', logger)] } });
  const cases = [
    [['--permission-mode', 'default'], 'default', ASK_DENIAL],
    [['--permission-mode', 'plan'], 'plan', '--read-only: Write is not allowed'],
    [['--permission-mode', 'bypassPermissions'], 'bypassPermissions', 'wrote'],
    [['--permission-mode', 'acceptEdits'], 'acceptEdits', 'wrote'],
    [['--dangerously-skip-permissions'], 'bypassPermissions', 'wrote'],
  ];
  for (const [i, [flags, , outcome]] of cases.entries()) {
    const file = `w${i}.txt`;
    const res = await runMain(['-p', 'go', ...flags, '--settings', settings], { home, cwd, responses: [toolsReply([['Write', { file_path: file, content: 'w' }]]), textReply('done')] });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(results(res), [outcome === 'wrote' ? `Wrote 1 bytes to ${join(cwd, file)}` : outcome], flags.join(' '));
  }
  assert.deepEqual(readJsonl(log).map((input) => input.permission_mode), cases.map(([, mode]) => mode));
});

test('acceptEdits in -p runs Write, Edit and a read-only Bash command; refuses other Bash and ask-rule calls; deny rules still deny', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  await plant(cwd, { 'e.txt': 'old text' });
  const settings = writeSettings(dir, { permissions: { ask: ['Write(./asked.txt)'], deny: ['Edit(./locked.txt)'] } });
  const uses = [
    ['Write', { file_path: 'w.txt', content: 'w' }],
    ['Edit', { file_path: 'e.txt', old_string: 'old', new_string: 'new' }],
    ['Bash', { command: 'cat e.txt' }],
    ['Bash', { command: 'touch t.txt' }],
    ['Write', { file_path: 'asked.txt', content: 'a' }],
    ['Write', { file_path: 'locked.txt', content: 'l' }],
  ];
  const res = await runMain(['-p', 'go', '--permission-mode', 'acceptEdits', '--settings', settings], { home, cwd, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  const got = results(res);
  assert.deepEqual([got[0], got[2], got[3], got[4], got[5]], [
    `Wrote 1 bytes to ${join(cwd, 'w.txt')}`,
    'new text\n[exit 0]',
    ASK_DENIAL,
    ASK_DENIAL,
    'denied by settings rule Edit(./locked.txt)',
  ]);
  assert.equal(readFileSync(join(cwd, 'e.txt'), 'utf8'), 'new text');
  assert.deepEqual(['t.txt', 'asked.txt', 'locked.txt'].map((name) => existsSync(join(cwd, name))), [false, false, false]);
});

test('acceptEdits in -p runs a Write in an --add-dir dir and refuses one to the script a hook command names', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const settings = writeSettings(dir, { hooks: { PreToolUse: [hookGroup('NoSuchTool', 'bash "$CLODENT_PROJECT_DIR/scripts/pre.sh"')] } });
  const uses = [
    ['Write', { file_path: join(dir, 'c.txt'), content: 'c' }],
    ['Write', { file_path: 'scripts/pre.sh', content: 'p' }],
  ];
  const res = await runMain(['-p', 'go', '--permission-mode', 'acceptEdits', '--add-dir', dir, '--settings', settings], { home, cwd, responses: [toolsReply(uses), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(results(res), [`Wrote 1 bytes to ${join(dir, 'c.txt')}`, ASK_DENIAL]);
  assert.equal(existsSync(join(cwd, 'scripts', 'pre.sh')), false);
});

test('acceptEdits in the REPL runs a Write without asking and asks for a Bash command that is not read-only', GUARD, async (t) => {
  const { home, cwd } = await setup(t);
  const uses = [['Write', { file_path: 'w.txt', content: 'w' }], ['Bash', { command: 'touch t.txt' }]];
  const repl = startRepl(['--permission-mode', 'acceptEdits'], { home, cwd, replies: [toolsReply(uses), textReply('done')] });
  await repl.prompts(1);
  repl.stdin.type('go\r');
  await repl.until(ASK_LINE);
  assert.match(repl.out.text, /\n\[clodent:permit Bash toolu_2\] touch t\.txt\nAllow\? \[y\/n\] $/);
  assert.equal(count(repl.out.text, '[clodent:permit'), 1);
  assert.equal(readFileSync(join(cwd, 'w.txt'), 'utf8'), 'w');
  repl.stdin.type('y\r');
  await repl.prompts(2);
  assert.equal(existsSync(join(cwd, 't.txt')), true);
  await exit(repl);
});

test('a [1m] model suffix is dropped for the wire, the price, the prompt, SessionStart and the statusLine; settings model too', GUARD, async (t) => {
  const { home, cwd, dir, log, logger } = await setup(t);
  const status = join(dir, 'status.jsonl');
  const settings = writeSettings(dir, { hooks: { SessionStart: [hookGroup('', logger)] }, statusLine: { type: 'command', command: `cat >> ${JSON.stringify(status)}` } });
  const usage = { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 3, output_tokens: 7 };
  const res = await runMain(['-p', 'go', '--model', 'claude-haiku-5-5[1m]', '--settings', settings], { home, cwd, responses: [textReply('ok', usage)] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.calls[0].body.model, 'claude-haiku-5-5');
  const system = res.calls[0].body.system[0].text;
  assert.ok(system.endsWith('\nModel: claude-haiku-5-5'), system);
  assert.equal(system.includes('[1m]'), false);
  assert.equal(res.stderr.includes('no price for model'), false, res.stderr);
  assert.equal(readJsonl(log)[0].model, 'claude-haiku-5-5');
  const [line] = readJsonl(status);
  assert.deepEqual(line.model, { id: 'claude-haiku-5-5', display_name: 'claude-haiku-5-5' });
  assert.deepEqual([line.context_window.total_input_tokens, line.workspace.current_dir, line.context_window.context_window_size], [123, cwd, 200000]);
  assert.ok(line.cost.total_cost_usd > 0);
  const fromSettings = writeSettings(dir, { model: 'claude-haiku-5-5[1m]' }, 'model.json');
  const viaSettings = await runMain(['-p', 'go', '--settings', fromSettings], { home, cwd, responses: [textReply('ok')] });
  assert.equal(viaSettings.calls[0].body.model, 'claude-haiku-5-5');
});

test('/model <id>[1m] drops the suffix before the next request', GUARD, async (t) => {
  const { home, cwd } = await setup(t);
  const repl = startRepl([], { home, cwd, replies: [textReply('ok')] });
  await repl.prompts(1);
  repl.stdin.type('/model claude-haiku-5-5[1m]\r');
  await repl.prompts(2);
  assert.ok(repl.out.text.includes('clodent: model claude-haiku-5-5\n'), repl.out.text);
  repl.stdin.type('hi\r');
  await repl.prompts(3);
  assert.equal(repl.fetch.calls[0].body.model, 'claude-haiku-5-5');
  await exit(repl);
});

test('SessionStart carries model and a source of exactly startup, compact, clear or resume', GUARD, async (t) => {
  const { home, cwd, dir, log, logger } = await setup(t);
  const settings = writeSettings(dir, { hooks: { SessionStart: [hookGroup('', logger)] } });
  const repl = startRepl(['--settings', settings, '--model', 'claude-haiku-5-5[1m]'], { home, cwd, replies: [textReply('hello'), textReply('the summary')] });
  await repl.prompts(1);
  const [first] = repl.sessionIds();
  repl.stdin.type('hi\r');
  await repl.prompts(2);
  repl.stdin.type('/compact\r');
  await repl.prompts(3);
  repl.stdin.type('/clear\r');
  await repl.prompts(4);
  await exit(repl);
  const resumed = await runMain(['-p', 'again', '--resume', first, '--settings', settings], { home, cwd, responses: [textReply('ok')] });
  assert.equal(resumed.code, 0, resumed.stderr);
  const inputs = readJsonl(log);
  assert.deepEqual(inputs.map((input) => input.source), ['startup', 'compact', 'clear', 'resume']);
  assert.deepEqual(inputs.map((input) => input.model), ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']);
});

test('every transcript record carries the common fields, userType external and the branch read at the start of its turn', GUARD, async (t) => {
  const { home, cwd } = await setup(t);
  await plant(cwd, { '.git/HEAD': 'ref: refs/heads/one\n' });
  const repl = startRepl([], { home, cwd, replies: [toolsReply([['Read', { file_path: '.git/HEAD' }]]), textReply('done'), textReply('second')] });
  await repl.prompts(1);
  repl.stdin.type('first\r');
  await repl.prompts(2);
  writeFileSync(join(cwd, '.git/HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
  repl.stdin.type('again\r');
  await repl.prompts(3);
  await exit(repl);
  const records = readJsonl(transcriptPath(home, cwd, repl.sessionIds()[0]));
  records.forEach((record, i) => {
    for (const key of COMMON) assert.ok(key in record, `record ${i} lacks ${key}`);
    assert.deepEqual([record.isSidechain, record.cwd, record.userType], [false, cwd, 'external'], `record ${i}`);
  });
  assert.deepEqual(records.map((r) => [r.type, r.gitBranch]), [
    ['user', 'one'], ['assistant', 'one'], ['user', 'one'], ['assistant', 'one'], ['system', 'one'],
    ['user', 'HEAD'], ['assistant', 'HEAD'], ['system', 'HEAD'],
  ]);
});

test('ANTHROPIC_BASE_URL with a path prefix sends to <prefix>/v1/messages with x-api-key', GUARD, async (t) => {
  const { home, cwd } = await setup(t);
  const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321/agent/seat-1/anthropic' };
  const res = await runMain(['-p', 'go'], { home, cwd, env, key: 'sk-seat', responses: [textReply('ok')] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.calls[0].url, 'http://127.0.0.1:4321/agent/seat-1/anthropic/v1/messages');
  assert.equal(res.calls[0].headers['x-api-key'], 'sk-seat');
});

test('a fresh, nonexistent CLODENT_HOME with only the API key boots straight to the first REPL prompt', GUARD, async (t) => {
  const { cwd, dir } = await setup(t);
  const home = join(dir, 'never', 'made');
  const repl = startRepl([], { home, cwd });
  await repl.prompts(1);
  const [id] = repl.sessionIds();
  assert.equal(repl.out.text, `[clodent:session] ${id}\n${PASTE_ON}> `);
  assert.equal(repl.err.text, '');
  await exit(repl);
});

test('inline --system-prompt replaces the base prompt and --append-system-prompt ends it', GUARD, async (t) => {
  const { home, cwd } = await setup(t);
  const res = await runMain(['-p', 'go', '--system-prompt', 'You are terse.', '--append-system-prompt', 'Extra rule.'], { home, cwd, responses: [textReply('ok')] });
  assert.equal(res.code, 0, res.stderr);
  const system = res.calls[0].body.system[0].text;
  assert.ok(system.startsWith('You are terse.\n\n'), system);
  assert.ok(system.endsWith('\n\nExtra rule.'), system);
});

test('in the REPL default mode a PreToolUse allow runs a Write without asking, and a settings ask rule still asks', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const allow = await script(dir, 'allow.sh', `cat > /dev/null\n${hookOutput({ hookEventName: 'PreToolUse', permissionDecision: 'allow' })}`);
  const settings = writeSettings(dir, { hooks: { PreToolUse: [hookGroup('', allow)] }, permissions: { ask: ['Write(./asked.txt)'] } });
  const uses = [['Write', { file_path: 'w.txt', content: 'w' }], ['Write', { file_path: 'asked.txt', content: 'a' }]];
  const repl = startRepl(['--settings', settings], { home, cwd, replies: [toolsReply(uses), textReply('done')] });
  await repl.prompts(1);
  repl.stdin.type('go\r');
  await repl.until(ASK_LINE);
  assert.match(repl.out.text, /\n\[clodent:permit Write toolu_2\] asked\.txt\nAllow\? \[y\/n\] $/);
  assert.equal(count(repl.out.text, '[clodent:permit'), 1);
  assert.equal(existsSync(join(cwd, 'w.txt')), true);
  repl.stdin.type('y\r');
  await repl.prompts(2);
  assert.equal(readFileSync(join(cwd, 'asked.txt'), 'utf8'), 'a');
  await exit(repl);
});
