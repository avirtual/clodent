import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createStreamOutput } from '../../src/stream/output.js';
import { contextMarker } from '../../src/hooks/context-cap.js';
import { hookGroup, textReply, writeSettings } from '../helpers/run-main.js';
import { script } from '../hooks/scripts.js';
import { useTempDir } from '../tools/tmp-dir.js';
import { kinds, parseRecords, startStream, STREAM_ARGV, userLine, UUID } from './harness.js';

const GUARD = { timeout: 10000 };
const fill = (bytes, char) => `head -c ${bytes} /dev/zero | tr '\\0' ${char}`;

test('a hook context cut writes a system hook_context_truncated record on stdout, after init, and a warning on stderr', GUARD, async (t) => {
  const [home, cwd, dir] = [await useTempDir(t), await useTempDir(t), await useTempDir(t)];
  const start = await script(dir, 'start.sh', fill(70000, 's'));
  const submit = await script(dir, 'submit.sh', fill(102400, 'u'));
  const settings = writeSettings(dir, { hooks: { SessionStart: [hookGroup('', start)], UserPromptSubmit: [hookGroup('', submit)] } });
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, '--settings', settings], { home, cwd, replies: [textReply('ok')] });
  s.send(userLine('go'));
  await s.until('result');
  s.close();
  assert.equal(await s.done, 0);
  const records = parseRecords(s.out.text);
  assert.deepEqual(kinds(records), ['system/init', 'system/hook_context_truncated', 'system/hook_context_truncated', 'assistant', 'result']);
  const cuts = records.filter((record) => record.subtype === 'hook_context_truncated');
  for (const cut of cuts) assert.match(cut.uuid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    cuts.map(({ uuid, ...rest }) => rest),
    [
      { type: 'system', subtype: 'hook_context_truncated', hook_event: 'SessionStart', scope: 'hook', bytes: 70000, limit: 65536, session_id: UUID },
      { type: 'system', subtype: 'hook_context_truncated', hook_event: 'UserPromptSubmit', scope: 'hook', bytes: 102400, limit: 65536, session_id: UUID },
    ],
  );
  assert.match(s.err.text, new RegExp(`^clodent: hook UserPromptSubmit "${submit.slice(0, 60)}": context of 102400 bytes truncated to 65536$`, 'm'));
  const sent = s.fetch.calls[0].body.messages[0].content.map((block) => block.text).join('\n');
  assert.ok(sent.includes(contextMarker(70000, 65536)) && sent.includes(contextMarker(102400, 65536)));
});

test('after /clear, a SessionStart clear context cut is written after the new init, with its session_id', GUARD, async (t) => {
  const [home, cwd, dir] = [await useTempDir(t), await useTempDir(t), await useTempDir(t)];
  const start = await script(dir, 'start.sh', fill(70000, 's'));
  const settings = writeSettings(dir, { hooks: { SessionStart: [hookGroup('', start)] } });
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, '--settings', settings], { home, cwd, replies: [textReply('ok')] });
  s.send(userLine('go'));
  await s.until('result');
  s.send(userLine('/clear'));
  await s.until('result', 2);
  s.close();
  assert.equal(await s.done, 0);
  const records = parseRecords(s.out.text);
  assert.deepEqual(kinds(records), ['system/init', 'system/hook_context_truncated', 'assistant', 'result', 'conversation_reset', 'system/init', 'system/hook_context_truncated', 'result']);
  const [, init, cut] = records.slice(4);
  assert.notEqual(init.session_id, UUID);
  assert.deepEqual([cut.hook_event, cut.session_id], ['SessionStart', init.session_id]);
});

test('a 100 KiB Stop context is not cut, so result stays the last stdout record', GUARD, async (t) => {
  const [home, cwd, dir] = [await useTempDir(t), await useTempDir(t), await useTempDir(t)];
  const ran = `${dir}/stop-ran`;
  const stop = await script(dir, 'stop.sh', `touch ${JSON.stringify(ran)}; printf '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"'; ${fill(102400, 's')}; printf '"}}'`);
  const settings = writeSettings(dir, { hooks: { Stop: [hookGroup('', stop)] } });
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, '--settings', settings], { home, cwd, replies: [textReply('ok')] });
  s.send(userLine('go'));
  await s.until('result');
  s.close();
  assert.equal(await s.done, 0);
  assert.ok(existsSync(ran));
  assert.deepEqual(kinds(parseRecords(s.out.text)), ['system/init', 'assistant', 'result']);
  assert.doesNotMatch(s.err.text, /truncated/);
});

test('a warning without hookContext writes nothing on stdout', () => {
  const lines = [];
  const output = createStreamOutput({ version: '0', sessionId: () => 'sid', contextWindow: () => 200000, instructionFiles: () => [] }, { out: { write: (text) => lines.push(text) }, now: () => 0, uuid: () => 'u', totalUsd: () => 0, unpriced: () => [] });
  output.init();
  output.event({ type: 'warning', message: 'plain' });
  output.event({ type: 'warning', message: 'cut', hookContext: { event: 'PostToolUse', scope: 'event', bytes: 300000, limit: 262144 } });
  assert.deepEqual(lines.slice(1).map((line) => JSON.parse(line)), [
    { type: 'system', subtype: 'hook_context_truncated', hook_event: 'PostToolUse', scope: 'event', bytes: 300000, limit: 262144, session_id: 'sid', uuid: 'u' },
  ]);
});
