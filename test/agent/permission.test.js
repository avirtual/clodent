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

test('read-only allows read tools and denies write and exec by name', () => {
  assert.deepEqual(decide(READ, {}, 'read-only'), { allow: true });
  assert.deepEqual(decide(WRITE, {}, 'read-only'), { allow: false, reason: '--read-only: Write is not allowed' });
  assert.deepEqual(decide(BASH, { command: 'ls' }, 'read-only'), { allow: false, reason: '--read-only: Bash is not allowed' });
});

test('ask allows read tools and denies write and exec with the rerun hint', () => {
  assert.deepEqual(decide(READ, {}, 'ask'), { allow: true });
  assert.deepEqual(decide(WRITE, {}, 'ask'), { allow: false, reason: ASK_DENIAL });
  assert.deepEqual(decide(BASH, {}, 'ask'), { allow: false, reason: ASK_DENIAL });
  assert.equal(ASK_DENIAL, 'permission required: rerun with --yolo (interactive approval lands in the REPL)');
});

test('an unknown mode or kind is treated as deny, never allow', () => {
  assert.equal(decide(WRITE, {}, undefined).allow, false);
  assert.deepEqual(decide(READ, {}, undefined), { allow: false, reason: 'unknown permission mode undefined' });
  assert.equal(decide(READ, {}, 'sometimes').allow, false);
  assert.equal(decide(tool('X', 'weird'), {}, 'read-only').allow, false);
});
