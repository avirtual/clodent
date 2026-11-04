import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { INTERRUPT_MARKER, INTERRUPTED_RESULT } from '../../src/agent/loop.js';
import { main } from '../../src/cli.js';
import { transcriptPath } from '../../src/session/paths.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';
import { sse } from '../helpers/sse-builder.js';
import { assertValidHistory } from '../helpers/valid-history.js';
import { useTempDir } from '../tools/tmp-dir.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION_LINE = /^\[clodent:session\] ([0-9a-f-]{36})$/;
const COMMON = ['type', 'uuid', 'parentUuid', 'sessionId', 'timestamp', 'cwd', 'isSidechain', 'version', 'entrypoint'];

const textReply = (text) => ({ body: sse({ blocks: [{ type: 'text', text }] }) });
const toolReply = () => ({
  body: sse({ blocks: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'notes.md' } }], stopReason: 'tool_use' }),
});

async function setup(t) {
  const home = await useTempDir(t);
  const cwd = await useTempDir(t);
  writeFileSync(join(cwd, 'notes.md'), 'alpha\n');
  return { home, cwd };
}

async function run(argv, { home, cwd, responses = [], onFetch }) {
  const out = [];
  const err = [];
  const signals = {};
  const inner = createFakeFetch(responses);
  const fetch = async (url, init) => {
    onFetch?.({ signals, calls: inner.calls.length });
    return inner(url, init);
  };
  const code = await main(argv, {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: { ANTHROPIC_API_KEY: 'sk-test', CLODENT_HOME: home },
    cwd,
    platform: 'darwin',
    fetch,
    sleep: async () => {},
    random: () => 0.5,
    now: () => 0,
    clock: () => new Date(Date.UTC(2026, 10, 4)),
    onSignal: (name, handler) => {
      signals[name] = handler;
      return () => delete signals[name];
    },
  });
  const stderr = err.join('');
  const id = stderr.split('\n')[0].match(SESSION_LINE)?.[1];
  return { code, stdout: out.join(''), stderr, id, calls: inner.calls };
}

function records(path) {
  return readFileSync(path, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
}

function clodexIsInterruptEntry(obj) {
  if (!obj || obj.isSidechain === true || obj.isMeta === true) return false;
  if ((obj.type || '') !== 'user') return false;
  const content = (obj.message || {}).content;
  if (!Array.isArray(content)) return false;
  const text = content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text === '[Request interrupted by user]' || text === '[Request interrupted by user for tool use]';
}

function strip(messages) {
  return JSON.parse(JSON.stringify(messages, (key, value) => (key === 'cache_control' ? undefined : value)));
}

test('-p with a tool round writes prompt, assistant, tool results, assistant and turn_duration, chained', async (t) => {
  const { home, cwd } = await setup(t);
  const res = await run(['-p', 'read notes'], { home, cwd, responses: [toolReply(), textReply('done')] });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.id, res.stderr);
  const path = transcriptPath(home, cwd, res.id);
  const recs = records(path);
  assert.deepEqual(recs.map((r) => [r.type, r.message?.role ?? r.subtype, r.message?.stop_reason]), [
    ['user', 'user', undefined],
    ['assistant', 'assistant', 'tool_use'],
    ['user', 'user', undefined],
    ['assistant', 'assistant', 'end_turn'],
    ['system', 'turn_duration', undefined],
  ]);
  recs.forEach((r, i) => {
    for (const key of COMMON) assert.ok(key in r, `record ${i} lacks ${key}`);
    assert.equal(r.parentUuid, i === 0 ? null : recs[i - 1].uuid, `record ${i} parentUuid`);
    assert.equal(r.sessionId, res.id);
    assert.equal(r.cwd, cwd);
    assert.equal(r.isSidechain, false);
    assert.equal(r.version, '0.2.0');
    assert.equal(r.entrypoint, 'clodent');
    assert.equal(r.timestamp, '2026-11-04T00:00:00.000Z');
  });
  assert.equal(new Set(recs.map((r) => r.uuid)).size, recs.length);
  assert.deepEqual(recs[0].message.content, [{ type: 'text', text: 'read notes' }]);
  assert.deepEqual(Object.keys(recs[1].message).sort(), ['content', 'id', 'model', 'role', 'stop_reason', 'stop_sequence', 'usage']);
  assert.equal(recs[1].requestId, null);
  assert.equal(typeof recs[1].costUsd, 'number');
  assert.equal(recs[1].durationMs, 0);
  assert.deepEqual(recs[2].toolUseResult, { name: 'Read', isError: false, input: { file_path: 'notes.md' } });
  assert.equal(recs[2].message.content[0].type, 'tool_result');
  assert.deepEqual(recs[4], { ...recs[4], durationMs: 0, messageCount: 4 });
});

test('each record is on disk before the next request is sent', async (t) => {
  const { home, cwd } = await setup(t);
  const path = transcriptPath(home, cwd, ID);
  const seen = [];
  const onFetch = () => seen.push(existsSync(path) ? records(path).map((r) => r.type) : []);
  const res = await run(['-p', 'go', '--session-id', ID], { home, cwd, responses: [toolReply(), textReply('done')], onFetch });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(seen, [['user'], ['user', 'assistant', 'user']]);
});

test('[clodent:session] is the first stderr line in print mode and never on stdout', async (t) => {
  const { home, cwd } = await setup(t);
  const minted = await run(['-p', 'hi'], { home, cwd, responses: [textReply('hello')] });
  assert.match(minted.stderr.split('\n')[0], SESSION_LINE);
  assert.equal(minted.stdout, 'hello\n');
  const given = await run(['-p', 'hi', '--session-id', ID], { home, cwd, responses: [textReply('hello')] });
  assert.equal(given.stderr.split('\n')[0], `[clodent:session] ${ID}`);
  assert.notEqual(minted.id, ID);
});

test('--resume sends the history from before exit, appends to the same file and chains from its last record', async (t) => {
  const { home, cwd } = await setup(t);
  const first = await run(['-p', 'read notes', '--session-id', ID], { home, cwd, responses: [toolReply(), textReply('done')] });
  assert.equal(first.code, 0, first.stderr);
  const path = transcriptPath(home, cwd, ID);
  const before = records(path);
  const second = await run(['-p', 'next', '--resume', ID], { home, cwd, responses: [textReply('again')] });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.id, ID);
  assert.deepEqual(strip(second.calls[0].body.messages), [
    ...strip(first.calls[1].body.messages),
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ]);
  const after = records(path);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(after[before.length].parentUuid, before.at(-1).uuid);
  assert.ok(after.slice(before.length).every((r) => r.sessionId === ID));
});

test('a resume after an interrupt carries INTERRUPT_MARKER in the next request', async (t) => {
  const { home, cwd } = await setup(t);
  const onFetch = ({ signals }) => signals.SIGINT?.();
  const first = await run(['-p', 'first', '--session-id', ID], { home, cwd, responses: [textReply('never')], onFetch });
  assert.equal(first.code, 130, first.stderr);
  const interrupts = records(transcriptPath(home, cwd, ID)).filter(clodexIsInterruptEntry);
  assert.deepEqual(interrupts.map((r) => r.message.content), [[{ type: 'text', text: '[Request interrupted by user]' }]]);
  const second = await run(['-p', 'second', '--resume', ID], { home, cwd, responses: [textReply('ok')] });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(strip(second.calls[0].body.messages), [
    { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: INTERRUPT_MARKER }, { type: 'text', text: 'second' }] },
  ]);
});

test('a resume of a session killed during a tool run closes the dangling tool_use first', async (t) => {
  const { home, cwd } = await setup(t);
  const path = transcriptPath(home, cwd, ID);
  mkdirSync(dirname(path), { recursive: true });
  const message = {
    id: 'msg_1',
    model: 'claude-opus-5-5',
    role: 'assistant',
    content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'notes.md' } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  writeFileSync(path, [
    { type: 'user', uuid: 'r1', parentUuid: null, sessionId: ID, message: { role: 'user', content: [{ type: 'text', text: 'read notes' }] } },
    { type: 'assistant', uuid: 'r2', parentUuid: 'r1', sessionId: ID, message },
  ].map((r) => `${JSON.stringify(r)}\n`).join(''));
  const res = await run(['-p', 'next', '--resume', ID], { home, cwd, responses: [textReply('ok')] });
  assert.equal(res.code, 0, res.stderr);
  const sent = strip(res.calls[0].body.messages);
  assertValidHistory(sent);
  assert.deepEqual(sent[2].content, [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: INTERRUPTED_RESULT, is_error: true },
    { type: 'text', text: INTERRUPT_MARKER },
    { type: 'text', text: 'next' },
  ]);
  const recs = records(path);
  assert.equal(recs[2].parentUuid, 'r2');
  assert.deepEqual(recs[2].message.content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'interrupted by user', is_error: true }]);
  assert.deepEqual(recs[2].toolUseResult, { name: 'Read', isError: true, input: { file_path: 'notes.md' } });
  const again = await run(['-p', 'more', '--resume', ID], { home, cwd, responses: [textReply('fine')] });
  assert.equal(again.code, 0, again.stderr);
  assertValidHistory(strip(again.calls[0].body.messages));
  assert.equal(again.calls[0].body.messages.length, 5);
});

test('--resume finds a session recorded under another project dir and appends there', async (t) => {
  const { home, cwd } = await setup(t);
  const elsewhere = await useTempDir(t);
  await run(['-p', 'hi', '--session-id', ID], { home, cwd, responses: [textReply('one')] });
  const res = await run(['-p', 'again', '--resume', ID], { home, cwd: elsewhere, responses: [textReply('two')] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(existsSync(transcriptPath(home, elsewhere, ID)), false);
  const recs = records(transcriptPath(home, cwd, ID));
  assert.equal(recs.at(-1).cwd, elsewhere);
  assert.equal(recs.filter((r) => r.type === 'system').length, 2);
});

test('--fork-session copies every record under the new id into a new file and leaves the source untouched', async (t) => {
  const { home, cwd } = await setup(t);
  await run(['-p', 'read notes', '--session-id', ID], { home, cwd, responses: [toolReply(), textReply('done')] });
  const source = transcriptPath(home, cwd, ID);
  const bytes = readFileSync(source, 'utf8');
  const original = records(source);
  const fork = await run(['-p', 'next', '--resume', ID, '--fork-session'], { home, cwd, responses: [textReply('forked')] });
  assert.equal(fork.code, 0, fork.stderr);
  assert.ok(fork.id && fork.id !== ID, fork.stderr);
  assert.equal(readFileSync(source, 'utf8'), bytes);
  const copied = records(transcriptPath(home, cwd, fork.id));
  assert.deepEqual(copied.slice(0, original.length), original.map((r) => ({ ...r, sessionId: fork.id })));
  assert.equal(copied[original.length].parentUuid, original.at(-1).uuid);
  assert.ok(copied.every((r) => r.sessionId === fork.id));
  assert.equal(fork.calls[0].body.messages.length, 5);
  const named = await run(['-p', 'n', '--resume', ID, '--fork-session', '--session-id', OTHER], { home, cwd, responses: [textReply('x')] });
  assert.equal(named.id, OTHER, named.stderr);
  assert.equal(readFileSync(source, 'utf8'), bytes);
});

test('session errors exit 2 before any request', async (t) => {
  const { home, cwd } = await setup(t);
  await run(['-p', 'hi', '--session-id', ID], { home, cwd, responses: [textReply('one')] });
  const exists = await run(['-p', 'hi', '--session-id', ID], { home, cwd });
  assert.deepEqual([exists.code, exists.stderr], [2, `clodent: session ${ID} already exists; use --resume\n`]);
  const forkOnto = await run(['-p', 'hi', '--resume', ID, '--fork-session', '--session-id', ID], { home, cwd });
  assert.deepEqual([forkOnto.code, forkOnto.stderr], [2, `clodent: session ${ID} already exists; use --resume\n`]);
  const missing = await run(['-p', 'hi', '--resume', OTHER], { home, cwd });
  assert.deepEqual([missing.code, missing.stderr], [2, `clodent: no session ${OTHER}\n`]);
  const both = await run(['-p', 'hi', '--resume', ID, '--session-id', OTHER], { home, cwd });
  assert.deepEqual([both.code, both.stderr], [2, 'clodent: --session-id with --resume requires --fork-session\nclodent: see --help\n']);
  const elsewhere = await useTempDir(t);
  const forkAcross = await run(['-p', 'hi', '--resume', ID, '--fork-session', '--session-id', ID], { home, cwd: elsewhere });
  assert.deepEqual([forkAcross.code, forkAcross.stderr], [2, `clodent: session ${ID} already exists; use --resume\n`]);
  assert.equal(existsSync(transcriptPath(home, elsewhere, ID)), false);
  for (const res of [exists, forkOnto, missing, both, forkAcross]) assert.equal(res.calls.length, 0);
});

test('a --session-id whose transcript exists under another project dir is refused, fresh or forked', async (t) => {
  const { home, cwd } = await setup(t);
  const elsewhere = await useTempDir(t);
  await run(['-p', 'hi', '--session-id', ID], { home, cwd: elsewhere, responses: [textReply('one')] });
  await run(['-p', 'hi', '--session-id', OTHER], { home, cwd, responses: [textReply('two')] });
  const fresh = await run(['-p', 'hi', '--session-id', ID], { home, cwd });
  assert.deepEqual([fresh.code, fresh.stderr], [2, `clodent: session ${ID} already exists; use --resume\n`]);
  const fork = await run(['-p', 'hi', '--resume', OTHER, '--fork-session', '--session-id', ID], { home, cwd });
  assert.deepEqual([fork.code, fork.stderr], [2, `clodent: session ${ID} already exists; use --resume\n`]);
  assert.equal(existsSync(transcriptPath(home, cwd, ID)), false);
  for (const res of [fresh, fork]) assert.equal(res.calls.length, 0);
});

test('an uppercase --session-id is stored lowercased, and the same id in either case is then refused', async (t) => {
  const { home, cwd } = await setup(t);
  const upper = ID.toUpperCase();
  const res = await run(['-p', 'hi', '--session-id', upper], { home, cwd, responses: [textReply('one')] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.id, ID);
  assert.equal(records(transcriptPath(home, cwd, ID))[0].sessionId, ID);
  const again = await run(['-p', 'hi', '--session-id', upper], { home, cwd });
  assert.deepEqual([again.code, again.stderr], [2, `clodent: session ${ID} already exists; use --resume\n`]);
});

test('a CLODENT_HOME that cannot hold a transcript exits 2 with the error, before any request', async (t) => {
  const { home, cwd } = await setup(t);
  writeFileSync(join(home, 'projects'), '');
  const res = await run(['-p', 'hi'], { home, cwd, responses: [textReply('one')] });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /^clodent: ENOTDIR[^\n]*\n$/);
  assert.equal(res.calls.length, 0);
});

test('a truncated last line is dropped with a warning and the session resumes cleanly', async (t) => {
  const { home, cwd } = await setup(t);
  await run(['-p', 'hi', '--session-id', ID], { home, cwd, responses: [textReply('one')] });
  const path = transcriptPath(home, cwd, ID);
  const intact = records(path);
  appendFileSync(path, '{"type":"assistant","uu');
  const res = await run(['-p', 'again', '--resume', ID], { home, cwd, responses: [textReply('two')] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr.split('\n')[1], `clodent: ${path}: ignoring a truncated last line`);
  const after = records(path);
  assert.deepEqual(after.slice(0, intact.length), intact);
  assert.equal(after[intact.length].parentUuid, intact.at(-1).uuid);
});

test('a corrupt middle line exits 2 naming the line number', async (t) => {
  const { home, cwd } = await setup(t);
  await run(['-p', 'hi', '--session-id', ID], { home, cwd, responses: [textReply('one')] });
  const path = transcriptPath(home, cwd, ID);
  const lines = readFileSync(path, 'utf8').split('\n');
  lines[1] = '{oops';
  writeFileSync(path, lines.join('\n'));
  const res = await run(['-p', 'again', '--resume', ID], { home, cwd });
  assert.deepEqual([res.code, res.stderr], [2, `clodent: ${path}: line 2 is not valid JSON\n`]);
  assert.equal(res.calls.length, 0);
});

test('-p with an empty prompt exits 2 with no request and no transcript', async (t) => {
  const { home, cwd } = await setup(t);
  for (const argv of [['-p', ''], ['-p=']]) {
    const res = await run(argv, { home, cwd });
    assert.deepEqual([res.code, res.stdout, res.stderr], [2, '', 'clodent: -p needs a non-empty prompt\n']);
    assert.equal(res.calls.length, 0);
  }
  assert.equal(existsSync(join(home, 'projects')), false);
});
