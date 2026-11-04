import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVENT_TYPES } from '../../src/agent/events.js';
import { createAgent, INTERRUPT_MARKER, INTERRUPTED_RESULT } from '../../src/agent/loop.js';
import { ASK_DENIAL } from '../../src/agent/permission.js';
import { emptyOutcome } from '../../src/hooks/fire.js';
import { createLedger } from '../../src/cost/ledger.js';
import { createTools } from '../../src/tools/index.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';
import { sse, sseError, sseEvents } from '../helpers/sse-builder.js';
import { assertValidHistory } from '../helpers/valid-history.js';
import { plant, useTempDir } from '../tools/tmp-dir.js';

const MODEL = 'claude-opus-5-5';

function harness(responses, { tools = [], permission = 'yolo', budgetUsd, cwd = '/work', onEvent, sleep, history, interrupted, hooks } = {}) {
  const events = [];
  const sleeps = [];
  const fetch = createFakeFetch(responses);
  const ledger = createLedger({ budgetUsd }, {});
  const agent = createAgent(
    { model: MODEL, system: 'You are a test.', tools, permission, history, interrupted },
    {
      fetch,
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      cwd,
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        await sleep?.(ms, signal);
      },
      random: () => 0.5,
      now: () => 0,
      ledger,
      hooks,
      emit: (e) => {
        events.push(e);
        onEvent?.(e);
      },
    },
  );
  return { agent, events, sleeps, fetch, types: () => events.map((e) => e.type), of: (type) => events.filter((e) => e.type === type) };
}

function fakeTool(name, kind, log, result = { content: `${name} ok`, isError: false }) {
  return {
    name,
    kind,
    description: `${name} tool`,
    input_schema: { type: 'object', properties: {} },
    summary: (input) => `${name}:${input.n ?? ''}`,
    run: async (input, ctx) => {
      log.push({ name, input, signal: ctx.signal });
      return result;
    },
  };
}

function strip(messages) {
  return JSON.parse(JSON.stringify(messages, (key, value) => (key === 'cache_control' ? undefined : value)));
}

const textReply = (text, extra = {}) => ({ body: sse({ blocks: [{ type: 'text', text }], ...extra }) });
const toolReply = (uses, extra = {}) => ({
  body: sse({
    blocks: [
      { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
      ...uses.map((u, i) => ({ type: 'tool_use', id: `toolu_${i + 1}`, ...u })),
    ],
    stopReason: 'tool_use',
    ...extra,
  }),
});

test('EVENT_TYPES is a frozen list naming every event the loop emits', () => {
  assert.ok(Object.isFrozen(EVENT_TYPES));
  assert.deepEqual(EVENT_TYPES, [
    'session_start', 'request_start', 'text_delta', 'thinking_delta', 'assistant_message', 'message_append', 'tool_use',
    'permission_request', 'permission', 'tool_result', 'turn_end', 'budget_stop', 'warning', 'error', 'interrupted', 'compacted',
    'session_end',
  ]);
});

test('session_start names the model, cwd, tools and permission mode', () => {
  const h = harness([], { tools: [fakeTool('A', 'read', [])], permission: 'ask' });
  assert.deepEqual(h.events, [{ type: 'session_start', model: MODEL, cwd: '/work', tools: ['A'], permission: 'ask' }]);
});

test('a text-only turn streams deltas, records the message and ends ok', async () => {
  const h = harness([{ body: 'text-only.sse' }]);
  assert.deepEqual(await h.agent.runTurn('hi'), { stopReason: 'end_turn', ok: true });
  assert.deepEqual(h.types(), [
    'session_start', 'message_append', 'request_start', 'text_delta', 'text_delta', 'message_append', 'assistant_message', 'turn_end',
  ]);
  assert.deepEqual(h.of('text_delta').map((e) => [e.text, e.index]), [['Hello', 0], [', world!', 0]]);
  const [msg] = h.of('assistant_message');
  assert.equal(msg.message.content[0].text, 'Hello, world!');
  assert.equal(msg.priced, true);
  assert.ok(msg.usd > 0);
  assert.equal(msg.durationMs, 0);
  const [end] = h.of('turn_end');
  assert.equal(end.stopReason, 'end_turn');
  assert.deepEqual(end.turn.tokens, { in: 25, cacheRead: 0, cacheWrite: 0, out: 15 });
  assert.deepEqual(h.agent.messages(), [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Hello, world!' }] },
  ]);
});

test('tool definitions go on the wire without kind, summary or run', async () => {
  const h = harness([textReply('ok')], { tools: createTools() });
  await h.agent.runTurn('hi');
  const sent = strip(h.fetch.calls[0].body.tools);
  assert.deepEqual(sent.map((t) => Object.keys(t)), sent.map(() => ['name', 'description', 'input_schema']));
  assert.deepEqual(sent.map((t) => t.name), ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']);
});

test('tool_use runs a real Read, then the next request carries thinking, tool_use and tool_result', async (t) => {
  const dir = await useTempDir(t);
  await plant(dir, { 'notes.md': 'alpha\nbeta\n' });
  const h = harness([toolReply([{ name: 'Read', input: { file_path: 'notes.md' } }]), textReply('done')], {
    tools: createTools(),
    cwd: dir,
  });
  assert.deepEqual(await h.agent.runTurn('read notes'), { stopReason: 'end_turn', ok: true });
  assert.equal(h.fetch.calls.length, 2);
  assert.deepEqual(strip(h.fetch.calls[1].body.messages), [
    { role: 'user', content: [{ type: 'text', text: 'read notes' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'notes.md' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '     1\talpha\n     2\tbeta', is_error: false }],
    },
  ]);
  const [use] = h.of('tool_use');
  assert.deepEqual(use, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'notes.md' }, summary: 'notes.md' });
  assert.deepEqual(h.of('permission'), [{ type: 'permission', id: 'toolu_1', name: 'Read', decision: 'allow' }]);
  const [result] = h.of('tool_result');
  assert.equal(result.isError, false);
  assert.equal(typeof result.durationMs, 'number');
  assert.equal(h.of('turn_end')[0].turn.requests, 2);
});

test('two tool_use blocks run in order and both results go in one user message', async () => {
  const log = [];
  const tools = [fakeTool('A', 'read', log), fakeTool('B', 'read', log, { content: 'B broke', isError: true })];
  const h = harness([toolReply([{ name: 'B', input: { n: 1 } }, { name: 'A', input: { n: 2 } }]), textReply('done')], { tools });
  await h.agent.runTurn('go');
  assert.deepEqual(log.map((l) => l.name), ['B', 'A']);
  const last = h.fetch.calls[1].body.messages.at(-1);
  assert.deepEqual(strip(last.content), [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'B broke', is_error: true },
    { type: 'tool_result', tool_use_id: 'toolu_2', content: 'A ok', is_error: false },
  ]);
  assert.deepEqual(h.types().filter((x) => x.startsWith('tool_') || x === 'permission'), [
    'tool_use', 'permission', 'tool_result', 'tool_use', 'permission', 'tool_result',
  ]);
  assertValidHistory(h.agent.messages());
});

test('an unknown tool name gets an is_error result and the loop goes on', async () => {
  const h = harness([toolReply([{ name: 'Nope', input: {} }]), textReply('ok')]);
  assert.equal((await h.agent.runTurn('go')).ok, true);
  assert.deepEqual(strip(h.fetch.calls[1].body.messages.at(-1).content), [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'unknown tool Nope', is_error: true },
  ]);
  assert.deepEqual(h.of('permission'), []);
});

test('a tool that throws becomes an is_error result instead of a crash', async () => {
  const tool = { ...fakeTool('T', 'read', []), run: async () => { throw new Error('kaboom'); } };
  const h = harness([toolReply([{ name: 'T', input: {} }]), textReply('ok')], { tools: [tool] });
  assert.equal((await h.agent.runTurn('go')).ok, true);
  assert.equal(h.of('tool_result')[0].content, 'T failed: kaboom');
});

test('under ask, Write is denied with the reason as an is_error result and no file is written', async (t) => {
  const dir = await useTempDir(t);
  const h = harness([toolReply([{ name: 'Write', input: { file_path: 'out.txt', content: 'x' } }]), textReply('ok')], {
    tools: createTools(),
    cwd: dir,
    permission: 'ask',
  });
  await h.agent.runTurn('write');
  assert.equal(existsSync(join(dir, 'out.txt')), false);
  assert.deepEqual(h.of('permission'), [{ type: 'permission', id: 'toolu_1', name: 'Write', decision: 'deny', reason: ASK_DENIAL }]);
  assert.deepEqual(strip(h.fetch.calls[1].body.messages.at(-1).content), [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: ASK_DENIAL, is_error: true },
  ]);
});

test('under yolo, Write creates the file', async (t) => {
  const dir = await useTempDir(t);
  const h = harness([toolReply([{ name: 'Write', input: { file_path: 'out.txt', content: 'x' } }]), textReply('ok')], {
    tools: createTools(),
    cwd: dir,
    permission: 'yolo',
  });
  await h.agent.runTurn('write');
  assert.equal(existsSync(join(dir, 'out.txt')), true);
  assert.equal(h.of('permission')[0].decision, 'allow');
});

test('under read-only, a Bash command that is not read-only is denied and never spawned', async () => {
  const spawned = [];
  const tools = createTools({ spawn: (...args) => spawned.push(args) });
  const h = harness([toolReply([{ name: 'Bash', input: { command: 'touch x' } }]), textReply('ok')], { tools, permission: 'read-only' });
  await h.agent.runTurn('touch');
  assert.deepEqual(spawned, []);
  assert.deepEqual(h.of('tool_result').map((e) => [e.content, e.isError]), [['--read-only: Bash command is not read-only (touch is not a read-only command)', true]]);
});

test('an interrupt that lands during PreToolUse stops the call before it runs', async () => {
  const controller = new AbortController();
  const log = [];
  const hooks = {
    fire: async (event) => {
      if (event === 'PreToolUse') controller.abort();
      return emptyOutcome();
    },
  };
  const h = harness([toolReply([{ name: 'W', input: {} }]), textReply('never')], { tools: [fakeTool('W', 'write', log)], hooks });
  await h.agent.runTurn('go', { signal: controller.signal });
  assert.deepEqual(log, []);
  assert.deepEqual(h.of('tool_result').map((e) => [e.id, e.content, e.isError]), [['toolu_1', INTERRUPTED_RESULT, true]]);
});

test('a budget below the first request cost stops before the second request', async () => {
  const log = [];
  const h = harness([toolReply([{ name: 'A', input: {} }]), textReply('never')], {
    tools: [fakeTool('A', 'read', log)],
    budgetUsd: 0.0001,
  });
  assert.deepEqual(await h.agent.runTurn('go'), { stopReason: 'budget', ok: false });
  assert.equal(h.fetch.calls.length, 1);
  const [stop] = h.of('budget_stop');
  assert.equal(stop.result.ok, false);
  assert.equal(stop.result.budgetUsd, 0.0001);
  assert.equal(h.of('turn_end')[0].stopReason, 'budget');
  assertValidHistory(h.agent.messages());
});

test('pause_turn re-sends with no new user content', async () => {
  const h = harness([textReply('part one', { stopReason: 'pause_turn' }), textReply('part two')]);
  assert.deepEqual(await h.agent.runTurn('go'), { stopReason: 'end_turn', ok: true });
  assert.equal(h.fetch.calls.length, 2);
  assert.deepEqual(strip(h.fetch.calls[1].body.messages), [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'part one' }] },
  ]);
  assertValidHistory(h.agent.messages());
});

test('max_tokens warns and ends not ok; refusal ends not ok without a warning', async () => {
  const h = harness([textReply('cut', { stopReason: 'max_tokens' })]);
  assert.deepEqual(await h.agent.runTurn('go'), { stopReason: 'max_tokens', ok: false });
  assert.deepEqual(h.of('warning'), [{ type: 'warning', message: 'response hit max_tokens' }]);
  const r = harness([textReply('no', { stopReason: 'refusal' })]);
  assert.deepEqual(await r.agent.runTurn('go'), { stopReason: 'refusal', ok: false });
  assert.deepEqual(r.of('warning'), []);
});

test('stop_sequence ends ok; an unknown stop_reason warns and ends not ok', async () => {
  const s = harness([textReply('x', { stopReason: 'stop_sequence' })]);
  assert.deepEqual(await s.agent.runTurn('go'), { stopReason: 'stop_sequence', ok: true });
  const u = harness([textReply('x', { stopReason: 'model_context_window_exceeded' })]);
  assert.deepEqual(await u.agent.runTurn('go'), { stopReason: 'model_context_window_exceeded', ok: false });
  assert.deepEqual(u.of('warning'), [{ type: 'warning', message: 'unexpected stop_reason model_context_window_exceeded' }]);
});

test('a mid-stream overloaded error re-sends the same request after 2 s', async () => {
  const h = harness([{ body: 'error-mid-stream.sse' }, { body: 'text-only.sse' }]);
  assert.deepEqual(await h.agent.runTurn('go'), { stopReason: 'end_turn', ok: true });
  assert.deepEqual(h.sleeps, [2000]);
  assert.deepEqual(h.fetch.calls[0].body, h.fetch.calls[1].body);
  assert.deepEqual(h.of('request_start').map((e) => e.attempt), [1, 2]);
  assert.deepEqual(h.of('warning'), [{ type: 'warning', message: 'Overloaded; retrying in 2 s' }]);
  assert.deepEqual(h.agent.messages()[1], { role: 'assistant', content: [{ type: 'text', text: 'Hello, world!' }] });
});

test('an abort during the mid-stream retry wait discards the partial of the failed attempt', async () => {
  const controller = new AbortController();
  const head = sseEvents({ blocks: [{ type: 'text', text: 'Completed.' }] }).slice(0, 4).join('');
  const h = harness([{ body: head + sseError('overloaded_error', 'Overloaded') }], {
    sleep: async (ms, signal) => {
      controller.abort();
      signal.throwIfAborted();
    },
  });
  assert.deepEqual(await h.agent.runTurn('go', { signal: controller.signal }), { stopReason: 'interrupted', ok: false });
  assert.deepEqual(h.sleeps, [2000]);
  assert.deepEqual(h.agent.messages(), [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]);
  assert.deepEqual(h.of('message_append').map((e) => e.kind), ['prompt']);
});

test('three mid-stream overloaded errors in a row emit the API message and end not ok', async () => {
  const h = harness([{ body: 'error-mid-stream.sse' }, { body: 'error-mid-stream.sse' }, { body: 'error-mid-stream.sse' }]);
  assert.deepEqual(await h.agent.runTurn('go'), { stopReason: 'error', ok: false });
  assert.deepEqual(h.sleeps, [2000, 4000]);
  assert.deepEqual(h.of('error'), [{ type: 'error', message: 'Overloaded', errorType: 'overloaded_error', status: null }]);
  assert.equal(h.of('turn_end').length, 1);
});

test('a mid-stream api_error retries; other mid-stream and HTTP errors do not', async () => {
  const head = sseEvents({ blocks: [{ type: 'text', text: 'x' }] }).slice(0, 3).join('');
  const api = harness([{ body: head + sseError('api_error', 'Internal') }, textReply('ok')]);
  assert.equal((await api.agent.runTurn('go')).ok, true);
  const bad = harness([{ body: head + sseError('invalid_request_error', 'bad thing') }]);
  assert.equal((await bad.agent.runTurn('go')).ok, false);
  assert.deepEqual(bad.sleeps, []);
  assert.deepEqual(bad.of('error')[0], { type: 'error', message: 'bad thing', errorType: 'invalid_request_error', status: null });
  const http = harness([{ status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'credit balance is too low' } }) }]);
  assert.equal((await http.agent.runTurn('go')).ok, false);
  assert.deepEqual(http.of('error')[0], { type: 'error', message: 'credit balance is too low', errorType: 'invalid_request_error', status: 400 });
  assert.deepEqual(http.agent.messages(), [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]);
});

test('an interrupt mid-stream keeps completed text, and the next request alternates and carries the marker', async () => {
  const controller = new AbortController();
  const body = sse({ blocks: [{ type: 'text', text: 'Kept.' }, { type: 'text', text: ['Cut ', 'off'] }, { type: 'tool_use', id: 't', name: 'A', input: {} }] });
  const h = harness([{ body }, textReply('fresh')], {
    onEvent: (e) => {
      if (e.type === 'text_delta' && e.index === 1) controller.abort();
    },
  });
  assert.deepEqual(await h.agent.runTurn('first', { signal: controller.signal }), { stopReason: 'interrupted', ok: false });
  assert.deepEqual(h.types().slice(-2), ['interrupted', 'turn_end']);
  assert.deepEqual(h.of('assistant_message'), []);
  assert.deepEqual(h.agent.messages()[1], { role: 'assistant', content: [{ type: 'text', text: 'Kept.' }] });
  assert.deepEqual(await h.agent.runTurn('second'), { stopReason: 'end_turn', ok: true });
  const sent = strip(h.fetch.calls[1].body.messages);
  assertValidHistory(sent);
  assert.deepEqual(sent.at(-1), {
    role: 'user',
    content: [{ type: 'text', text: INTERRUPT_MARKER }, { type: 'text', text: 'second' }],
  });
});

test('an interrupt with nothing kept merges the next prompt into the same user message', async () => {
  const controller = new AbortController();
  const h = harness([{ body: sse({ blocks: [{ type: 'text', text: ['a', 'b'] }] }) }, textReply('ok')], {
    onEvent: (e) => e.type === 'text_delta' && controller.abort(),
  });
  await h.agent.runTurn('first', { signal: controller.signal });
  await h.agent.runTurn('second');
  const sent = strip(h.fetch.calls[1].body.messages);
  assertValidHistory(sent);
  assert.deepEqual(sent, [
    { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: INTERRUPT_MARKER }, { type: 'text', text: 'second' }] },
  ]);
});

test('an interrupt during a tool run passes the signal, keeps that result and synthesizes the rest', async () => {
  const controller = new AbortController();
  const seen = [];
  const slow = {
    ...fakeTool('Slow', 'read', []),
    run: (input, ctx) =>
      new Promise((resolve) => {
        seen.push(ctx.signal);
        ctx.signal.addEventListener('abort', () => resolve({ content: 'stopped early', isError: true }), { once: true });
      }),
  };
  const log = [];
  const h = harness([toolReply([{ name: 'Slow', input: {} }, { name: 'A', input: {} }]), textReply('after')], {
    tools: [slow, fakeTool('A', 'read', log)],
    onEvent: (e) => e.type === 'tool_use' && e.name === 'Slow' && queueMicrotask(() => controller.abort()),
  });
  assert.deepEqual(await h.agent.runTurn('go', { signal: controller.signal }), { stopReason: 'interrupted', ok: false });
  assert.equal(seen[0], controller.signal);
  assert.deepEqual(log, []);
  assert.deepEqual(h.of('tool_result').map((e) => [e.id, e.content]), [['toolu_1', 'stopped early'], ['toolu_2', INTERRUPTED_RESULT]]);
  assert.equal(h.fetch.calls.length, 1);
  await h.agent.runTurn('next');
  const sent = strip(h.fetch.calls[1].body.messages);
  assertValidHistory(sent);
  assert.deepEqual(sent.at(-1).content, [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'stopped early', is_error: true },
    { type: 'tool_result', tool_use_id: 'toolu_2', content: INTERRUPTED_RESULT, is_error: true },
    { type: 'text', text: INTERRUPT_MARKER },
    { type: 'text', text: 'next' },
  ]);
});

test('endSession emits session_end with the session aggregate', async () => {
  const h = harness([{ body: 'text-only.sse' }, { body: 'text-only.sse' }]);
  await h.agent.runTurn('a');
  await h.agent.runTurn('b');
  const session = h.agent.endSession();
  assert.equal(session.requests, 2);
  assert.deepEqual(h.events.at(-1), { type: 'session_end', session });
  assert.deepEqual(h.of('turn_end').map((e) => e.turn.requests), [1, 1]);
});

test('every emitted event type is in EVENT_TYPES', async () => {
  const h = harness([toolReply([{ name: 'Nope', input: {} }]), { body: 'error-mid-stream.sse' }, { body: 'thinking-text.sse' }]);
  await h.agent.runTurn('go');
  h.agent.endSession();
  for (const type of h.types()) assert.ok(EVENT_TYPES.includes(type), type);
});

test('every append emits message_append with the blocks just appended, its kind and meta', async () => {
  const h = harness([toolReply([{ name: 'A', input: { n: 1 } }]), textReply('done')], { tools: [fakeTool('A', 'read', [])] });
  await h.agent.runTurn('go');
  const appends = h.of('message_append');
  assert.deepEqual(appends.map((e) => [e.role, e.kind]), [['user', 'prompt'], ['assistant', 'assistant'], ['user', 'tool_results'], ['assistant', 'assistant']]);
  assert.deepEqual(appends[0], { type: 'message_append', role: 'user', content: [{ type: 'text', text: 'go' }], kind: 'prompt', meta: {} });
  assert.deepEqual(appends[2].content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'A ok', is_error: false }]);
  assert.deepEqual(appends[2].meta, {});
  const [first] = h.of('assistant_message');
  assert.deepEqual(appends[1].content, first.message.content);
  assert.deepEqual(appends[1].meta, { message: first.message, requestId: first.requestId, durationMs: first.durationMs, usd: first.usd });
  const types = h.types();
  assert.equal(types[types.indexOf('assistant_message') - 1], 'message_append');
});

test('an interrupt emits message_append of kind partial for the kept text', async () => {
  const controller = new AbortController();
  const body = sse({ blocks: [{ type: 'text', text: 'Kept.' }, { type: 'text', text: ['Cut ', 'off'] }] });
  const h = harness([{ body }], { onEvent: (e) => e.type === 'text_delta' && e.index === 1 && controller.abort() });
  await h.agent.runTurn('go', { signal: controller.signal });
  const appends = h.of('message_append');
  assert.deepEqual(appends.at(-1), { type: 'message_append', role: 'assistant', content: [{ type: 'text', text: 'Kept.' }], kind: 'partial', meta: {} });
  assert.deepEqual(h.types().slice(-3), ['message_append', 'interrupted', 'turn_end']);
});

test('an empty assistant message emits message_append but adds nothing to the history', async () => {
  const h = harness([{ body: sse({ blocks: [] }) }]);
  assert.deepEqual(await h.agent.runTurn('go'), { stopReason: 'end_turn', ok: true });
  assert.deepEqual(h.of('message_append').map((e) => [e.kind, e.content]), [['prompt', [{ type: 'text', text: 'go' }]], ['assistant', []]]);
  assert.deepEqual(h.agent.messages(), [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]);
});

test('max_tokens with a complete tool_use synthesizes interrupted results, so the next request is valid', async () => {
  const log = [];
  const h = harness([toolReply([{ name: 'A', input: { n: 1 } }], { stopReason: 'max_tokens' }), textReply('ok')], {
    tools: [fakeTool('A', 'read', log)],
  });
  assert.deepEqual(await h.agent.runTurn('go'), { stopReason: 'max_tokens', ok: false });
  assert.deepEqual(log, []);
  assert.deepEqual(h.of('tool_result').map((e) => [e.id, e.content, e.isError]), [['toolu_1', INTERRUPTED_RESULT, true]]);
  assert.deepEqual(await h.agent.runTurn('again'), { stopReason: 'end_turn', ok: true });
  const sent = strip(h.fetch.calls[1].body.messages);
  assertValidHistory(sent);
  assert.deepEqual(sent.at(-1).content, [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: INTERRUPTED_RESULT, is_error: true },
    { type: 'text', text: 'again' },
  ]);
});

test('a call that never ran gets its tool_use event before its interrupted tool_result', async () => {
  const controller = new AbortController();
  const tools = [fakeTool('A', 'read', []), fakeTool('B', 'read', [])];
  const h = harness([toolReply([{ name: 'A', input: { n: 1 } }, { name: 'B', input: { n: 2 } }])], {
    tools,
    onEvent: (e) => e.type === 'tool_result' && e.id === 'toolu_1' && controller.abort(),
  });
  await h.agent.runTurn('go', { signal: controller.signal });
  const calls = h.events.filter((e) => e.type === 'tool_use' || e.type === 'tool_result').map((e) => [e.type, e.id]);
  assert.deepEqual(calls, [['tool_use', 'toolu_1'], ['tool_result', 'toolu_1'], ['tool_use', 'toolu_2'], ['tool_result', 'toolu_2']]);
  assert.deepEqual(h.of('tool_use')[1], { type: 'tool_use', id: 'toolu_2', name: 'B', input: { n: 2 }, summary: 'B:2' });
});

test('createAgent starts from a given history and interrupted flag without mutating them', async () => {
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    { role: 'user', content: [{ type: 'text', text: 'before' }] },
  ];
  const frozen = structuredClone(history);
  const h = harness([textReply('ok')], { history, interrupted: true });
  await h.agent.runTurn('next');
  assert.deepEqual(history, frozen);
  assert.deepEqual(strip(h.fetch.calls[0].body.messages), [
    ...frozen.slice(0, 2),
    { role: 'user', content: [{ type: 'text', text: 'before' }, { type: 'text', text: INTERRUPT_MARKER }, { type: 'text', text: 'next' }] },
  ]);
});
