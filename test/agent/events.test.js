import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EVENT_TYPES } from '../../src/agent/events.js';

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const section = readme.split('\n### Events\n')[1].split('\n### ')[0];

test('README ### Events has one row per event type, in EVENT_TYPES order', () => {
  const rows = section.split('\n').filter((line) => line.startsWith('| `'));
  assert.deepEqual(rows.map((row) => row.match(/^\| `([a-z_]+)`/)[1]), [...EVENT_TYPES]);
});

test('README ### Events names every stopReason the loop makes up', () => {
  const sentence = section.split('\n').find((line) => line.startsWith('`stopReason`'));
  for (const reason of ['budget', 'interrupted', 'error', 'unknown']) assert.ok(sentence.includes(`\`${reason}\``), reason);
});
