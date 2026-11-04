import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStatusLine, usedPercentage } from '../../src/hooks/status-line.js';
import { CONTEXT_WINDOW, contextWindowFor } from '../../src/hooks/context-window.js';
import { PRICES } from '../../src/cost/prices.js';
import { cleanEnv, useTempDir } from '../tools/tmp-dir.js';
import { script, settingsWith } from './scripts.js';

const GUARD = { timeout: 10000 };

const state = (n) => ({
  sessionId: 'sess-1',
  transcriptPath: '/clay/projects/x/sess-1.jsonl',
  modelId: 'claude-opus-5-5',
  usedTokens: 1000 * n,
  totalInputTokens: 900 * n,
  totalCostUsd: 0.01 * n,
});

async function statusLineIn(t, body) {
  const dir = await useTempDir(t);
  const out = join(dir, 'out.jsonl');
  const command = await script(dir, 'status.sh', body);
  const settings = settingsWith({}, { statusLine: { type: 'command', command }, env: { OUT: out } });
  const warnings = [];
  const line = createStatusLine({ settings, cwd: dir, env: cleanEnv(), version: '0.1.0' }, { spawn, warn: (w) => warnings.push(w) });
  const runs = async () => (await readFile(out, 'utf8')).split('\n').filter(Boolean);
  return { dir, command, line, warnings, runs };
}

test('every context window row is 200000 and every priced model has one', () => {
  assert.equal(CONTEXT_WINDOW.default, 200000);
  for (const id of Object.keys(PRICES)) assert.equal(CONTEXT_WINDOW[id], 200000, id);
  assert.equal(contextWindowFor('claude-opus-5-5'), 200000);
  assert.equal(contextWindowFor('claude-unknown'), 200000);
  assert.equal(contextWindowFor('constructor'), 200000);
});

test('usedPercentage is 0 to 100 with at most one decimal', () => {
  assert.equal(usedPercentage(12345, 200000), 6.2);
  assert.equal(usedPercentage(100000, 200000), 50);
  assert.equal(usedPercentage(250000, 200000), 100);
  assert.equal(usedPercentage(0, 200000), 0);
  assert.equal(usedPercentage(undefined, 200000), 0);
});

test('the script receives every statusLine field on stdin', GUARD, async (t) => {
  const { dir, line, warnings, runs } = await statusLineIn(t, 'cat >> "$OUT"');
  line.update({ ...state(1), usedTokens: 12345, totalInputTokens: 12000, totalCostUsd: 0.0421 });
  await line.flush();
  const lines = await runs();
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    session_id: 'sess-1',
    transcript_path: '/clay/projects/x/sess-1.jsonl',
    cwd: dir,
    version: '0.1.0',
    model: { id: 'claude-opus-5-5', display_name: 'claude-opus-5-5' },
    workspace: { current_dir: dir },
    context_window: { used_tokens: 12345, total_input_tokens: 12000, context_window_size: 200000, used_percentage: 6.2 },
    cost: { total_cost_usd: 0.0421 },
  });
  assert.deepEqual(warnings, []);
});

test('rapid updates coalesce: ten updates give at most two runs and the last run sees the last state', GUARD, async (t) => {
  const { line, warnings, runs } = await statusLineIn(t, 'cat >> "$OUT"');
  for (let n = 1; n <= 10; n += 1) line.update(state(n));
  await line.flush();
  const lines = await runs();
  assert.ok(lines.length >= 1 && lines.length <= 2, `${lines.length} runs`);
  assert.equal(JSON.parse(lines.at(-1)).context_window.used_tokens, 10000);
  assert.deepEqual(warnings, []);
  line.update(state(11));
  await line.flush();
  assert.equal(JSON.parse((await runs()).at(-1)).context_window.used_tokens, 11000);
});

test('a failing script warns once and later failures stay silent', GUARD, async (t) => {
  const { command, line, warnings, runs } = await statusLineIn(t, 'echo run >> "$OUT"; exit 1');
  line.update(state(1));
  await line.flush();
  line.update(state(2));
  await line.flush();
  assert.equal((await runs()).length, 2);
  assert.deepEqual(warnings, [`statusLine "${command.slice(0, 60)}": exit 1`]);
});

test('a null statusLine runs nothing', async () => {
  let spawned = 0;
  const line = createStatusLine({ settings: settingsWith({}), cwd: '/', env: {} }, { spawn: () => { spawned += 1; } });
  line.update(state(1));
  await line.flush();
  assert.equal(spawned, 0);
});
