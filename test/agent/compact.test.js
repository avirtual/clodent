import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPACT_PROMPT, SUMMARY_PREFIX } from '../../src/agent/compact.js';
import { createAgent, INTERRUPTED_RESULT } from '../../src/agent/loop.js';
import { createLedger } from '../../src/cost/ledger.js';
import { emptyOutcome } from '../../src/hooks/fire.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';
import { sse, sseError, sseEvents } from '../helpers/sse-builder.js';

const TOOL = { name: 'A', kind: 'read', description: 'a', input_schema: { type: 'object', properties: {} }, run: async () => ({ content: 'A ok', isError: false }) };
const MANUAL = { instructions: '', trigger: 'manual' };
const text = (value) => ({ type: 'text', text: value });
const reply = (value, extra = {}) => ({ body: sse({ blocks: [{ type: 'text', text: value }], ...extra }) });
const http400 = { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'credit balance is too low' } }) };

function strip(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => (key === 'cache_control' ? undefined : v)));
}

function harness(responses, { history, interrupted, budgetUsd, context = {}, onFire, onFetch, cacheTtl } = {}) {
  const events = [];
  const fired = [];
  const inner = createFakeFetch(responses);
  const fetch = (url, init) => {
    onFetch?.(inner.calls.length + 1);
    return inner(url, init);
  };
  fetch.calls = inner.calls;
  const ledger = createLedger({ budgetUsd }, {});
  const hooks = {
    async fire(event, extra, signal) {
      fired.push([event, extra]);
      onFire?.(event, extra, signal);
      return { ...emptyOutcome(), additionalContext: context[event] ?? [], warnings: event === 'PreCompact' ? ['pre warn'] : [] };
    },
  };
  const agent = createAgent(
    { model: 'claude-opus-5-5', system: 'sys', tools: [TOOL], permission: 'yolo', history, interrupted, cacheTtl },
    {
      fetch,
      env: { ANTHROPIC_API_KEY: 'k' },
      cwd: '/w',
      sleep: async () => {},
      random: () => 0.5,
      now: () => 0,
      ledger,
      hooks,
      emit: (event) => events.push(event),
    },
  );
  return { agent, events, fired, fetch, ledger, types: () => events.map((e) => e.type), bodies: () => fetch.calls.map((call) => call.body) };
}

test('an empty history is nothing to compact: no hook fires, no request is sent', async () => {
  const h = harness([]);
  assert.deepEqual(await h.agent.compact({ instructions: 'x', trigger: 'manual' }), { ok: false, reason: 'nothing to compact' });
  assert.equal(h.fetch.calls.length, 0);
  assert.deepEqual(h.fired, []);
  assert.deepEqual(h.types(), ['session_start']);
});

test('compact sends one quiet summary request, replaces the history with the summary, then fires SessionStart (compact)', async () => {
  const usage = { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 7 };
  const h = harness([reply('one'), reply(['the ', 'summary'], { usage }), reply('two')], { context: { SessionStart: ['briefing'], PreCompact: ['dropped'] } });
  await h.agent.runTurn('first');
  const before = h.agent.messages();
  const mark = h.events.length;
  const { turn, ...outcome } = await h.agent.compact({ instructions: 'keep paths', trigger: 'manual' });
  assert.deepEqual(outcome, { ok: true, preTokens: 240, postTokens: 7 });
  assert.deepEqual([turn.requests, turn.tokens], [1, { in: 10, cacheRead: 200, cacheWrite: 30, out: 7 }]);
  const [first, summary] = h.bodies();
  assert.deepEqual(summary.tool_choice, { type: 'none' });
  assert.equal('tool_choice' in first, false);
  assert.deepEqual(summary.system, first.system);
  assert.deepEqual(summary.tools, first.tools);
  assert.deepEqual(strip(summary.messages), [...before, { role: 'user', content: [text(`${COMPACT_PROMPT}\n\nAdditional instructions: keep paths`)] }]);
  assert.deepEqual(h.types().slice(mark), ['warning', 'request_start', 'compacted']);
  const compacted = h.events.at(-1);
  assert.deepEqual({ ...compacted, turn: compacted.turn.requests }, {
    type: 'compacted',
    trigger: 'manual',
    summary: 'the summary',
    message: { role: 'user', content: [text(`${SUMMARY_PREFIX}the summary`)] },
    reloaded: [],
    skipped: [],
    preTokens: 240,
    postTokens: 7,
    turn: 1,
  });
  assert.deepEqual(h.fired.slice(-2), [['PreCompact', { trigger: 'manual', custom_instructions: 'keep paths' }], ['SessionStart', { source: 'compact', model: 'claude-opus-5-5' }]]);
  assert.deepEqual(h.agent.messages(), [{ role: 'user', content: [text(`${SUMMARY_PREFIX}the summary`)] }]);
  await h.agent.runTurn('next');
  assert.deepEqual(strip(h.bodies()[2].messages), [
    { role: 'user', content: [text(`${SUMMARY_PREFIX}the summary`), text('<hook-context event="SessionStart">\nbriefing\n</hook-context>'), text('next')] },
  ]);
  assert.deepEqual(h.events.filter((e) => e.type === 'turn_end').map((e) => e.turn.requests), [1, 1]);
  assert.equal(h.ledger.session().requests, 3);
});

test('compact closes dangling tool_uses, merges its prompt into the trailing user message, and clears the interrupt flag', async () => {
  const history = [
    { role: 'user', content: [text('go')] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'A', input: {} }] },
  ];
  const h = harness([reply('sum'), reply('ok')], { history });
  assert.equal((await h.agent.compact(MANUAL)).ok, true);
  const closed = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: INTERRUPTED_RESULT, is_error: true }, text(COMPACT_PROMPT)] };
  assert.deepEqual(strip(h.bodies()[0].messages), [...history, closed]);
  await h.agent.runTurn('next');
  assert.deepEqual(strip(h.bodies()[1].messages), [{ role: 'user', content: [text(`${SUMMARY_PREFIX}sum`), text('next')] }]);
});

test('a failed summary leaves the history as it was, records its cost apart from the next turn, and emits no compacted', async () => {
  const cases = [
    ['max_tokens', reply('cut', { stopReason: 'max_tokens' }), 'stop_reason max_tokens', 2],
    ['refusal', reply('no', { stopReason: 'refusal' }), 'stop_reason refusal', 2],
    ['empty text', reply('  '), 'empty summary', 2],
    ['a 400', http400, 'credit balance is too low', 1],
  ];
  for (const [label, response, reason, requests] of cases) {
    const h = harness([reply('one'), response, reply('two')]);
    await h.agent.runTurn('first');
    const before = h.agent.messages();
    const { turn, ...outcome } = await h.agent.compact(MANUAL);
    assert.deepEqual(outcome, { ok: false, reason }, label);
    assert.equal(turn?.requests ?? 0, requests - 1, label);
    assert.deepEqual(h.agent.messages(), before, label);
    assert.equal(h.ledger.session().requests, requests, label);
    assert.equal(h.types().includes('compacted'), false, label);
    assert.equal(h.types().includes('error'), false, label);
    assert.deepEqual(h.fired.map(([event]) => event), ['UserPromptSubmit', 'Stop', 'PreCompact'], label);
    await h.agent.runTurn('again');
    assert.deepEqual(strip(h.bodies().at(-1).messages), [...before, { role: 'user', content: [text('again')] }], label);
    assert.equal(h.events.filter((e) => e.type === 'turn_end').at(-1).turn.requests, 1, label);
  }
});

test('a summary that fails after message_start charges its partial as the compact\'s turn, apart from the next turn', async () => {
  const head = sseEvents({ blocks: [{ type: 'text', text: 'half' }], usage: { input_tokens: 70 } }).slice(0, 3).join('');
  const h = harness([reply('one'), { body: head + sseError('invalid_request_error', 'bad thing') }, reply('two')]);
  await h.agent.runTurn('first');
  const { turn, ...outcome } = await h.agent.compact(MANUAL);
  assert.deepEqual(outcome, { ok: false, reason: 'bad thing' });
  assert.deepEqual([turn.requests, turn.tokens], [1, { in: 70, cacheRead: 0, cacheWrite: 0, out: 0 }]);
  assert.equal(h.ledger.session().requests, 2);
  await h.agent.runTurn('again');
  assert.equal(h.events.filter((e) => e.type === 'turn_end').at(-1).turn.requests, 1);
  assert.equal(h.ledger.session().requests, 3);
});

test('an abort during PreCompact or the summary request fails as interrupted with the history unchanged', async () => {
  for (const when of ['PreCompact', 'request']) {
    const controller = new AbortController();
    const h = harness([reply('one'), reply('sum')], {
      onFire: (event) => {
        if (event === 'PreCompact' && when === 'PreCompact') controller.abort();
      },
      onFetch: (n) => {
        if (n === 2 && when === 'request') controller.abort();
      },
    });
    await h.agent.runTurn('first');
    const before = h.agent.messages();
    assert.deepEqual(await h.agent.compact(MANUAL, { signal: controller.signal }), { ok: false, reason: 'interrupted' }, when);
    assert.deepEqual(h.agent.messages(), before, when);
    assert.equal(h.fetch.calls.length, when === 'request' ? 2 : 1, when);
    assert.equal(h.types().includes('interrupted'), false, when);
    assert.equal(h.fired.at(-1)[0], 'PreCompact', when);
  }
});

test('a budget that cannot cover the summary request stops the compact before it is sent', async () => {
  const h = harness([reply('one')], { budgetUsd: 0.0001 });
  await h.agent.runTurn('first');
  const before = h.agent.messages();
  assert.deepEqual(await h.agent.compact(MANUAL), { ok: false, reason: 'budget' });
  assert.equal(h.fetch.calls.length, 1);
  assert.equal(h.events.at(-1).type, 'budget_stop');
  assert.deepEqual(h.agent.messages(), before);
});

test('the compact summary request carries the settled pin on the last real user turn before its prompt', async () => {
  const h = harness([reply('one'), reply('the summary')]);
  await h.agent.runTurn('first');
  assert.equal((await h.agent.compact(MANUAL)).ok, true);
  const [first, summary] = h.bodies();
  const marked = (body) => body.messages.flatMap((message, i) => message.content.flatMap((block, j) => (block.cache_control ? [[i, j]] : [])));
  assert.deepEqual(marked(first), [[0, 0]]);
  assert.deepEqual(marked(summary), [[0, 0], [2, 0]]);
  assert.deepEqual(summary.messages[0].content.at(-1).cache_control, { type: 'ephemeral' });
});

test('with cacheTtl 1h the compact summary request marks system, tool and settled pin 1h and keeps the tail 5m', async () => {
  const h = harness([reply('one'), reply('the summary')], { cacheTtl: '1h' });
  await h.agent.runTurn('first');
  assert.equal((await h.agent.compact(MANUAL)).ok, true);
  const summary = h.bodies()[1];
  const long = { type: 'ephemeral', ttl: '1h' };
  assert.deepEqual(
    [summary.system[0].cache_control, summary.tools[0].cache_control, summary.messages[0].content.at(-1).cache_control, summary.messages[2].content.at(-1).cache_control],
    [long, long, long, { type: 'ephemeral' }],
  );
  assert.equal(JSON.stringify(summary).match(/"cache_control"/g).length, 4);
});
