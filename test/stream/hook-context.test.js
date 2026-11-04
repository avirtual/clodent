import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('a warning without hookContext writes nothing on stdout', () => {
  const lines = [];
  const output = createStreamOutput({ version: '0', sessionId: () => 'sid' }, { out: { write: (text) => lines.push(text) }, now: () => 0, uuid: () => 'u', totalUsd: () => 0 });
  output.init();
  output.event({ type: 'warning', message: 'plain' });
  output.event({ type: 'warning', message: 'cut', hookContext: { event: 'PostToolUse', scope: 'event', bytes: 300000, limit: 262144 } });
  assert.deepEqual(lines.slice(1).map((line) => JSON.parse(line)), [
    { type: 'system', subtype: 'hook_context_truncated', hook_event: 'PostToolUse', scope: 'event', bytes: 300000, limit: 262144, session_id: 'sid', uuid: 'u' },
  ]);
});
