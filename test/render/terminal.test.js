import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/render/terminal.js';

function stream(isTTY = false) {
  const chunks = [];
  return { isTTY, chunks, write: (s) => chunks.push(s), text: () => chunks.join('') };
}

function setup(mode, tty = false) {
  const out = stream(tty);
  const err = stream(tty);
  return { out, err, render: createRenderer({ out, err, mode }) };
}

const agg = (unpriced = []) => ({ usd: 0.0123, tokens: { in: 10, cacheRead: 2, cacheWrite: 3, out: 4 }, requests: 1, unpriced });
const COST = '[clodent:cost] $0.0123 (in 10, cache-read 2, cache-write 3, out 4)';
const TOTAL = '[clodent:cost] session total $0.0123 (in 10, cache-read 2, cache-write 3, out 4, requests 1)';
const message = (...texts) => ({
  role: 'assistant',
  content: [{ type: 'thinking', thinking: 'secret' }, ...texts.map((text) => ({ type: 'text', text })), { type: 'tool_use', id: 't', name: 'Read', input: {} }],
});

const TOOL_TURN = [
  { type: 'session_start', model: 'm', cwd: '/w', tools: ['Read'], permission: 'ask' },
  { type: 'request_start', attempt: 1 },
  { type: 'thinking_delta', text: 'secret', index: 0 },
  { type: 'text_delta', text: 'Reading.', index: 1 },
  { type: 'assistant_message', message: message('Reading.'), requestId: 'r', durationMs: 5, usd: 0.01, priced: true },
  { type: 'tool_use', id: 'a', name: 'Read', input: {}, summary: 'notes.md' },
  { type: 'permission', id: 'a', name: 'Read', decision: 'allow' },
  { type: 'tool_result', id: 'a', name: 'Read', content: 'File does not exist: /w/notes.md\nmore', isError: true, durationMs: 1 },
  { type: 'tool_use', id: 'b', name: 'Write', input: {}, summary: 'out.txt' },
  { type: 'permission', id: 'b', name: 'Write', decision: 'deny', reason: 'permission required: rerun with --yolo' },
  { type: 'tool_result', id: 'b', name: 'Write', content: 'permission required: rerun with --yolo', isError: true, durationMs: 0 },
  { type: 'tool_use', id: 'c', name: 'Glob', input: {}, summary: '' },
  { type: 'tool_result', id: 'c', name: 'Glob', content: 'ok', isError: false, durationMs: 0 },
  { type: 'request_start', attempt: 1 },
  { type: 'text_delta', text: 'Final ', index: 0 },
  { type: 'text_delta', text: 'answer.', index: 0 },
  { type: 'assistant_message', message: { role: 'assistant', content: [{ type: 'text', text: 'Final ' }, { type: 'text', text: 'answer.' }] }, requestId: 'r2', durationMs: 5, usd: 0.01, priced: true },
  { type: 'warning', message: 'response hit max_tokens' },
  { type: 'error', message: 'Overloaded', errorType: 'overloaded_error', status: null },
  { type: 'turn_end', stopReason: 'end_turn', turn: agg() },
  { type: 'session_end', session: agg() },
];

test('print mode: stdout is only the last message text plus a newline; the rest goes to stderr', () => {
  const { out, err, render } = setup('print');
  for (const e of TOOL_TURN) render(e);
  assert.equal(out.text(), 'Final answer.\n');
  assert.equal(
    err.text(),
    [
      '● Read notes.md',
      '  ✗ File does not exist: /w/notes.md',
      '● Write out.txt',
      '  ✗ permission required: rerun with --yolo',
      '● Glob',
      'clodent: response hit max_tokens',
      'clodent: Overloaded',
      COST,
      TOTAL,
      '',
    ].join('\n'),
  );
});

test('print mode: a turn with no assistant message writes nothing to stdout', () => {
  const { out, err, render } = setup('print');
  render({ type: 'budget_stop', result: { ok: false, spentUsd: 0.5, nextEstimateUsd: 0.25, budgetUsd: 0.6 } });
  render({ type: 'turn_end', stopReason: 'budget', turn: agg() });
  assert.equal(out.text(), '');
  assert.equal(err.text(), `[clodent:budget] stopped: spent $0.5000, next request est. $0.2500, budget $0.6000\n${COST}\n`);
});

test('print mode: narration from a tool round never reaches stdout', () => {
  const { out, err, render } = setup('print');
  render({ type: 'assistant_message', message: { ...message('Let me look.'), stop_reason: 'tool_use' } });
  render({ type: 'tool_use', id: 't', name: 'Read', input: {}, summary: 'a.md' });
  render({ type: 'tool_result', id: 't', name: 'Read', content: 'ok', isError: false, durationMs: 0 });
  render({ type: 'budget_stop', result: { ok: false, spentUsd: 0.5, nextEstimateUsd: 0.25, budgetUsd: 0.6 } });
  render({ type: 'turn_end', stopReason: 'budget', turn: agg() });
  render({ type: 'assistant_message', message: { ...message('Reading.'), stop_reason: 'tool_use' } });
  render({ type: 'assistant_message', message: { role: 'assistant', content: [], stop_reason: 'end_turn' } });
  render({ type: 'turn_end', stopReason: 'end_turn', turn: agg() });
  assert.equal(out.text(), '');
  assert.match(err.text(), /^● Read a\.md\n/);
});

test('print mode: each turn prints its own final text, then forgets it', () => {
  const { out, render } = setup('print');
  render({ type: 'assistant_message', message: message('one') });
  render({ type: 'turn_end', stopReason: 'end_turn', turn: agg() });
  render({ type: 'interrupted' });
  render({ type: 'turn_end', stopReason: 'interrupted', turn: agg() });
  assert.equal(out.text(), 'one\n');
});

test('the unpriced warning prints once per model', () => {
  const { err, render } = setup('print');
  render({ type: 'turn_end', stopReason: 'end_turn', turn: agg(['x-model']) });
  render({ type: 'turn_end', stopReason: 'end_turn', turn: agg(['x-model', 'y-model']) });
  const warnings = err.text().split('\n').filter((l) => l.includes('no price'));
  assert.deepEqual(warnings, [
    '[clodent:cost] warning: no price for model x-model; cost not counted',
    '[clodent:cost] warning: no price for model y-model; cost not counted',
  ]);
});

test('repl mode: text streams to out as it arrives, thinking never prints, everything else goes to out', () => {
  const { out, err, render } = setup('repl');
  for (const e of TOOL_TURN) render(e);
  assert.equal(err.text(), '');
  assert.equal(out.chunks[0], 'Reading.');
  assert.doesNotMatch(out.text(), /secret|thinking/);
  assert.equal(
    out.text(),
    [
      'Reading.',
      '● Read notes.md',
      '  ✗ File does not exist: /w/notes.md',
      '● Write out.txt',
      '  ✗ permission required: rerun with --yolo',
      '● Glob',
      'Final answer.',
      'clodent: response hit max_tokens',
      'clodent: Overloaded',
      COST,
      TOTAL,
      '',
    ].join('\n'),
  );
});

test('repl mode: a line event mid-text starts on a fresh line', () => {
  const { out, render } = setup('repl');
  render({ type: 'text_delta', text: 'half', index: 0 });
  render({ type: 'warning', message: 'w' });
  render({ type: 'text_delta', text: 'whole\n', index: 0 });
  render({ type: 'interrupted' });
  assert.equal(out.text(), 'half\nclodent: w\nwhole\nclodent: interrupted\n');
});

test('repl mode on a TTY marks thinking once per block, dimmed', () => {
  const { out, render } = setup('repl', true);
  render({ type: 'request_start', attempt: 1 });
  render({ type: 'thinking_delta', text: 'a', index: 0 });
  render({ type: 'thinking_delta', text: 'b', index: 0 });
  render({ type: 'thinking_delta', text: 'c', index: 2 });
  render({ type: 'request_start', attempt: 1 });
  render({ type: 'thinking_delta', text: 'd', index: 0 });
  assert.deepEqual(out.chunks, Array(3).fill('\x1b[2mthinking…\x1b[0m\n'));
});

test('no ANSI codes reach a stream that is not a TTY, in either mode', () => {
  for (const mode of ['print', 'repl']) {
    const { out, err, render } = setup(mode, false);
    for (const e of TOOL_TURN) render(e);
    render({ type: 'turn_end', stopReason: 'end_turn', turn: agg(['x']) });
    render({ type: 'budget_stop', result: { ok: false, reason: 'unpriced', model: 'x' } });
    render({ type: 'interrupted' });
    assert.doesNotMatch(out.text() + err.text(), /\x1b/, mode);
  }
  const tty = setup('print', true);
  for (const e of TOOL_TURN) tty.render(e);
  assert.match(tty.err.text(), /\x1b\[31m {2}✗/);
  assert.equal(tty.out.text(), 'Final answer.\n');
});

test('unknown event types and message_append are ignored', () => {
  const { out, err, render } = setup('print');
  render({ type: 'something_new' });
  render({ type: 'message_append', role: 'assistant', content: [{ type: 'text', text: 'x' }], kind: 'assistant', meta: {} });
  assert.equal(out.text() + err.text(), '');
});

test('a permission_request with an empty summary has no trailing space, as the tool_use line', () => {
  const { out, render } = setup('repl');
  render({ type: 'permission_request', id: 'toolu_1', name: 'Bash', input: {}, summary: '' });
  render({ type: 'permission_request', id: 'toolu_2', name: 'Bash', input: {}, summary: 'ls' });
  assert.equal(out.text(), '[clodent:permit Bash toolu_1]\n[clodent:permit Bash toolu_2] ls\n');
});

test('compacted prints the compacted line, then the cost line of the summary request', () => {
  const { out, render } = setup('repl');
  render({ type: 'compacted', trigger: 'manual', summary: 'secret summary', preTokens: 1200, postTokens: 45, turn: agg() });
  assert.equal(out.text(), `clodent: conversation compacted (1200 → 45 tokens)\n${COST}\n`);
});

test('a compact on an unpriced model prints the unpriced warning once, before its cost line', () => {
  const { out, render } = setup('repl');
  const WARN = '[clodent:cost] warning: no price for model x-model; cost not counted';
  render({ type: 'compacted', trigger: 'manual', summary: 's', preTokens: 1200, postTokens: 45, turn: agg(['x-model']) });
  render({ type: 'turn_end', stopReason: 'end_turn', turn: agg(['x-model']) });
  render({ type: 'compacted', trigger: 'manual', summary: 's', preTokens: 50, postTokens: 5, turn: agg(['x-model']) });
  const lines = out.text().split('\n');
  assert.deepEqual(lines.slice(0, 3), ['clodent: conversation compacted (1200 → 45 tokens)', WARN, COST]);
  assert.equal(lines.filter((l) => l === WARN).length, 1);
});

test('repl mode on a TTY colours warnings yellow, errors red and cost lines dim, and leaves the rest plain', () => {
  const { out, render } = setup('repl', true);
  render({ type: 'tool_use', id: 't1', name: 'Bash', input: {}, summary: 'ls' });
  render({ type: 'permission_request', id: 't1', name: 'Bash', input: {}, summary: 'ls' });
  render({ type: 'warning', message: 'w' });
  render({ type: 'interrupted' });
  render({ type: 'budget_stop', result: { ok: false, reason: 'unpriced', model: 'x' } });
  render({ type: 'error', message: 'e' });
  render({ type: 'tool_result', id: 't2', name: 'Read', content: 'bad', isError: true });
  render({ type: 'turn_end', stopReason: 'end_turn', turn: agg(['x-model']) });
  render({ type: 'session_end', session: agg() });
  assert.deepEqual(out.text().split('\n').slice(0, -1), [
    '● Bash ls',
    '[clodent:permit Bash t1] ls',
    '\x1b[33mclodent: w\x1b[0m',
    '\x1b[33mclodent: interrupted\x1b[0m',
    '\x1b[33m[clodent:budget] stopped: model x has no price; --budget needs a priced model\x1b[0m',
    '\x1b[31mclodent: e\x1b[0m',
    '\x1b[31m  ✗ bad\x1b[0m',
    '\x1b[33m[clodent:cost] warning: no price for model x-model; cost not counted\x1b[0m',
    `\x1b[2m${COST}\x1b[0m`,
    `\x1b[2m${TOTAL}\x1b[0m`,
  ]);
});
