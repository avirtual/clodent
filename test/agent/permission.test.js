import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASK_DENIAL, decide } from '../../src/agent/permission.js';

const tool = (name, kind) => ({ name, kind });
const READ = tool('Read', 'read');
const WRITE = tool('Write', 'write');
const BASH = tool('Bash', 'exec');

test('yolo allows every kind', () => {
  for (const t of [READ, WRITE, BASH]) assert.deepEqual(decide(t, {}, 'yolo'), { allow: true });
});

test('read-only allows read tools and denies write tools by name', () => {
  assert.deepEqual(decide(READ, {}, 'read-only'), { allow: true });
  assert.deepEqual(decide(WRITE, {}, 'read-only'), { allow: false, reason: '--read-only: Write is not allowed' });
});

test('read-only runs a read-only Bash command and refuses any other with the reason', () => {
  assert.deepEqual(decide(BASH, { command: 'ls' }, 'read-only'), { allow: true });
  assert.deepEqual(decide(BASH, { command: 'rm x' }, 'read-only'), { allow: false, reason: '--read-only: Bash command is not read-only (rm is not a read-only command)' });
  assert.deepEqual(decide(BASH, {}, 'read-only'), { allow: false, reason: '--read-only: Bash command is not read-only (empty command)' });
});

test('ask runs a read-only Bash command without asking', () => {
  assert.deepEqual(decide(BASH, { command: 'ls' }, 'ask'), { allow: true });
  for (const [t, command] of [[BASH, 'rm x'], [tool('Other', 'exec'), 'ls']]) {
    const verdict = decide(t, { command }, 'ask');
    assert.deepEqual([verdict.allow, verdict.reason], [false, ASK_DENIAL], `${t.name} ${command}`);
  }
});

test('ask allows read tools and marks write and exec as an ask, with the rerun hint as the refusal', () => {
  assert.deepEqual(decide(READ, {}, 'ask'), { allow: true });
  assert.deepEqual(decide(WRITE, {}, 'ask'), { allow: false, ask: true, reason: ASK_DENIAL });
  assert.deepEqual(decide(BASH, {}, 'ask'), { allow: false, ask: true, reason: ASK_DENIAL });
  assert.equal(ASK_DENIAL, 'permission required: run clodent without -p to approve it, or pass --yolo');
});

test('an unknown mode or kind is treated as deny, never allow', () => {
  assert.equal(decide(WRITE, {}, undefined).allow, false);
  assert.deepEqual(decide(READ, {}, undefined), { allow: false, reason: 'unknown permission mode undefined' });
  assert.equal(decide(READ, {}, 'sometimes').allow, false);
  assert.equal(decide(tool('X', 'weird'), {}, 'read-only').allow, false);
});

test('accept-edits allows read and write tools and a read-only Bash command, and asks for any other Bash command', () => {
  const EDIT = tool('Edit', 'write');
  for (const t of [READ, WRITE, EDIT]) assert.deepEqual(decide(t, { file_path: 'x' }, 'accept-edits'), { allow: true }, t.name);
  assert.deepEqual(decide(BASH, { command: 'ls' }, 'accept-edits'), { allow: true });
  assert.deepEqual(decide(BASH, { command: 'rm x' }, 'accept-edits'), { allow: false, ask: true, reason: ASK_DENIAL });
  assert.deepEqual(decide(tool('Other', 'exec'), { command: 'ls' }, 'accept-edits'), { allow: false, ask: true, reason: ASK_DENIAL });
});
