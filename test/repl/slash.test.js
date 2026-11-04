import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, runCommand } from '../../src/repl/slash.js';

test('/model with more than one word prints the usage error and keeps the model', async () => {
  const printed = [];
  const ctx = { print: (line) => printed.push(line), model: () => 'claude-opus-5-5', setModel: () => assert.fail('setModel ran') };
  await runCommand(parseCommand({ text: '/model a b', parts: [{ kind: 'typed', text: '/model a b' }] }), ctx);
  assert.deepEqual(printed, ['clodent: /model takes one model id']);
});
