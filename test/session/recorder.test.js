import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUMMARY_PREFIX } from '../../src/agent/compact.js';
import { createAgent } from '../../src/agent/loop.js';
import { createLedger } from '../../src/cost/ledger.js';
import { createRecorder } from '../../src/session/recorder.js';
import { createTranscript, INTERRUPT_TEXT } from '../../src/session/transcript.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';
import { sse } from '../helpers/sse-builder.js';
import { useTempDir } from '../tools/tmp-dir.js';

function capture() {
  const records = [];
  return { records, refreshes: [], append: (record) => records.push(record), refreshBranch() { this.refreshes.push(records.length); } };
}

const MESSAGE = { id: 'msg_1', model: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1 } };

test('the recorder maps appends, the interrupt and turn_end to transcript records', () => {
  const transcript = capture();
  let clock = 100;
  const record = createRecorder(transcript, { now: () => clock });
  record({ type: 'session_start' });
  record({ type: 'message_append', role: 'user', content: [{ type: 'text', text: 'go' }], kind: 'prompt', meta: {} });
  record({ type: 'message_append', role: 'assistant', content: MESSAGE.content, kind: 'assistant', meta: { message: MESSAGE, requestId: 'req_1', durationMs: 6.6, usd: 0.25 } });
  record({ type: 'assistant_message', message: MESSAGE });
  record({
    type: 'message_append',
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'nope', is_error: true },
      { type: 'tool_result', tool_use_id: 'other', content: 'ok', is_error: false },
    ],
    kind: 'tool_results',
    meta: {},
  });
  record({ type: 'message_append', role: 'assistant', content: [{ type: 'text', text: 'Kept.' }], kind: 'partial', meta: {} });
  record({ type: 'interrupted' });
  clock = 1600.4;
  record({ type: 'turn_end', stopReason: 'interrupted', turn: {} });
  assert.deepEqual(transcript.records, [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    { type: 'assistant', message: MESSAGE, requestId: 'req_1', costUsd: 0.25, durationMs: 7 },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'nope', is_error: true },
          { type: 'tool_result', tool_use_id: 'other', content: 'ok', is_error: false },
        ],
      },
      toolUseResult: { name: 'Read', isError: true, input: {} },
    },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Kept.' }], stop_reason: null } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, isVisibleInTranscriptOnly: true },
    { type: 'system', subtype: 'turn_duration', durationMs: 1500, messageCount: 5 },
  ]);
});

test('messageCount and durationMs restart with each turn', () => {
  const transcript = capture();
  let clock = 0;
  const record = createRecorder(transcript, { now: () => clock });
  for (const prompt of ['a', 'b']) {
    record({ type: 'message_append', role: 'user', content: [{ type: 'text', text: prompt }], kind: 'prompt', meta: {} });
    clock += 10;
    record({ type: 'turn_end' });
  }
  assert.deepEqual(transcript.records.filter((r) => r.type === 'system').map((r) => [r.durationMs, r.messageCount]), [[10, 1], [10, 1]]);
});

test('compacted writes the compact_boundary and isCompactSummary records, which no turn counts', () => {
  const transcript = { ...capture(), lastUuid: () => 'u-last' };
  const record = createRecorder(transcript, { now: () => 0 });
  record({ type: 'compacted', trigger: 'manual', summary: 'S', preTokens: 300, postTokens: 40, turn: {} });
  record({ type: 'message_append', role: 'user', content: [{ type: 'text', text: 'next' }], kind: 'prompt', meta: {} });
  record({ type: 'turn_end' });
  assert.deepEqual(transcript.records, [
    {
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      level: 'info',
      parentUuid: null,
      logicalParentUuid: 'u-last',
      compactMetadata: { trigger: 'manual', preTokens: 300, postTokens: 40 },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: `${SUMMARY_PREFIX}S` }] }, isVisibleInTranscriptOnly: true, isCompactSummary: true },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'next' }] } },
    { type: 'system', subtype: 'turn_duration', durationMs: 0, messageCount: 1 },
  ]);
});

test('an interrupt mid-stream writes the partial assistant and the interrupt record, then turn_duration', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 's.jsonl');
  let n = 0;
  const transcript = createTranscript(
    { path, sessionId: 's', cwd: '/w', version: '1' },
    { appendFileSync, mkdirSync, clock: () => new Date(0), uuid: () => `u${++n}` },
  );
  const record = createRecorder(transcript, { now: () => 0 });
  const controller = new AbortController();
  const body = sse({ blocks: [{ type: 'text', text: 'Kept.' }, { type: 'text', text: ['Cut ', 'off'] }] });
  const agent = createAgent(
    { model: 'claude-opus-5-5', system: 's', tools: [], permission: 'yolo' },
    {
      fetch: createFakeFetch([{ body }]),
      env: { ANTHROPIC_API_KEY: 'k' },
      cwd: '/w',
      sleep: async () => {},
      random: () => 0.5,
      now: () => 0,
      ledger: createLedger({}, {}),
      emit: (e) => {
        record(e);
        if (e.type === 'text_delta' && e.index === 1) controller.abort();
      },
    },
  );
  await agent.runTurn('go', { signal: controller.signal });
  const records = readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records.map((r) => [r.type, r.message?.stop_reason, r.isVisibleInTranscriptOnly, r.message?.content?.[0]?.text]), [
    ['user', undefined, undefined, 'go'],
    ['assistant', null, undefined, 'Kept.'],
    ['user', undefined, true, INTERRUPT_TEXT],
    ['system', undefined, undefined, undefined],
  ]);
  assert.deepEqual(records.map((r) => r.parentUuid), [null, 'u1', 'u2', 'u3']);
  assert.equal(records[3].messageCount, 3);
});

test('the recorder re-reads the git branch before the first record of each turn, and only then', () => {
  const transcript = capture();
  const record = createRecorder(transcript, { now: () => 0 });
  const prompt = { type: 'message_append', role: 'user', content: [{ type: 'text', text: 'go' }], kind: 'prompt', meta: {} };
  const reply = { type: 'message_append', role: 'assistant', content: [{ type: 'text', text: 'ok' }], kind: 'partial', meta: {} };
  const dangling = { type: 'message_append', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x', is_error: true }], kind: 'tool_results', meta: {} };
  record(prompt);
  record(reply);
  record({ type: 'turn_end', stopReason: 'end_turn' });
  record(dangling);
  record(prompt);
  record(reply);
  assert.deepEqual(transcript.refreshes, [0, 3, 4]);
});
