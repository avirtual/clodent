import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sse } from '../helpers/sse-builder.js';
import { plant, useTempDir } from '../tools/tmp-dir.js';
import { kinds, parseRecords, readSession, STDIO, stallingReply, startStream, stdinOf, STREAM_ARGV, UUID } from './harness.js';

const GUARD = { timeout: 5000 };

function emitted(lines) {
  return lines.filter((line) => !line.startsWith('#')).map((line) => JSON.parse(line));
}

function replyFor(assistant, swap = (block) => block) {
  const blocks = assistant.message.content.map(swap);
  return { body: sse({ blocks, stopReason: blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn' }) };
}

function section(lines, from, to) {
  const start = from === null ? 0 : lines.findIndex((line) => line.startsWith(from)) + 1;
  const end = to === null ? lines.length : lines.findIndex((line) => line.startsWith(to));
  return lines.slice(start, end);
}

function assertCodecFields(got, expected, { interrupted = false } = {}) {
  assert.deepEqual(kinds(got).filter((kind) => kind !== 'control_response'), kinds(expected));
  const ours = got.filter((record) => record.type !== 'control_response');
  ours.forEach((record, i) => {
    const want = expected[i];
    if (record.type === 'system' && record.subtype === 'init') {
      assert.equal(record.session_id, UUID);
      assert.equal(record.model, 'claude-opus-5-5');
    }
    if (record.type === 'result') {
      assert.equal(typeof record.duration_ms, 'number');
      assert.equal(typeof record.total_cost_usd, 'number');
      assert.equal(record.is_error, want.is_error);
      if (!interrupted) assert.ok(record.total_cost_usd > 0);
      if (!interrupted) assert.equal(record.result, want.result);
    }
    if (record.type === 'control_request') {
      assert.match(record.request_id, /^[0-9a-f-]{36}$/);
      assert.equal(record.request.subtype, want.request.subtype);
      assert.equal(record.request.tool_name, want.request.tool_name);
      const use = ours[i - 1].message.content.find((block) => block.type === 'tool_use');
      assert.deepEqual(record.request.input, use.input);
    }
  });
}

async function dirs(t) {
  return { home: await useTempDir(t), cwd: await useTempDir(t) };
}

test('session-basic: init, assistant, result, with the fields Clodex reads', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const lines = readSession('session-basic.jsonl');
  const expected = emitted(lines);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, ...STDIO], { home, cwd });
  for (const record of stdinOf(lines)) s.send(record);
  await s.fetch.called(1);
  s.clock.t = 1330;
  s.fetch.push(replyFor(expected[1]));
  await s.until('result');
  s.close();
  assert.equal(await s.done, 0);
  const got = parseRecords(s.out.text);
  assertCodecFields(got, expected);
  assert.equal(got.at(-1).duration_ms, 1330);
  assert.deepEqual(s.fetch.calls[0].body.messages.at(-1).content.at(-1).text, 'Reply with the single word NOTED.');
});

test('session-tool: the tool_use, its tool_result user line, the answer, then one result', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  await plant(cwd, { 'docs/DESIGN.md': 'x\n'.repeat(210) });
  const lines = readSession('session-tool.jsonl');
  const expected = emitted(lines);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, ...STDIO], { home, cwd, replies: [replyFor(expected[1]), replyFor(expected[3])] });
  for (const record of stdinOf(lines)) s.send(record);
  await s.until('result');
  s.close();
  assert.equal(await s.done, 0);
  const got = parseRecords(s.out.text);
  assertCodecFields(got, expected);
  const [result] = got[2].message.content;
  assert.equal(result.tool_use_id, 'toolu_01Adbs7yzWMhKVXywkHPLaJJ');
  assert.equal(result.is_error, false);
  assert.match(result.content, /210 docs\/DESIGN\.md/);
});

async function permissionRun(t, choice) {
  const { home, cwd } = await dirs(t);
  const lines = readSession('session-permission.jsonl');
  const head = section(lines, null, '# -- continuation after "allow"');
  const tail = choice === 'deny' ? section(lines, '# -- continuation after "deny"', null) : section(lines, '# -- continuation after "allow"', '# -- continuation after "deny"');
  const expected = [...emitted(head), ...emitted(tail)];
  const target = join(cwd, 'hello.txt');
  const swap = (block) => (block.type === 'tool_use' ? { ...block, input: { ...block.input, file_path: target } } : block);
  const answer = expected.findLast((record) => record.type === 'assistant');
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, ...STDIO], { home, cwd, replies: [replyFor(expected[1], swap), replyFor(answer)] });
  const [prompt, ...replies] = stdinOf(head);
  s.send(prompt);
  const [ask] = (await s.until('control_request')).filter((record) => record.type === 'control_request');
  const reply = replies.find((record) => (choice === 'deny' ? record.response.response.behavior === 'deny' : choice === 'allow-always' ? record.response.response.updatedPermissions : record.response.response.behavior === 'allow' && !record.response.response.updatedPermissions));
  const sent = structuredClone(reply);
  sent.response.request_id = ask.request_id;
  if (sent.response.response.updatedInput) sent.response.response.updatedInput = ask.request.input;
  s.send(sent);
  await s.until('result');
  s.close();
  assert.equal(await s.done, 0);
  const got = parseRecords(s.out.text);
  assertCodecFields(got, expected);
  return { got, target, s };
}

test('session-permission allow: control_request, then the call runs with its own input', GUARD, async (t) => {
  const { got, target } = await permissionRun(t, 'allow');
  assert.equal(readFileSync(target, 'utf8'), 'hello');
  assert.equal(got[2].request.tool_use_id, 'toolu_014yUj93zRjJVijXGGzYnzae');
  assert.equal(got[2].request.display_name, 'Write');
  assert.equal(got[2].request.description, target);
  assert.deepEqual(got[2].request.permission_suggestions, []);
  assert.equal(got[3].message.content[0].is_error, false);
});

test('session-permission allow-always: updatedPermissions is ignored and the call runs', GUARD, async (t) => {
  const { target } = await permissionRun(t, 'allow-always');
  assert.equal(readFileSync(target, 'utf8'), 'hello');
});

test('session-permission deny: permission_denied, then the reply message as the error tool_result', GUARD, async (t) => {
  const { got, target } = await permissionRun(t, 'deny');
  assert.equal(existsSync(target), false);
  const denied = got.find((record) => record.subtype === 'permission_denied');
  assert.deepEqual([denied.tool_name, denied.tool_use_id, denied.message, denied.session_id], ['Write', 'toolu_014yUj93zRjJVijXGGzYnzae', 'Denied by the operator in Clodex.', UUID]);
  const [result] = got.find((record) => record.type === 'user').message.content;
  assert.deepEqual([result.content, result.is_error], ['Denied by the operator in Clodex.', true]);
});

test('session-interrupt: the partial answer, the interrupt line and a success result after the ack', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const lines = readSession('session-interrupt.jsonl');
  const expected = emitted(lines);
  const stall = stallingReply(expected[1].message.content);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, ...STDIO], { home, cwd, replies: [stall] });
  const [prompt, interrupt] = stdinOf(lines);
  s.send(prompt);
  await stall.drained;
  await new Promise((resolve) => setImmediate(resolve));
  s.send(interrupt);
  await s.until('result');
  s.close();
  assert.equal(await s.done, 0);
  const got = parseRecords(s.out.text);
  assertCodecFields(got, expected, { interrupted: true });
  assert.deepEqual(kinds(got), ['system/init', 'control_response', 'assistant', 'user', 'result']);
  assert.deepEqual(got[1].response, { subtype: 'success', request_id: 'clodex-interrupt-1' });
  assert.deepEqual(got[3].message.content, [{ type: 'text', text: '[Request interrupted by user]' }]);
  const result = got.at(-1);
  assert.deepEqual([result.subtype, result.is_error, result.stop_reason, result.result], ['success', false, null, '1\n2\n3\n4\n']);
});
