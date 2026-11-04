import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPACT_PROMPT, SUMMARY_PREFIX } from '../../src/agent/compact.js';
import { transcriptPath } from '../../src/session/paths.js';
import { readJsonl, textReply, writeSettings } from '../helpers/run-main.js';
import { plant, useTempDir } from '../tools/tmp-dir.js';
import { startStream, STREAM_ARGV, userLine, UUID } from './harness.js';

const GUARD = { timeout: 5000 };
const FIXTURE = new URL('../permissions/fixtures/clodex-guarded-settings.json', import.meta.url);
const fileText = (path, output) => `Contents of ${path} at compact time (Read tool output):\n\n${output}`;

async function dirs(t) {
  return { home: await useTempDir(t), cwd: await useTempDir(t), dir: await useTempDir(t), user: await useTempDir(t) };
}

async function compactRun(argv, { home, cwd, env, summary }) {
  const s = startStream([...STREAM_ARGV, '--session-id', UUID, ...argv], { home, cwd, env, replies: [textReply('r1'), textReply(summary), textReply('r2')] });
  s.send(userLine('one'));
  await s.until('result');
  s.send(userLine('/compact'));
  await s.until('result', 2);
  s.send(userLine('two'));
  await s.until('result', 3);
  s.close();
  assert.equal(await s.done, 0, s.err.text);
  return s;
}

test('a stream seat under the Clodex guarded settings never reloads a sandbox-denied file: its content reaches no request, transcript line, stdout or stderr', GUARD, async (t) => {
  const { home, cwd, dir, user } = await dirs(t);
  const guarded = JSON.parse(readFileSync(FIXTURE, 'utf8').replaceAll('/Users/<user>', user));
  assert.equal(guarded.sandbox.enabled, true);
  guarded.sandbox.filesystem.denyRead.push(join(user, 'vault'));
  guarded.sandbox.credentials.files.push({ path: join(user, 'creds/token'), mode: 'deny' });
  await plant(user, { 'vault/k.txt': 'MARKER-SANDBOX-READ', 'creds/token': 'MARKER-SANDBOX-CRED', 'open/o.txt': 'OPEN-CONTENT' });
  const [vault, cred, open] = [join(user, 'vault/k.txt'), join(user, 'creds/token'), join(user, 'open/o.txt')];
  const summary = `Work.\nFiles to reload:\n${vault}\n${cred}\n${open}`;
  const s = await compactRun(['--dangerously-skip-permissions', '--settings', writeSettings(dir, guarded)], { home, cwd, env: { HOME: user }, summary });
  const lines = s.err.text.split('\n');
  const at = lines.findIndex((line) => line.startsWith('clodent: conversation compacted'));
  assert.deepEqual(lines.slice(at + 1, at + 4), [
    `clodent: reloaded 1 file(s) after compact: ${open}`,
    `clodent: not reloaded ${vault}: denied`,
    `clodent: not reloaded ${cred}: denied`,
  ]);
  const transcript = readFileSync(transcriptPath(home, cwd, UUID), 'utf8');
  const bodies = s.fetch.calls.map((call) => JSON.stringify(call.body)).join('\n');
  assert.equal(s.fetch.calls[2].body.messages[0].content[1].text, fileText(open, '     1\tOPEN-CONTENT'));
  assert.equal(transcript.includes('OPEN-CONTENT'), true);
  for (const [where, value] of Object.entries({ bodies, transcript, stdout: s.out.text, stderr: s.err.text })) {
    for (const marker of ['MARKER-SANDBOX-READ', 'MARKER-SANDBOX-CRED']) assert.equal(value.includes(marker), false, `${marker} in ${where}`);
  }
});

test('the isCompactSummary record holds the reloaded file blocks, and --resume replays them as recorded', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  await plant(cwd, { 'src/a.js': 'ALPHA-CONTENT' });
  const a = join(cwd, 'src/a.js');
  const gone = join(cwd, 'gone.js');
  const summary = 'Work.\nFiles to reload:\n- src/a.js\n- gone.js';
  const s = await compactRun([], { home, cwd, summary });
  assert.equal(s.err.text.includes(`\nclodent: reloaded 1 file(s) after compact: ${a}\nclodent: not reloaded ${gone}: File does not exist: ${gone}\n`), true, s.err.text);
  const message = { role: 'user', content: [{ type: 'text', text: `${SUMMARY_PREFIX}${summary}` }, { type: 'text', text: fileText(a, '     1\tALPHA-CONTENT') }] };
  const records = readJsonl(transcriptPath(home, cwd, UUID));
  const boundary = records.find((record) => record.subtype === 'compact_boundary');
  assert.deepEqual(boundary.compactMetadata.reloadedFiles, [a]);
  assert.deepEqual(records.find((record) => record.isCompactSummary).message, message);
  assert.deepEqual(s.fetch.calls[2].body.messages[0].content.slice(0, 2).map((block) => block.text), message.content.map((block) => block.text));
  writeFileSync(a, 'CHANGED-ON-DISK');
  const resumed = startStream([...STREAM_ARGV, '--resume', UUID], { home, cwd, replies: [textReply('back')] });
  resumed.send(userLine('again'));
  await resumed.until('result');
  resumed.close();
  assert.equal(await resumed.done, 0, resumed.err.text);
  const replayed = resumed.fetch.calls[0].body.messages;
  assert.deepEqual(replayed[0].content.slice(0, 2).map((block) => block.text), message.content.map((block) => block.text));
  assert.equal(JSON.stringify(replayed).includes('CHANGED-ON-DISK'), false);
});

test('settings compactReloadFiles 0 sends COMPACT_PROMPT alone and reloads nothing, even when the summary lists files', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  await plant(cwd, { 'a.js': 'ALPHA' });
  const summary = 'Work.\nFiles to reload:\na.js';
  const s = await compactRun(['--settings', writeSettings(dir, { compactReloadFiles: 0 })], { home, cwd, summary });
  assert.deepEqual(s.fetch.calls[1].body.messages.at(-1).content.map((block) => block.text), [COMPACT_PROMPT]);
  assert.deepEqual(s.fetch.calls[2].body.messages[0].content.map((block) => block.text).slice(0, 2), [`${SUMMARY_PREFIX}${summary}`, 'two']);
  assert.doesNotMatch(s.err.text, /reloaded/);
  const boundary = readJsonl(transcriptPath(home, cwd, UUID)).find((record) => record.subtype === 'compact_boundary');
  assert.deepEqual(boundary.compactMetadata.reloadedFiles, []);
});
