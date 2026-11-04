import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgent, INTERRUPT_MARKER } from '../../src/agent/loop.js';
import { createLedger } from '../../src/cost/ledger.js';
import { loadTranscript } from '../../src/session/load.js';
import { createRecorder } from '../../src/session/recorder.js';
import { createTranscript } from '../../src/session/transcript.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';
import { sse } from '../helpers/sse-builder.js';
import { useTempDir } from '../tools/tmp-dir.js';

const fs = { readFileSync };
const textReply = (text, stopReason = 'end_turn') => ({ body: sse({ blocks: [{ type: 'text', text }], stopReason }) });
const toolReply = (stopReason = 'tool_use') => ({
  body: sse({
    blocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'toolu_1', name: 'A', input: { n: 1 } }],
    stopReason,
  }),
});
const failure = { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }) };

function liveSession(path, responses) {
  let n = 0;
  const transcript = createTranscript(
    { path, sessionId: 's', cwd: '/w', version: '1' },
    { appendFileSync, mkdirSync, clock: () => new Date(0), uuid: () => `u${++n}` },
  );
  const record = createRecorder(transcript, { now: () => 0 });
  let abortOnDelta = null;
  const tool = { name: 'A', kind: 'read', description: 'a', input_schema: { type: 'object' }, run: async () => ({ content: 'A ok', isError: false }) };
  const agent = createAgent(
    { model: 'claude-opus-5-5', system: 's', tools: [tool], permission: 'yolo' },
    {
      fetch: createFakeFetch(responses),
      env: { ANTHROPIC_API_KEY: 'k' },
      cwd: '/w',
      sleep: async () => {},
      random: () => 0.5,
      now: () => 0,
      ledger: createLedger({}, {}),
      emit: (e) => {
        record(e);
        if (e.type === 'text_delta') abortOnDelta?.abort();
      },
    },
  );
  return {
    agent,
    transcript,
    turn: (text) => agent.runTurn(text),
    interruptedTurn(text) {
      abortOnDelta = new AbortController();
      const done = agent.runTurn(text, { signal: abortOnDelta.signal });
      return done.finally(() => {
        abortOnDelta = null;
      });
    },
  };
}

test('replaying the transcript rebuilds the live history exactly, merged roles included', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 's.jsonl');
  const live = liveSession(path, [
    toolReply(),
    textReply('done'),
    textReply('part one', 'pause_turn'),
    textReply('part two'),
    { body: sse({ blocks: [{ type: 'text', text: ['a', 'b'] }] }) },
    failure,
    toolReply('max_tokens'),
    { body: sse({ blocks: [] }) },
    textReply('final'),
  ]);
  assert.equal((await live.turn('tool round')).ok, true);
  assert.equal((await live.turn('pause')).ok, true);
  assert.equal((await live.interruptedTurn('cut')).stopReason, 'interrupted');
  assert.equal((await live.turn('after interrupt')).stopReason, 'error');
  assert.equal((await live.turn('after error')).stopReason, 'max_tokens');
  assert.equal((await live.turn('empty')).ok, true);
  assert.equal((await live.turn('last')).ok, true);
  const history = live.agent.messages();
  assert.ok(history.some((m) => m.role === 'user' && m.content.some((b) => b.text === INTERRUPT_MARKER)));
  const loaded = loadTranscript(path, fs);
  assert.deepEqual(loaded.history, history);
  assert.equal(loaded.lastUuid, live.transcript.lastUuid());
  assert.equal(loaded.interruptedLast, false);
  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.truncated, false);
  assert.equal(loaded.sessionId, 's');
  assert.equal(loaded.records.length, readFileSync(path, 'utf8').trimEnd().split('\n').length);
});

test('interruptedLast is true only when the last user record is the interrupt record', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 's.jsonl');
  const live = liveSession(path, [{ body: sse({ blocks: [{ type: 'text', text: ['a', 'b'] }] }) }]);
  await live.interruptedTurn('cut');
  const loaded = loadTranscript(path, fs);
  assert.equal(loaded.interruptedLast, true);
  assert.deepEqual(loaded.history, [{ role: 'user', content: [{ type: 'text', text: 'cut' }] }]);
});

const line = (record) => `${JSON.stringify(record)}\n`;
const user = (uuid, text, extra = {}) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });

test('system, meta and unknown records are skipped; same-role records merge', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 'x.jsonl');
  writeFileSync(path, [
    user('a', 'one'),
    { type: 'system', uuid: 'b', subtype: 'turn_duration' },
    user('c', 'meta', { isMeta: true }),
    user('c2', 'transcript only', { isVisibleInTranscriptOnly: true }),
    { type: 'file-history-snapshot', uuid: 'd' },
    user('e', 'two'),
    { type: 'assistant', uuid: 'f', message: { role: 'assistant', content: [{ type: 'text', text: 'r' }] } },
    { type: 'summary' },
  ].map(line).join(''));
  const loaded = loadTranscript(path, fs);
  assert.deepEqual(loaded.history, [
    { role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'r' }] },
  ]);
  assert.equal(loaded.lastUuid, 'f');
  assert.equal(loaded.records.length, 8);
});

test('a truncated last line is ignored with a warning and validBytes ends at the last newline', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 't.jsonl');
  const good = line(user('a', 'é one'));
  writeFileSync(path, `${good}{"type":"assistant","uuid":"b","mess`);
  const loaded = loadTranscript(path, fs);
  assert.deepEqual(loaded.history, [{ role: 'user', content: [{ type: 'text', text: 'é one' }] }]);
  assert.deepEqual(loaded.warnings, [`${path}: ignoring a truncated last line`]);
  assert.equal(loaded.truncated, true);
  assert.equal(loaded.validBytes, Buffer.byteLength(good));
  assert.equal(loaded.lastUuid, 'a');
});

test('an unparseable line before the last one is an error naming its line number', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 'c.jsonl');
  writeFileSync(path, `${line(user('a', 'one'))}{not json\n${line(user('c', 'three'))}`);
  assert.throws(() => loadTranscript(path, fs), { message: `${path}: line 2 is not valid JSON` });
  writeFileSync(path, `${line(user('a', 'one'))}{"type":"user","uuid":"b"}\n`);
  assert.throws(() => loadTranscript(path, fs), { message: `${path}: line 2 has no message content` });
  writeFileSync(path, `[1]\n`);
  assert.throws(() => loadTranscript(path, fs), { message: `${path}: line 1 is not a record` });
});
