import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ignoreBrokenPipes } from '../src/cli.js';

function failure(code) {
  return Object.assign(new Error(`write ${code}`), { code });
}

test('ignoreBrokenPipes swallows EIO and EPIPE on the stream and rethrows any other error', () => {
  const stream = ignoreBrokenPipes(new EventEmitter());
  assert.equal(stream.listenerCount('error'), 1);
  assert.doesNotThrow(() => stream.emit('error', failure('EPIPE')));
  assert.doesNotThrow(() => stream.emit('error', failure('EIO')));
  assert.throws(() => stream.emit('error', failure('ENOSPC')), { code: 'ENOSPC' });
  assert.throws(() => stream.emit('error', new Error('plain')), { message: 'plain' });
});
