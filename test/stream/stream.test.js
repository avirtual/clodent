import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASK_DENIAL } from '../../src/agent/permission.js';
import { EMPTY_PROMPT } from '../../src/stream/output.js';
import { hookGroup, runMain, textReply, toolsReply, writeSettings } from '../helpers/run-main.js';
import { useTempDir } from '../tools/tmp-dir.js';
import { kinds, parseRecords, STDIO, startStream, STREAM_ARGV, userLine, UUID } from './harness.js';

const GUARD = { timeout: 5000 };
const USAGE = { input_tokens: 1000, output_tokens: 100 };

async function dirs(t) {
  return { home: await useTempDir(t), cwd: await useTempDir(t), dir: await useTempDir(t) };
}

function results(s) {
  return parseRecords(s.out.text).filter((record) => record.type === 'result');
}

function lastUserTexts(call) {
  return call.body.messages.at(-1).content.filter((block) => block.type === 'text').map((block) => block.text);
}

test('stdout holds only JSON lines; the session, tool, cost and total lines go to stderr', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, '--plugin-dir', 'x'], {
    home,
    cwd,
    replies: [toolsReply([['Bash', { command: 'echo hi' }]]), textReply('all done')],
  });
  s.send(userLine('go'));
  await s.until('result');
  s.close();
  assert.equal(await s.done, 0);
  assert.ok(s.out.text.endsWith('\n'));
  const lines = s.out.text.slice(0, -1).split('\n');
  for (const line of lines) assert.equal(typeof JSON.parse(line), 'object', line);
  assert.deepEqual(kinds(parseRecords(s.out.text)), ['system/init', 'assistant', 'user', 'assistant', 'result']);
  assert.doesNotMatch(s.out.text, /\[clodent:|\x1b|all done\n/);
  assert.match(s.err.text, new RegExp(`^\\[clodent:session\\] ${UUID}\\nclodent: ignoring --plugin-dir: not supported\\n`));
  assert.match(s.err.text, /^● Bash echo hi$/m);
  assert.match(s.err.text, /^\[clodent:cost\] \$\d\.\d{4} \(in 200,/m);
  assert.match(s.err.text, /^\[clodent:cost\] session total /m);
});

test('init carries the session, the stripped model, the tools sent and the Claude permission mode', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, '--model', 'claude-haiku-5-5[1m]', '--permission-mode', 'acceptEdits', '--disallowedTools', 'Glob'], { home, cwd });
  s.close();
  assert.equal(await s.done, 0);
  const [init, ...rest] = parseRecords(s.out.text);
  assert.deepEqual(rest, []);
  assert.equal(init.uuid.length, 36);
  delete init.uuid;
  const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  assert.deepEqual(init, {
    type: 'system',
    subtype: 'init',
    cwd,
    session_id: UUID,
    model: 'claude-haiku-5-5',
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep'],
    permissionMode: 'acceptEdits',
    slash_commands: [],
    apiKeySource: 'ANTHROPIC_API_KEY',
    clodent_version: version,
  });
});

test('total_cost_usd is cumulative across turns, and usage and num_turns are per turn', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], {
    home,
    cwd,
    replies: [textReply('one', USAGE), toolsReply([['Bash', { command: 'echo hi' }]], USAGE), textReply('two', USAGE)],
  });
  s.send(userLine('first'));
  await s.until('result');
  s.send(userLine('second'));
  await s.until('result', 2);
  s.close();
  assert.equal(await s.done, 0);
  const [first, second] = results(s);
  assert.equal(first.total_cost_usd, 0.006);
  assert.equal(second.total_cost_usd, 0.018);
  assert.deepEqual([first.num_turns, second.num_turns], [1, 2]);
  assert.deepEqual(second.usage, { input_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200 });
  assert.deepEqual([first.result, second.result, second.stop_reason, second.subtype], ['one', 'two', 'end_turn', 'success']);
});

test('a user message sent during a turn joins the next tool result: one result, and the request carries it', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd });
  s.send(userLine('start'));
  await s.fetch.called(1);
  s.send(userLine('<system>also check B</system>'));
  s.fetch.push(toolsReply([['Bash', { command: 'echo hi' }]]));
  await s.fetch.called(2);
  s.fetch.push(textReply('done'));
  await s.until('result');
  s.close();
  assert.equal(await s.done, 0);
  assert.equal(results(s).length, 1);
  assert.equal(s.fetch.calls.length, 2);
  const last = s.fetch.calls[1].body.messages.at(-1);
  assert.equal(last.content[0].type, 'tool_result');
  assert.deepEqual(lastUserTexts(s.fetch.calls[1]), ['<system>also check B</system>']);
  const user = parseRecords(s.out.text).find((record) => record.type === 'user');
  assert.equal(user.message.content.at(-1).text, '<system>also check B</system>');
});

test('a user message sent after the last tool result runs as the next turn, in arrival order', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd, replies: [toolsReply([['Bash', { command: 'echo hi' }]])] });
  s.send(userLine('start'));
  await s.fetch.called(2);
  s.send(userLine('B'));
  s.send(userLine('C'));
  s.fetch.push(textReply('first done'));
  await s.fetch.called(3);
  s.fetch.push(textReply('B done'));
  await s.fetch.called(4);
  s.fetch.push(textReply('C done'));
  await s.until('result', 3);
  s.close();
  assert.equal(await s.done, 0);
  assert.deepEqual(results(s).map((record) => record.result), ['first done', 'B done', 'C done']);
  assert.deepEqual(lastUserTexts(s.fetch.calls[1]), []);
  assert.deepEqual(lastUserTexts(s.fetch.calls[2]), ['B']);
  assert.deepEqual(lastUserTexts(s.fetch.calls[3]), ['C']);
});

test('text blocks join with a blank line; an image-only message gets an is_error result and no request', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd, replies: [textReply('ok')] });
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  s.send(userLine([image]));
  await s.until('result');
  s.send(userLine([image, { type: 'text', text: 'one' }, { type: 'text', text: 'two' }]));
  await s.until('result', 2);
  s.close();
  assert.equal(await s.done, 0);
  const [empty, ok] = results(s);
  assert.deepEqual([empty.is_error, empty.subtype, empty.result], [true, 'error_during_execution', EMPTY_PROMPT]);
  assert.equal(ok.is_error, false);
  assert.equal(s.fetch.calls.length, 1);
  assert.deepEqual(lastUserTexts(s.fetch.calls[0]), ['one\n\ntwo']);
  assert.equal(s.err.text.split('clodent: stdin: dropped an image block: image input is not supported\n').length - 1, 2);
});

test('a line that is not JSON and a message of unknown type warn on stderr and change nothing', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd });
  s.stdin.type('hello there\n');
  s.send({ type: 'keep_alive' });
  s.close();
  assert.equal(await s.done, 0);
  assert.deepEqual(kinds(parseRecords(s.out.text)), ['system/init']);
  assert.match(s.err.text, /^clodent: stdin: ignoring a line that is not JSON: hello there$/m);
  assert.match(s.err.text, /^clodent: stdin: ignoring a message of unknown type "keep_alive"$/m);
  assert.equal(s.fetch.calls.length, 0);
});

test('stdin EOF during a turn finishes it, then exits 0 with the session total', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd });
  s.send(userLine('go'));
  s.close();
  await s.fetch.called(1);
  s.fetch.push(textReply('bye'));
  assert.equal(await s.done, 0);
  assert.deepEqual(results(s).map((record) => record.result), ['bye']);
  assert.match(s.err.text, /\[clodent:cost\] session total \S+ \(in 100, cache-read 0, cache-write 0, out 20, requests 1\)\n$/);
});

test('an interrupt while idle gets only its ack; an unknown control request gets an error reply', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd });
  s.send({ type: 'control_request', request_id: 'clodex-interrupt-1', request: { subtype: 'interrupt' } });
  s.send({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } });
  s.close();
  assert.equal(await s.done, 0);
  const [, ack, refused, ...rest] = parseRecords(s.out.text);
  assert.deepEqual(ack, { type: 'control_response', response: { subtype: 'success', request_id: 'clodex-interrupt-1' } });
  assert.deepEqual(refused, { type: 'control_response', response: { subtype: 'error', request_id: 'init-1', error: 'unsupported control request: initialize' } });
  assert.deepEqual(rest, []);
});

test('set_model acks and the next request uses the stripped model', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd, replies: [textReply('a'), textReply('b')] });
  s.send(userLine('first'));
  await s.until('result');
  s.send({ type: 'control_request', request_id: 'clodex-set-model-1', request: { subtype: 'set_model', model: 'claude-haiku-5-5[1m]' } });
  s.send(userLine('second'));
  await s.until('result', 2);
  s.close();
  assert.equal(await s.done, 0);
  const ack = parseRecords(s.out.text).find((record) => record.type === 'control_response');
  assert.deepEqual(ack.response, { subtype: 'success', request_id: 'clodex-set-model-1' });
  assert.deepEqual(s.fetch.calls.map((call) => call.body.model), ['claude-opus-5-5', 'claude-haiku-5-5']);
});

test('a set_model during a request prices that response at the model it was sent to', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd });
  s.send(userLine('go'));
  await s.fetch.called(1);
  s.send({ type: 'control_request', request_id: 'clodex-set-model-1', request: { subtype: 'set_model', model: 'claude-haiku-5-5' } });
  s.fetch.push(toolsReply([['Bash', { command: 'echo hi' }]], USAGE));
  await s.fetch.called(2);
  s.fetch.push(textReply('ok', USAGE));
  await s.until('result');
  s.close();
  assert.equal(await s.done, 0);
  assert.deepEqual(s.fetch.calls.map((call) => call.body.model), ['claude-opus-5-5', 'claude-haiku-5-5']);
  assert.equal(results(s)[0].total_cost_usd, 0.00615);
});

test('a stdio ask fires the Notification hook with notification_type permission_prompt', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const seen = join(dir, 'notification.json');
  const settings = writeSettings(dir, { hooks: { Notification: [hookGroup('', `cat > ${seen}`)] } });
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, ...STDIO, '--settings', settings], { home, cwd, replies: [toolsReply([['Write', { file_path: 'w.txt', content: 'w' }]]), textReply('ok')] });
  s.send(userLine('go'));
  const ask = (await s.until('control_request')).find((record) => record.type === 'control_request');
  s.send({ type: 'control_response', response: { subtype: 'success', request_id: ask.request_id, response: { behavior: 'allow', updatedInput: ask.request.input } } });
  await s.until('result');
  s.close();
  assert.equal(await s.done, 0);
  const notice = JSON.parse(readFileSync(seen, 'utf8'));
  assert.deepEqual([notice.hook_event_name, notice.notification_type, notice.tool, notice.id], ['Notification', 'permission_prompt', 'Write', 'toolu_1']);
  assert.equal(readFileSync(join(cwd, 'w.txt'), 'utf8'), 'w');
});

test('a permission reply for no waiting request warns and is ignored', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, ...STDIO], { home, cwd });
  s.send({ type: 'control_response', response: { subtype: 'success', request_id: 'stale-1', response: { behavior: 'allow' } } });
  s.close();
  assert.equal(await s.done, 0);
  assert.deepEqual(kinds(parseRecords(s.out.text)), ['system/init']);
  assert.match(s.err.text, /^clodent: stdin: no permission request "stale-1" is waiting; reply ignored$/m);
});

test('under bypassPermissions a deny rule refuses the call without a control_request', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const settings = writeSettings(dir, { permissions: { deny: ['Bash(rm:*)'] } });
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, ...STDIO, '--dangerously-skip-permissions', '--settings', settings], {
    home,
    cwd,
    replies: [toolsReply([['Bash', { command: 'rm -rf x' }], ['Write', { file_path: 'w.txt', content: 'w' }]]), textReply('ok')],
  });
  s.send(userLine('go'));
  await s.until('result');
  s.close();
  assert.equal(await s.done, 0);
  const records = parseRecords(s.out.text);
  assert.deepEqual(kinds(records), ['system/init', 'assistant', 'user', 'assistant', 'result']);
  assert.equal(records[0].permissionMode, 'bypassPermissions');
  const [rm, write] = records[2].message.content;
  assert.deepEqual([rm.content, rm.is_error, write.is_error], ['denied by settings rule Bash(rm:*)', true, false]);
  assert.equal(readFileSync(join(cwd, 'w.txt'), 'utf8'), 'w');
});

test('without --permission-prompt-tool an ask refuses the call with ASK_DENIAL', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], {
    home,
    cwd,
    replies: [toolsReply([['Write', { file_path: 'w.txt', content: 'w' }]]), textReply('ok')],
  });
  s.send(userLine('go'));
  await s.until('result');
  s.close();
  assert.equal(await s.done, 0);
  const records = parseRecords(s.out.text);
  assert.deepEqual(kinds(records), ['system/init', 'assistant', 'user', 'assistant', 'result']);
  assert.deepEqual(records[2].message.content[0].content, ASK_DENIAL);
});

test('an interrupt while a stdio ask waits abandons it: no call, a success result', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, ...STDIO], { home, cwd, replies: [toolsReply([['Write', { file_path: 'w.txt', content: 'w' }]])] });
  s.send(userLine('go'));
  const ask = (await s.until('control_request')).find((record) => record.type === 'control_request');
  s.send({ type: 'control_request', request_id: 'clodex-interrupt-1', request: { subtype: 'interrupt' } });
  await s.until('result');
  s.send({ type: 'control_response', response: { subtype: 'success', request_id: ask.request_id, response: { behavior: 'allow' } } });
  s.close();
  assert.equal(await s.done, 0);
  const records = parseRecords(s.out.text);
  assert.deepEqual(kinds(records), ['system/init', 'assistant', 'control_request', 'control_response', 'user', 'user', 'result']);
  assert.deepEqual([records.at(-1).is_error, records.at(-1).stop_reason, records.at(-1).result], [false, null, '']);
  assert.match(s.err.text, /no permission request "[0-9a-f-]{36}" is waiting; reply ignored/);
});

test('text input with stream-json output prints init, the messages and one result', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const res = await runMain(['-p', 'hi', '--output-format', 'stream-json', '--session-id', UUID], { home, cwd, responses: [textReply('Hello!')] });
  assert.equal(res.code, 0, res.stderr);
  const records = parseRecords(res.stdout);
  assert.deepEqual(kinds(records), ['system/init', 'assistant', 'result']);
  assert.deepEqual([records[0].session_id, records[2].result, records[2].is_error], [UUID, 'Hello!', false]);
  assert.match(res.stderr, /^\[clodent:session\] /);
});

test('a SIGTERM during a turn interrupts it, prints its result and exits 143', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd });
  s.send(userLine('go'));
  s.send(userLine('queued'));
  await s.fetch.called(1);
  s.signals.SIGTERM();
  assert.equal(await s.done, 143);
  assert.deepEqual(kinds(parseRecords(s.out.text)), ['system/init', 'user', 'result']);
  assert.equal(s.fetch.calls.length, 1);
});

function clodexTail(dir) {
  const sys = join(dir, 'sys.md');
  const append = join(dir, 'append.md');
  writeFileSync(sys, 'seat prompt');
  writeFileSync(append, 'appended');
  const settings = writeSettings(dir, {});
  return ['--model', 'claude-opus-5-5', '--dangerously-skip-permissions', '--settings', settings, '--add-dir', dir, '--add-dir', join(dir, 'm'), '--plugin-dir', dir, '--system-prompt-file', sys, '--append-system-prompt-file', append];
}

test("Clodex's fresh, resume and fork argv boot to an init with the right session id", GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const tail = clodexTail(dir);
  const fresh = startStream([...STREAM_ARGV, '--session-id', UUID, ...STDIO, ...tail], { home, cwd, replies: [textReply('saved')] });
  fresh.send(userLine('remember'));
  await fresh.until('result');
  fresh.close();
  assert.equal(await fresh.done, 0);
  assert.equal(fresh.fetch.calls[0].body.system[0].text.startsWith('seat prompt'), true);

  const resumed = startStream([...STREAM_ARGV, '--resume', UUID, ...STDIO, ...tail], { home, cwd, replies: [textReply('back')] });
  resumed.send(userLine('again'));
  await resumed.until('result');
  resumed.close();
  assert.equal(await resumed.done, 0);
  assert.equal(parseRecords(resumed.out.text)[0].session_id, UUID);
  assert.equal(resumed.fetch.calls[0].body.messages.length, 3);

  const forked = startStream([...STREAM_ARGV, '--resume', UUID, '--fork-session', ...STDIO, ...tail], { home, cwd });
  forked.close();
  assert.equal(await forked.done, 0);
  const [init] = parseRecords(forked.out.text);
  assert.match(init.session_id, /^[0-9a-f-]{36}$/);
  assert.notEqual(init.session_id, UUID);
  assert.equal(forked.err.text.split('\n')[0], `[clodent:session] ${init.session_id}`);
});
