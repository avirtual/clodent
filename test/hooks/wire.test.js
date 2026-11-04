import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INTERRUPT_MARKER } from '../../src/agent/loop.js';
import { transcriptPath } from '../../src/session/paths.js';
import { hookGroup, readJsonl, runMain, strip, textReply, toolsReply, writeSettings } from '../helpers/run-main.js';
import { assertValidHistory } from '../helpers/valid-history.js';
import { useTempDir } from '../tools/tmp-dir.js';
import { hookOutput, script } from './scripts.js';

const GUARD = { timeout: 10000 };
const COMMON = ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'permission_mode'];

async function setup(t) {
  const home = await useTempDir(t);
  const cwd = await useTempDir(t);
  const dir = await useTempDir(t);
  writeFileSync(join(cwd, 'notes.md'), 'alpha\n');
  const log = join(dir, 'hooks.jsonl');
  const logger = await script(dir, 'log.sh', `cat >> ${JSON.stringify(log)}`);
  return { home, cwd, dir, log, logger };
}

function contextHook(dir, name, event, text) {
  return script(dir, name, `cat > /dev/null\n${hookOutput({ hookEventName: event, additionalContext: text })}`);
}

function block(event, ...texts) {
  return { type: 'text', text: `<hook-context event="${event}">\n${texts.join('\n\n')}\n</hook-context>` };
}

function eventsIn(log) {
  return existsSync(log) ? readJsonl(log).map((input) => input.hook_event_name) : [];
}

test('-p fires SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop in order, each with the common fields', GUARD, async (t) => {
  const { home, cwd, dir, log, logger } = await setup(t);
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Notification', 'PreCompact'];
  const settings = writeSettings(dir, { hooks: Object.fromEntries(events.map((event) => [event, [hookGroup('', logger)]])) });
  const res = await runMain(['-p', 'go', '--yolo', '--settings', settings], {
    home,
    cwd,
    responses: [toolsReply([['Bash', { command: 'echo hi' }]]), textReply('done')],
  });
  assert.equal(res.code, 0, res.stderr);
  const inputs = readJsonl(log);
  assert.deepEqual(inputs.map((input) => input.hook_event_name), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
  const path = transcriptPath(home, cwd, res.id);
  assert.ok(existsSync(path));
  for (const input of inputs) {
    for (const key of COMMON) assert.ok(key in input, `${input.hook_event_name} lacks ${key}`);
    assert.deepEqual([input.session_id, input.transcript_path, input.cwd, input.permission_mode], [res.id, path, cwd, 'bypassPermissions']);
  }
  const [start, submit, pre, post, stop] = inputs;
  assert.equal(start.source, 'startup');
  assert.equal(submit.prompt, 'go');
  assert.deepEqual([pre.tool_name, pre.tool_input, pre.tool_use_id], ['Bash', { command: 'echo hi' }, 'toolu_1']);
  assert.deepEqual([post.tool_name, post.tool_input, post.tool_use_id], ['Bash', { command: 'echo hi' }, 'toolu_1']);
  assert.deepEqual(post.tool_response, { content: 'hi\n[exit 0]', isError: false });
  assert.equal(stop.stop_hook_active, false);
  const records = readJsonl(path);
  assert.equal(records.at(-1).subtype, 'turn_duration');
});

test('permission_mode maps ask to default and --read-only to plan', GUARD, async (t) => {
  const { home, cwd, dir, log, logger } = await setup(t);
  const settings = writeSettings(dir, { hooks: { SessionStart: [hookGroup('', logger)] } });
  await runMain(['-p', 'a', '--settings', settings], { home, cwd, responses: [textReply('one')] });
  await runMain(['-p', 'b', '--read-only', '--settings', settings], { home, cwd, responses: [textReply('two')] });
  assert.deepEqual(readJsonl(log).map((input) => input.permission_mode), ['default', 'plan']);
});

test('SessionStart context goes before the prompt in the first request and the transcript; UserPromptSubmit context goes after it', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const named = await contextHook(dir, 'named.sh', 'SessionStart', 'You are the clodex agent named x.');
  const team = await contextHook(dir, 'team.sh', 'SessionStart', 'team block');
  const ack = await contextHook(dir, 'ack.sh', 'UserPromptSubmit', 'ack 1');
  const settings = writeSettings(dir, { hooks: { SessionStart: [hookGroup('', named, team)], UserPromptSubmit: [hookGroup('', ack)] } });
  const res = await runMain(['-p', 'go', '--settings', settings], { home, cwd, responses: [textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  const expected = [block('SessionStart', 'You are the clodex agent named x.', 'team block'), { type: 'text', text: 'go' }, block('UserPromptSubmit', 'ack 1')];
  assert.deepEqual(strip(res.calls[0].body.messages), [{ role: 'user', content: expected }]);
  assert.deepEqual(readJsonl(transcriptPath(home, cwd, res.id))[0].message.content, expected);
});

test('--resume fires SessionStart with source resume, and its context follows the interrupt marker', GUARD, async (t) => {
  const { home, cwd, dir, log } = await setup(t);
  const start = await script(dir, 'start.sh', `cat >> ${JSON.stringify(log)}\n${hookOutput({ hookEventName: 'SessionStart', additionalContext: 'briefing' })}`);
  const settings = writeSettings(dir, { hooks: { SessionStart: [hookGroup('', start)] } });
  const first = await runMain(['-p', 'first', '--settings', settings], { home, cwd, responses: [textReply('never')], onFetch: ({ signals }) => signals.SIGINT() });
  assert.equal(first.code, 130, first.stderr);
  const res = await runMain(['-p', 'next', '--resume', first.id, '--settings', settings], { home, cwd, responses: [textReply('ok')] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(readJsonl(log).map((input) => input.source), ['startup', 'resume']);
  const sent = strip(res.calls[0].body.messages);
  assertValidHistory(sent);
  assert.deepEqual(sent.at(-1).content.slice(-3), [{ type: 'text', text: INTERRUPT_MARKER }, block('SessionStart', 'briefing'), { type: 'text', text: 'next' }]);
});

test('PostToolUse context goes after every tool_result block and the request stays valid', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const post = await script(
    dir,
    'post.sh',
    `id=$(grep -o '"tool_use_id":"[^"]*"' | cut -d'"' -f4)\nprintf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"post %s"}}\\n' "$id"`,
  );
  const settings = writeSettings(dir, { hooks: { PostToolUse: [hookGroup('Read', post)] } });
  const res = await runMain(['-p', 'read twice', '--settings', settings], {
    home,
    cwd,
    responses: [toolsReply([['Read', { file_path: 'notes.md' }], ['Read', { file_path: 'notes.md' }]]), textReply('done')],
  });
  assert.equal(res.code, 0, res.stderr);
  const sent = strip(res.calls[1].body.messages);
  assertValidHistory(sent);
  assert.deepEqual(sent[2].content.map((b) => b.type), ['tool_result', 'tool_result', 'text']);
  assert.deepEqual(sent[2].content[2], block('PostToolUse', 'post toolu_1', 'post toolu_2'));
  const records = readJsonl(transcriptPath(home, cwd, res.id));
  assert.deepEqual(records[2].message.content[2], block('PostToolUse', 'post toolu_1', 'post toolu_2'));
});

test('PostToolUseFailure fires instead of PostToolUse when the tool returns an error', GUARD, async (t) => {
  const { home, cwd, dir, log } = await setup(t);
  const failure = await script(dir, 'failure.sh', `cat >> ${JSON.stringify(log)}\n${hookOutput({ hookEventName: 'PostToolUseFailure', additionalContext: 'it failed' })}`);
  const success = await script(dir, 'success.sh', `cat >> ${JSON.stringify(log)}`);
  const settings = writeSettings(dir, { hooks: { PostToolUse: [hookGroup('', success)], PostToolUseFailure: [hookGroup('Bash', failure)] } });
  const res = await runMain(['-p', 'fail', '--yolo', '--settings', settings], {
    home,
    cwd,
    responses: [toolsReply([['Bash', { command: 'exit 3' }]]), textReply('done')],
  });
  assert.equal(res.code, 0, res.stderr);
  const [input] = readJsonl(log);
  assert.equal(readJsonl(log).length, 1);
  assert.equal(input.hook_event_name, 'PostToolUseFailure');
  assert.deepEqual(input.tool_response, { content: '[exit 3]', isError: true });
  assert.equal(input.error, '[exit 3]');
  const sent = strip(res.calls[1].body.messages);
  assert.deepEqual(sent[2].content.at(-1), block('PostToolUseFailure', 'it failed'));
});

test('a PreToolUse deny returns the reason as an error result, the tool never runs, and no PostToolUse fires', GUARD, async (t) => {
  const { home, cwd, dir, log, logger } = await setup(t);
  const deny = await script(dir, 'deny.sh', `cat > /dev/null\n${hookOutput({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no touching' })}`);
  const settings = writeSettings(dir, { hooks: { PreToolUse: [hookGroup('Bash', deny)], PostToolUse: [hookGroup('', logger)], PostToolUseFailure: [hookGroup('', logger)] } });
  const res = await runMain(['-p', 'touch', '--yolo', '--settings', settings], {
    home,
    cwd,
    responses: [toolsReply([['Bash', { command: 'touch ran' }]]), textReply('done')],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(strip(res.calls[1].body.messages)[2].content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'no touching', is_error: true }]);
  assert.equal(existsSync(join(cwd, 'ran')), false);
  assert.deepEqual(eventsIn(log), []);
  assert.match(res.stderr, /^ {2}✗ no touching$/m);
});

test('a PreToolUse allow lets Write run under ask, but not under --read-only', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const allow = await script(dir, 'allow.sh', `cat > /dev/null\n${hookOutput({ hookEventName: 'PreToolUse', permissionDecision: 'allow' })}`);
  const settings = writeSettings(dir, { hooks: { PreToolUse: [hookGroup('', allow)] } });
  const write = (name) => [toolsReply([['Write', { file_path: name, content: 'x' }]]), textReply('done')];
  const asked = await runMain(['-p', 'write', '--settings', settings], { home, cwd, responses: write('asked.txt') });
  assert.equal(asked.code, 0, asked.stderr);
  assert.equal(readFileSync(join(cwd, 'asked.txt'), 'utf8'), 'x');
  const readOnly = await runMain(['-p', 'write', '--read-only', '--settings', settings], { home, cwd, responses: write('refused.txt') });
  assert.equal(readOnly.code, 0, readOnly.stderr);
  assert.equal(existsSync(join(cwd, 'refused.txt')), false);
  assert.deepEqual(strip(readOnly.calls[1].body.messages)[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'toolu_1',
    content: '--read-only: Write is not allowed',
    is_error: true,
  });
});

test('PreToolUse updatedInput changes what Bash runs while the history keeps the model input', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const rewrite = await script(dir, 'rewrite.sh', `cat > /dev/null\n${hookOutput({ hookEventName: 'PreToolUse', updatedInput: { command: 'echo changed' } })}`);
  const settings = writeSettings(dir, { hooks: { PreToolUse: [hookGroup('Bash', rewrite)] } });
  const res = await runMain(['-p', 'run', '--yolo', '--settings', settings], {
    home,
    cwd,
    responses: [toolsReply([['Bash', { command: 'echo original' }]]), textReply('done')],
  });
  assert.equal(res.code, 0, res.stderr);
  const sent = strip(res.calls[1].body.messages);
  assert.deepEqual(sent[1].content[0].input, { command: 'echo original' });
  assert.deepEqual(sent[2].content[0], { type: 'tool_result', tool_use_id: 'toolu_1', content: 'changed\n[exit 0]', is_error: false });
  assert.match(res.stderr, /^● Bash echo changed$/m);
  const records = readJsonl(transcriptPath(home, cwd, res.id));
  assert.deepEqual(records[1].message.content[0].input, { command: 'echo original' });
  assert.deepEqual(records[2].toolUseResult, { name: 'Bash', isError: false, input: { command: 'echo changed' } });
});

test('a failing UserPromptSubmit hook only warns and the turn completes', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const broken = await script(dir, 'broken.sh', 'exit 1');
  const settings = writeSettings(dir, { hooks: { UserPromptSubmit: [hookGroup('', broken)] } });
  const res = await runMain(['-p', 'go', '--settings', settings], { home, cwd, responses: [textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, 'done\n');
  assert.ok(res.stderr.split('\n').includes(`clay: hook UserPromptSubmit "${broken.slice(0, 60)}": exit 1`), res.stderr);
  assert.deepEqual(strip(res.calls[0].body.messages), [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]);
});

test('statusLine gets the request usage, window, cost and ids after each request, and the last run lands before exit', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const status = join(cwd, 'status.jsonl');
  const settings = writeSettings(dir, { statusLine: { type: 'command', command: `cat >> ${JSON.stringify(status)}` } });
  const usage = { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 20 };
  const res = await runMain(['-p', 'go', '--yolo', '--settings', settings], {
    home,
    cwd,
    responses: [toolsReply([['Bash', { command: 'until [ -s status.jsonl ]; do :; done', timeout: 5000 }]], usage), textReply('done', { input_tokens: 5, output_tokens: 7 })],
  });
  assert.equal(res.code, 0, res.stderr);
  const lines = readJsonl(status);
  assert.equal(lines.length, 2);
  const path = transcriptPath(home, cwd, res.id);
  const costs = readJsonl(path).filter((r) => r.type === 'assistant').map((r) => r.costUsd);
  for (const line of lines) {
    assert.deepEqual([line.session_id, line.transcript_path, line.cwd, line.model.id], [res.id, path, cwd, 'claude-opus-5-5']);
    assert.equal(line.context_window.context_window_size, 200000);
  }
  assert.deepEqual([lines[0].context_window.used_tokens, lines[0].context_window.total_input_tokens], [1250, 1230]);
  assert.deepEqual([lines[1].context_window.used_tokens, lines[1].context_window.total_input_tokens], [12, 5]);
  assert.ok(costs[0] > 0);
  assert.ok(Math.abs(lines[0].cost.total_cost_usd - costs[0]) < 1e-9);
  assert.ok(Math.abs(lines[1].cost.total_cost_usd - (costs[0] + costs[1])) < 1e-9);
});
