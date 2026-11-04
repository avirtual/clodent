import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPACT_PROMPT, SUMMARY_PREFIX } from '../../src/agent/compact.js';
import { transcriptPath } from '../../src/session/paths.js';
import { hookGroup, readJsonl, runMain, strip, textReply, writeSettings } from '../helpers/run-main.js';
import { sse } from '../helpers/sse-builder.js';
import { hookOutput, script } from '../hooks/scripts.js';
import { useTempDir } from '../tools/tmp-dir.js';
import { startRepl, userTexts } from './harness.js';

const GUARD = { timeout: 5000 };
const SUMMARY = 'SUMMARY-TEXT of the work';
const http400 = { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'credit balance is too low' } }) };

async function dirs(t) {
  return { home: await useTempDir(t), cwd: await useTempDir(t), dir: await useTempDir(t) };
}

async function steps(repl, lines, from = 1) {
  for (const [i, line] of lines.entries()) {
    repl.stdin.type(`${line}\r`);
    await repl.prompts(from + i + 1);
  }
}

async function exit(repl) {
  repl.stdin.type('\x04');
  assert.equal(await repl.done, 0);
}

function kinds(records) {
  return records.map((r) => r.subtype ?? (r.isCompactSummary ? 'summary' : r.type));
}

test('/compact <instructions> summarises quietly, records boundary and summary, fires PreCompact and SessionStart (compact); the next prompt starts from the summary', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const log = join(dir, 'hooks.jsonl');
  const start = await script(dir, 'start.sh', `cat >> ${JSON.stringify(log)}\n${hookOutput({ hookEventName: 'SessionStart', additionalContext: 'briefing' })}`);
  const pre = await script(dir, 'pre.sh', `cat >> ${JSON.stringify(log)}`);
  const settings = writeSettings(dir, { hooks: { SessionStart: [hookGroup('compact', start)], PreCompact: [hookGroup('manual', pre)] } });
  const usage = { input_tokens: 1000, cache_read_input_tokens: 150, cache_creation_input_tokens: 50, output_tokens: 45 };
  const replies = [textReply('r1'), textReply('r2'), textReply(SUMMARY, usage), textReply('r3')];
  const repl = startRepl(['--settings', settings], { home, cwd, replies });
  await repl.prompts(1);
  await steps(repl, ['one', 'two', '/compact   keep the file list ', 'three']);
  await exit(repl);
  const [, second, summary, next] = repl.fetch.calls.map((call) => call.body);
  assert.deepEqual(summary.tool_choice, { type: 'none' });
  assert.equal('tool_choice' in second, false);
  assert.deepEqual(summary.system, second.system);
  assert.deepEqual(summary.tools, second.tools);
  assert.deepEqual(strip(summary.messages), [
    ...strip(second.messages),
    { role: 'assistant', content: [{ type: 'text', text: 'r2' }] },
    { role: 'user', content: [{ type: 'text', text: `${COMPACT_PROMPT}\n\nAdditional instructions: keep the file list` }] },
  ]);
  assert.equal(next.messages.length, 1);
  assert.deepEqual(userTexts(next), [`${SUMMARY_PREFIX}${SUMMARY}`, '<hook-context event="SessionStart">\nbriefing\n</hook-context>', 'three']);
  const out = repl.out.text;
  assert.equal(out.includes('SUMMARY-TEXT'), false);
  assert.match(out, /> \/compact {3}keep the file list \nclay: conversation compacted \(1200 → 45 tokens\)\n\[clay:cost\] \$\d+\.\d{4} \(in 1000, cache-read 150, cache-write 50, out 45\)\n/);
  assert.equal(repl.sessionIds().length, 1);
  const records = readJsonl(transcriptPath(home, cwd, repl.sessionIds()[0]));
  assert.deepEqual(kinds(records).slice(-5), ['compact_boundary', 'summary', 'user', 'assistant', 'turn_duration']);
  assert.equal(records.filter((r) => JSON.stringify(r).includes('SUMMARY-TEXT')).length, 1);
  const hooks = readJsonl(log).map((input) => [input.hook_event_name, input.trigger ?? input.source, input.custom_instructions]);
  assert.deepEqual(hooks, [['PreCompact', 'manual', 'keep the file list'], ['SessionStart', 'compact', undefined]]);
});

test('a compact pushes a statusLine update with used_tokens at postTokens and the same session id', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const status = join(dir, 'status.jsonl');
  const settings = writeSettings(dir, { statusLine: { type: 'command', command: `cat >> ${JSON.stringify(status)}` } });
  const repl = startRepl(['--settings', settings], { home, cwd, replies: [textReply('a', { input_tokens: 5000, output_tokens: 300 }), textReply(SUMMARY, { output_tokens: 77 })] });
  await repl.prompts(1);
  await steps(repl, ['one', '/compact']);
  await exit(repl);
  const last = readJsonl(status).at(-1);
  assert.equal(last.session_id, repl.sessionIds()[0]);
  assert.equal(last.context_window.used_tokens, 77);
  assert.ok(last.cost.total_cost_usd > 0);
});

test('--resume and --fork-session of a compacted session start from the summary, with nothing from before the boundary', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const first = startRepl([], { home, cwd, replies: [textReply('PRE-reply'), textReply(SUMMARY)] });
  await first.prompts(1);
  await steps(first, ['PRE-prompt', '/compact']);
  await exit(first);
  const [id] = first.sessionIds();
  const fork = await runMain(['--resume', id, '--fork-session', '-p', 'forked'], { home, cwd, responses: [textReply('f')] });
  assert.equal(fork.code, 0, fork.stderr);
  const log = join(dir, 'start.jsonl');
  const hook = await script(dir, 'start.sh', `cat >> ${JSON.stringify(log)}`);
  const settings = writeSettings(dir, { hooks: { SessionStart: [hookGroup('', hook)] } });
  const resumed = startRepl(['--settings', settings, '--resume', id], { home, cwd, replies: [textReply('r')] });
  await resumed.prompts(1);
  await steps(resumed, ['again']);
  await exit(resumed);
  assert.deepEqual(readJsonl(log).map((input) => [input.source, input.session_id]), [['resume', id]]);
  for (const [body, prompt] of [[fork.calls[0].body, 'forked'], [resumed.fetch.calls[0].body, 'again']]) {
    assert.deepEqual(strip(body.messages), [{ role: 'user', content: [{ type: 'text', text: `${SUMMARY_PREFIX}${SUMMARY}` }, { type: 'text', text: prompt }] }]);
    assert.equal(JSON.stringify(body.messages).includes('PRE-'), false);
  }
});

test('failed compacts leave the history and transcript unchanged and print why: nothing to compact, max_tokens, a 400, ^C', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const cut = { body: sse({ blocks: [{ type: 'text', text: 'SUMMARY-TEXT cut' }], stopReason: 'max_tokens' }) };
  const repl = startRepl([], { home, cwd, replies: [textReply('r1'), cut, http400] });
  await repl.prompts(1);
  const path = transcriptPath(home, cwd, repl.sessionIds()[0]);
  await steps(repl, ['/compact']);
  assert.equal(existsSync(path), false);
  assert.equal(repl.fetch.calls.length, 0);
  await steps(repl, ['one'], 2);
  const before = readFileSync(path, 'utf8');
  await steps(repl, ['/compact', '/compact'], 3);
  repl.stdin.type('/compact\r');
  await repl.fetch.called(4);
  repl.stdin.type('\x03');
  await repl.prompts(6);
  assert.equal(readFileSync(path, 'utf8'), before);
  repl.fetch.push(textReply('r2'));
  await steps(repl, ['two'], 6);
  await exit(repl);
  const out = repl.out.text;
  assert.ok(out.includes('> /compact\nclay: nothing to compact\n'));
  assert.ok(out.includes('> /compact\nclay: compact failed: stop_reason max_tokens\n'));
  assert.ok(out.includes('> /compact\nclay: compact failed: credit balance is too low\n'));
  assert.ok(out.includes('clay: compact failed: interrupted\n'));
  assert.equal(out.includes('clay: interrupted'), false);
  assert.equal(out.includes('SUMMARY-TEXT'), false);
  assert.deepEqual(strip(repl.fetch.calls[4].body.messages), [
    { role: 'user', content: [{ type: 'text', text: 'one' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'r1' }] },
    { role: 'user', content: [{ type: 'text', text: 'two' }] },
  ]);
});

test('a budget stop fails the compact before any request, with the transcript unchanged', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl(['--budget', '0.0001'], { home, cwd, replies: [textReply('r1')] });
  await repl.prompts(1);
  await steps(repl, ['one']);
  const path = transcriptPath(home, cwd, repl.sessionIds()[0]);
  const before = readFileSync(path, 'utf8');
  await steps(repl, ['/compact'], 2);
  await exit(repl);
  assert.equal(repl.fetch.calls.length, 1);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.match(repl.out.text, /> \/compact\n\[clay:budget\][^\n]*\nclay: compact failed: budget\n/);
});
