import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createTranscript } from '../../src/session/transcript.js';
import { useTempDir } from '../tools/tmp-dir.js';

function counter() {
  let n = 0;
  return () => `uuid-${++n}`;
}

function lines(path) {
  return readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
}

const CLOCK = () => new Date(Date.UTC(2026, 10, 4, 12, 0, 0));

test('append writes one line per record with the common fields and an unbroken parentUuid chain', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 'p', 'q', 's.jsonl');
  const writes = [];
  const deps = {
    appendFileSync: (...args) => {
      writes.push(args[1]);
      appendFileSync(...args);
    },
    mkdirSync,
    clock: CLOCK,
    uuid: counter(),
  };
  const transcript = createTranscript({ path, sessionId: 's', cwd: '/w', version: '9.9.9' }, deps);
  assert.equal(transcript.path, path);
  transcript.append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  transcript.append({ type: 'system', subtype: 'turn_duration', durationMs: 5, messageCount: 1 });
  assert.equal(writes.length, 2);
  assert.ok(writes.every((w) => w.endsWith('\n') && w.indexOf('\n') === w.length - 1));
  const [a, b] = lines(path);
  const common = { isSidechain: false, timestamp: '2026-11-04T12:00:00.000Z', cwd: '/w', sessionId: 's', version: '9.9.9', entrypoint: 'clodent' };
  assert.deepEqual(a, { parentUuid: null, ...common, type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, uuid: 'uuid-1' });
  assert.deepEqual(b, { parentUuid: 'uuid-1', ...common, type: 'system', subtype: 'turn_duration', durationMs: 5, messageCount: 1, uuid: 'uuid-2' });
  assert.equal(transcript.lastUuid(), 'uuid-2');
});

test('the directories are created 0700 and the file 0600', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 'projects', '-w', 's.jsonl');
  const transcript = createTranscript({ path, sessionId: 's', cwd: '/w', version: '1' }, { appendFileSync, mkdirSync, clock: CLOCK, uuid: counter() });
  transcript.append({ type: 'user', message: { role: 'user', content: [] } });
  assert.equal(statSync(join(dir, 'projects')).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'projects', '-w')).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('parentUuid continues from a given uuid', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 'f.jsonl');
  const deps = { appendFileSync, mkdirSync, clock: CLOCK, uuid: counter() };
  createTranscript({ path, sessionId: 's', cwd: '/w', version: '1', parentUuid: 'old-last' }, deps).append({ type: 'user' });
  assert.equal(lines(path)[0].parentUuid, 'old-last');
});

test('copy re-stamps the sessionId keeping uuids, and the next record chains from the last copy', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 'f.jsonl');
  const transcript = createTranscript({ path, sessionId: 'new', cwd: '/w', version: '1' }, { appendFileSync, mkdirSync, clock: CLOCK, uuid: counter() });
  transcript.copy([
    { type: 'user', uuid: 'a', parentUuid: null, sessionId: 'old', timestamp: 't0' },
    { type: 'system', uuid: 'b', parentUuid: 'a', sessionId: 'old', timestamp: 't1' },
  ]);
  transcript.append({ type: 'user', message: { role: 'user', content: [] } });
  const records = lines(path);
  assert.deepEqual(records.slice(0, 2), [
    { type: 'user', uuid: 'a', parentUuid: null, sessionId: 'new', timestamp: 't0' },
    { type: 'system', uuid: 'b', parentUuid: 'a', sessionId: 'new', timestamp: 't1' },
  ]);
  assert.equal(records[2].parentUuid, 'b');
  assert.equal(records[2].sessionId, 'new');
});

test('a copied record without a uuid leaves the chain on the last uuid seen', async (t) => {
  const dir = await useTempDir(t);
  const path = join(dir, 'f.jsonl');
  const transcript = createTranscript({ path, sessionId: 'new', cwd: '/w', version: '1' }, { appendFileSync, mkdirSync, clock: CLOCK, uuid: counter() });
  transcript.copy([{ type: 'user', uuid: 'a', parentUuid: null }, { type: 'summary' }]);
  transcript.append({ type: 'user', message: { role: 'user', content: [] } });
  assert.equal(lines(path)[2].parentUuid, 'a');
});
