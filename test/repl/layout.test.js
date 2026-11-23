import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptPath } from '../../src/session/paths.js';
import { readJsonl, textReply } from '../helpers/run-main.js';
import { useTempDir } from '../tools/tmp-dir.js';
import { PROMPT_MARK, startRepl } from './harness.js';

const GUARD = { timeout: 5000 };

async function dirs(t) {
  return { home: await useTempDir(t), cwd: await useTempDir(t) };
}

test('on a TTY a mid-stream retry erases the partial text before its warning, and the transcript gets one informational record and no partial', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl([], { home, cwd, replies: [{ body: 'error-mid-stream.sse' }, textReply('Hello there')], columns: 80 });
  await repl.prompts(1);
  repl.stdin.type('go\r');
  await repl.prompts(2);
  assert.ok(repl.out.text.includes('go\nPartial\r\x1b[J\x1b[33mclodent: Overloaded; retrying in 2 s\x1b[0m\nHello there\n'), JSON.stringify(repl.out.text));
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
  const [id] = repl.sessionIds();
  const records = readJsonl(transcriptPath(home, cwd, id));
  const notes = records.filter((record) => record.subtype === 'informational');
  assert.equal(notes.length, 1);
  const { type, subtype, content, level, uuid, timestamp, sessionId } = notes[0];
  assert.deepEqual({ type, subtype, content, level, sessionId }, { type: 'system', subtype: 'informational', content: 'Overloaded; retrying in 2 s', level: 'warning', sessionId: id });
  assert.equal(typeof uuid, 'string');
  assert.equal(typeof timestamp, 'string');
  assert.deepEqual(
    records.filter((record) => record.type === 'assistant').map((record) => record.message.content),
    [[{ type: 'text', text: 'Hello there' }]],
  );
});

test('one blank line comes before the prompt after a turn and before a queued line echo; a slash command adds none', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl([], { home, cwd });
  await repl.prompts(1);
  repl.stdin.type('/cost\r');
  await repl.prompts(2);
  repl.stdin.type('first\r');
  await repl.fetch.called(1);
  repl.stdin.type('second\r');
  repl.fetch.push(textReply('one'));
  repl.fetch.push(textReply('two'));
  await repl.prompts(4);
  const out = repl.out.text;
  assert.match(out, /\[clodent:cost\] session total [^\n]*\n\x1b\[\?2004h> first\n/);
  assert.match(out, /one\n\[clodent:cost\] [^\n]*\n\n\x1b\[\?2004h> second\n/);
  assert.match(out, /two\n\[clodent:cost\] [^\n]*\n\n\x1b\[\?2004h> $/);
  assert.equal(out.split(PROMPT_MARK).length - 1, 4);
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
});

test('on a TTY /help is word-wrapped at the width; the session line is not', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl([], { home, cwd, columns: 40 });
  await repl.prompts(1);
  repl.stdin.type('/help\r');
  await repl.prompts(2);
  assert.ok(repl.out.text.includes('\n/compact [<text>]  summarise the\nconversation into one message; <text>\nsteers the summary\n'), JSON.stringify(repl.out.text));
  assert.match(repl.out.text, /^\[clodent:session\] [0-9a-f-]{36}\n/);
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
});
