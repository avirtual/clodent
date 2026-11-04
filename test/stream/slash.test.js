import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { COMPACT_PROMPT } from '../../src/agent/compact.js';
import { HELP } from '../../src/repl/slash.js';
import { transcriptPath } from '../../src/session/paths.js';
import { hookGroup, readJsonl, textReply, toolsReply, writeSettings } from '../helpers/run-main.js';
import { sse } from '../helpers/sse-builder.js';
import { script } from '../hooks/scripts.js';
import { useTempDir } from '../tools/tmp-dir.js';
import { kinds, parseRecords, startStream, STREAM_ARGV, userLine, UUID } from './harness.js';

const GUARD = { timeout: 5000 };
const USAGE = { input_tokens: 1000, output_tokens: 100 };
const SUMMARY_USAGE = { input_tokens: 1000, cache_read_input_tokens: 150, cache_creation_input_tokens: 50, output_tokens: 45 };
const ZERO = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
const http400 = { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'credit balance is too low' } }) };

async function dirs(t) {
  return { home: await useTempDir(t), cwd: await useTempDir(t), dir: await useTempDir(t) };
}

function results(s) {
  return parseRecords(s.out.text).filter((record) => record.type === 'result');
}

function after(s, n) {
  const records = parseRecords(s.out.text);
  let seen = 0;
  const at = n === 0 ? 0 : records.findIndex((record) => record.type === 'result' && ++seen === n);
  return records.slice(at + 1);
}

function lastUserTexts(call) {
  return call.body.messages.at(-1).content.filter((block) => block.type === 'text').map((block) => block.text);
}

async function hookLog(dir) {
  const log = join(dir, 'hooks.jsonl');
  const hook = await script(dir, 'log.sh', `cat >> ${JSON.stringify(log)}`);
  const settings = writeSettings(dir, { hooks: { SessionStart: [hookGroup('', hook)], PreCompact: [hookGroup('', hook)] } });
  const read = () => readJsonl(log).map((input) => [input.hook_event_name, input.source ?? input.trigger, input.session_id]);
  return { settings, read };
}

test('/compact writes status compacting, compact_boundary with the REPL token counts, status null, then one result', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const hooks = await hookLog(dir);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, '--settings', hooks.settings], {
    home,
    cwd,
    replies: [textReply('r1', USAGE), textReply('SUMMARY-TEXT', SUMMARY_USAGE)],
  });
  s.send(userLine('one'));
  await s.until('result');
  s.send(userLine('  /compact keep paths  '));
  await s.until('result', 2);
  s.close();
  assert.equal(await s.done, 0);
  const tail = after(s, 1);
  assert.deepEqual(kinds(tail), ['system/status', 'system/compact_boundary', 'system/status', 'result']);
  const [compacting, boundary, settled, result] = tail;
  for (const record of tail) {
    assert.equal(record.session_id, UUID);
    assert.equal(record.uuid.length, 36);
  }
  assert.deepEqual(Object.keys(compacting), ['type', 'subtype', 'status', 'session_id', 'uuid']);
  assert.equal(compacting.status, 'compacting');
  assert.deepEqual(Object.keys(boundary), ['type', 'subtype', 'session_id', 'uuid', 'compact_metadata']);
  assert.deepEqual(boundary.compact_metadata, { trigger: 'manual', pre_tokens: 1200, post_tokens: 45 });
  assert.match(s.err.text, /^clodent: conversation compacted \(1200 → 45 tokens\)$/m);
  assert.deepEqual([settled.status, settled.compact_result], [null, 'success']);
  const [first] = results(s);
  assert.deepEqual(
    [result.subtype, result.is_error, result.result, result.num_turns, result.stop_reason],
    ['success', false, '', 1, null],
  );
  assert.deepEqual(result.usage, { input_tokens: 1000, cache_creation_input_tokens: 50, cache_read_input_tokens: 150, output_tokens: 45 });
  assert.ok(result.total_cost_usd > first.total_cost_usd);
  const summary = s.fetch.calls[1].body;
  assert.deepEqual(summary.tool_choice, { type: 'none' });
  assert.deepEqual(lastUserTexts(s.fetch.calls[1]), [`${COMPACT_PROMPT}\n\nAdditional instructions: keep paths`]);
  const records = readJsonl(transcriptPath(home, cwd, UUID));
  assert.deepEqual(records.slice(-2).map((r) => r.subtype ?? (r.isCompactSummary ? 'summary' : r.type)), ['compact_boundary', 'summary']);
  assert.deepEqual(hooks.read(), [
    ['SessionStart', 'startup', UUID],
    ['PreCompact', 'manual', UUID],
    ['SessionStart', 'compact', UUID],
  ]);
});

test('a failed /compact writes no compact_boundary, status null with compact_result failed, and an is_error result with the usage of any response', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const cut = { body: sse({ blocks: [{ type: 'text', text: 'SUMMARY cut' }], stopReason: 'max_tokens', usage: { input_tokens: 500, output_tokens: 20 } }) };
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd, replies: [textReply('r1'), cut, http400] });
  s.send(userLine('/compact'));
  await s.until('result');
  assert.equal(s.fetch.calls.length, 0);
  s.send(userLine('one'));
  await s.until('result', 2);
  s.send(userLine('/compact'));
  await s.until('result', 3);
  s.send(userLine('/compact'));
  await s.until('result', 4);
  s.close();
  assert.equal(await s.done, 0);
  const records = parseRecords(s.out.text);
  assert.equal(records.some((record) => record.subtype === 'compact_boundary'), false);
  const [empty, one, stopped, failed] = results(s);
  for (const [result, text, from, usage] of [
    [empty, 'clodent: nothing to compact', 0, ZERO],
    [stopped, 'clodent: compact failed: stop_reason max_tokens', 2, { ...ZERO, input_tokens: 500, output_tokens: 20 }],
    [failed, 'clodent: compact failed: credit balance is too low', 3, ZERO],
  ]) {
    const tail = after(s, from);
    assert.deepEqual(kinds(tail).slice(0, 3), ['system/status', 'system/status', 'result']);
    assert.deepEqual([tail[0].status, tail[1].status, tail[1].compact_result], ['compacting', null, 'failed']);
    assert.deepEqual([result.subtype, result.is_error, result.result, result.session_id, result.usage], ['success', true, text, UUID, usage]);
  }
  assert.ok(stopped.total_cost_usd > one.total_cost_usd);
  assert.equal(failed.total_cost_usd, stopped.total_cost_usd);
  assert.equal(s.fetch.calls.length, 3);
});

test('/clear writes conversation_reset, a fresh init with the new id, and a result that keeps the cumulative total', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const hooks = await hookLog(dir);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, '--settings', hooks.settings], {
    home,
    cwd,
    replies: [textReply('a', USAGE), textReply('b', USAGE)],
  });
  s.send(userLine('first'));
  await s.until('result');
  s.send(userLine('/clear'));
  await s.until('result', 2);
  s.send(userLine('second'));
  await s.until('result', 3);
  s.close();
  assert.equal(await s.done, 0);
  const [startup] = parseRecords(s.out.text);
  const tail = after(s, 1);
  assert.deepEqual(kinds(tail).slice(0, 3), ['conversation_reset', 'system/init', 'result']);
  const [reset, init, cleared] = tail;
  const fresh = reset.new_conversation_id;
  assert.notEqual(fresh, UUID);
  assert.deepEqual(Object.keys(reset), ['type', 'new_conversation_id', 'trigger', 'session_id', 'uuid']);
  assert.deepEqual([reset.trigger, reset.session_id], ['clear', UUID]);
  assert.equal(init.session_id, fresh);
  assert.deepEqual({ ...init, session_id: UUID, uuid: null }, { ...startup, uuid: null });
  const [first, , last] = results(s);
  assert.deepEqual(
    [cleared.subtype, cleared.is_error, cleared.result, cleared.num_turns, cleared.session_id, cleared.total_cost_usd],
    ['success', false, '', 0, fresh, first.total_cost_usd],
  );
  assert.deepEqual(cleared.usage, ZERO);
  assert.equal(last.session_id, fresh);
  const next = s.fetch.calls[1].body;
  assert.equal(next.metadata.user_id, JSON.stringify({ session_id: fresh }));
  assert.equal(next.messages.length, 1);
  assert.ok(existsSync(transcriptPath(home, cwd, fresh)));
  assert.deepEqual(hooks.read(), [
    ['SessionStart', 'startup', UUID],
    ['SessionStart', 'clear', fresh],
  ]);
});

test("/cost, /help and an unknown /name each get one result with the REPL's text and send no request; a path is a prompt", GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd, replies: [textReply('ok')] });
  s.send(userLine('/cost'));
  s.send(userLine([{ type: 'text', text: '/help' }]));
  s.send(userLine('/nope x'));
  await s.until('result', 3);
  assert.equal(s.fetch.calls.length, 0);
  s.send(userLine('/Users/me/x fix it'));
  await s.until('result', 4);
  s.close();
  assert.equal(await s.done, 0);
  const [cost, help, unknown, prompt] = results(s);
  assert.match(cost.result, /^\[clodent:cost\] session total \$0\.0000 \(in 0, .*requests 0\)$/);
  assert.equal(help.result, HELP.join('\n'));
  assert.deepEqual([unknown.result, unknown.is_error], ['clodent: unknown command /nope (try /help)', true]);
  for (const result of [cost, help, unknown]) {
    assert.deepEqual([result.subtype, result.num_turns, result.usage], ['success', 0, ZERO]);
  }
  assert.deepEqual([cost.is_error, help.is_error], [false, false]);
  assert.deepEqual(lastUserTexts(s.fetch.calls[0]), ['/Users/me/x fix it']);
  assert.equal(prompt.result, 'ok');
});

test('/model <id> answers with the REPL line and the next request uses the stripped model', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd, replies: [textReply('hi')] });
  s.send(userLine('/model claude-haiku-5-5[1m]'));
  s.send(userLine('hello'));
  await s.until('result', 2);
  s.close();
  assert.equal(await s.done, 0);
  const [model] = results(s);
  assert.deepEqual([model.result, model.is_error, model.num_turns], ['clodent: model claude-haiku-5-5', false, 0]);
  assert.deepEqual(s.fetch.calls.map((call) => call.body.model), ['claude-haiku-5-5']);
});

test('/quit exits 0 without stdin EOF and writes no result', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd });
  s.send(userLine('/quit'));
  assert.equal(await s.done, 0);
  assert.deepEqual(kinds(parseRecords(s.out.text)), ['system/init']);
  assert.match(s.err.text, /^\[clodent:cost\] session total /m);
});

test('/exit drops a prompt sent behind it in the same stdin chunk: no request and no result', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd, replies: [textReply('never')] });
  await s.until('system/init');
  s.stdin.type(`${JSON.stringify(userLine('/exit'))}\n${JSON.stringify(userLine('after'))}\n`);
  assert.equal(await s.done, 0);
  assert.equal(s.fetch.calls.length, 0);
  assert.deepEqual(kinds(parseRecords(s.out.text)), ['system/init']);
});

test('an interrupt in the same stdin chunk as an idle /cost is used up by it: a later prompt runs in full', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd, replies: [textReply('again done')] });
  await s.until('system/init');
  const interrupt = { type: 'control_request', request_id: 'clodex-interrupt-1', request: { subtype: 'interrupt' } };
  s.stdin.type(`${JSON.stringify(userLine('/cost'))}\n${JSON.stringify(interrupt)}\n`);
  await s.until('result');
  s.send(userLine('again'));
  await s.until('result', 2);
  s.close();
  assert.equal(await s.done, 0);
  assert.deepEqual(results(s).map((result) => result.result.startsWith('[clodent:cost]') || result.result), [true, 'again done']);
  assert.equal(s.fetch.calls.length, 1);
});

test('a /clear sent during a turn is never folded: it runs after that turn, and a prompt sent after it waits for it', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const s = startStream([...STREAM_ARGV, '--session-id', UUID], { home, cwd });
  s.send(userLine('start'));
  await s.fetch.called(1);
  s.send(userLine('/clear'));
  s.send(userLine('later'));
  s.fetch.push(toolsReply([['Bash', { command: 'echo hi' }]]));
  await s.fetch.called(2);
  assert.deepEqual(lastUserTexts(s.fetch.calls[1]), []);
  s.fetch.push(textReply('done'));
  await s.fetch.called(3);
  s.fetch.push(textReply('later done'));
  await s.until('result', 3);
  s.close();
  assert.equal(await s.done, 0);
  assert.deepEqual(kinds(parseRecords(s.out.text)), [
    'system/init',
    'assistant',
    'user',
    'assistant',
    'result',
    'conversation_reset',
    'system/init',
    'result',
    'assistant',
    'result',
  ]);
  const [done, cleared, later] = results(s);
  assert.deepEqual([done.result, cleared.result, later.result], ['done', '', 'later done']);
  assert.equal(later.session_id, cleared.session_id);
  assert.deepEqual(s.fetch.calls[2].body.messages.map((message) => message.role), ['user']);
  assert.deepEqual(lastUserTexts(s.fetch.calls[2]), ['later']);
});
