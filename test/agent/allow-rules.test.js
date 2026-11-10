import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../../src/agent/loop.js';
import { ASK_DENIAL } from '../../src/agent/permission.js';
import { createLedger } from '../../src/cost/ledger.js';
import { emptyOutcome } from '../../src/hooks/fire.js';
import { createGuard } from '../../src/permissions/guard.js';
import { parseRules } from '../../src/permissions/rules.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';
import { sse } from '../helpers/sse-builder.js';

const WHERE = { file: '/etc/clodent/settings.json', cwd: '/work', home: '/Users/u' };
const missing = async () => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

function guardOf(lists) {
  const parsed = Object.fromEntries(Object.entries(lists).map(([key, list]) => [key, parseRules(list, `permissions.${key}`, WHERE)]));
  return createGuard(parsed, { realpath: missing, lstat: missing, readdir: missing, platform: 'linux', home: WHERE.home });
}

const textReply = (text) => ({ body: sse({ blocks: [{ type: 'text', text }] }) });
const toolReply = (name, input) => ({ body: sse({ blocks: [{ type: 'tool_use', id: 'toolu_1', name, input }], stopReason: 'tool_use' }) });

function tool(name, kind, log) {
  return { name, kind, description: name, input_schema: { type: 'object', properties: {} }, run: async (input) => (log.push(name), { content: `${name} ran`, isError: false }) };
}

async function call(name, input, { lists = {}, permission = 'ask', pre = {}, ask } = {}) {
  const log = [];
  const events = [];
  const asked = [];
  const hooks = { fire: async (event) => ({ ...emptyOutcome(), ...(event === 'PreToolUse' ? pre : {}) }) };
  const agent = createAgent(
    { model: 'claude-opus-5-5', system: 'test', tools: [tool('Write', 'write', log), tool('Bash', 'exec', log), tool('mcp__clodex__dm', 'exec', log)], permission, ask: ask && (async (request) => (asked.push(request.id), ask)) },
    {
      fetch: createFakeFetch([toolReply(name, input), textReply('done')]),
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      cwd: '/work',
      sleep: async () => {},
      random: () => 0.5,
      now: () => 0,
      ledger: createLedger({}, {}),
      hooks,
      guard: guardOf(lists),
      emit: (event) => events.push(event),
    },
  );
  await agent.runTurn('go');
  return { ran: log.length === 1, asked: asked.length, permission: events.filter((event) => event.type === 'permission') };
}

const WRITE = ['Write', { file_path: 'src/a.js', content: 'x' }];

test('an allow rule runs a call that would ask, in print mode without an ask callback, and emits a plain allow event', async () => {
  assert.deepEqual(await call(...WRITE), { ran: false, asked: 0, permission: [{ type: 'permission', id: 'toolu_1', name: 'Write', decision: 'deny', reason: ASK_DENIAL }] });
  for (const permission of ['ask', 'accept-edits']) {
    const res = await call(...WRITE, { lists: { allow: ['Write(./src/**)'] }, permission, ask: { allow: false } });
    assert.deepEqual(res, { ran: true, asked: 0, permission: [{ type: 'permission', id: 'toolu_1', name: 'Write', decision: 'allow' }] }, permission);
  }
  const bash = await call('Bash', { command: 'git status -s' }, { lists: { allow: ['Bash(git status:*)'] } });
  assert.deepEqual([bash.ran, bash.permission[0].decision], [true, 'allow']);
  const clodex = await call('mcp__clodex__dm', { to: 'lead' }, { lists: { allow: ['mcp__clodex__dm'] } });
  assert.deepEqual([clodex.ran, clodex.permission[0].decision], [true, 'allow']);
});

test('an allow rule overrides no PreToolUse deny or ask, no deny or ask rule, and not --read-only; --yolo runs either way', async () => {
  const allow = ['Write(./src/**)'];
  const refused = async (options, reason) => {
    const res = await call(...WRITE, { ...options, lists: { allow, ...options.lists } });
    assert.deepEqual([res.ran, res.asked, res.permission[0].reason], [false, 0, reason], JSON.stringify(options));
  };
  await refused({ pre: { decision: 'deny', reason: 'hook says no' } }, 'hook says no');
  await refused({ lists: { deny: ['Write(./src/a.js)'] } }, 'denied by settings rule Write(./src/a.js)');
  await refused({ lists: { ask: ['Write(./src/a.js)'] } }, ASK_DENIAL);
  await refused({ pre: { decision: 'ask', reason: 'hook asks' } }, ASK_DENIAL);
  await refused({ permission: 'read-only' }, '--read-only: Write is not allowed');
  const asked = await call(...WRITE, { lists: { allow, ask: ['Write(./src/a.js)'] }, ask: { allow: true } });
  assert.deepEqual([asked.ran, asked.asked], [true, 1]);
  assert.equal((await call(...WRITE, { pre: { decision: 'allow' } })).ran, true);
  assert.equal((await call(...WRITE, { permission: 'yolo' })).ran, true);
  assert.equal((await call(...WRITE, { lists: { allow }, permission: 'yolo' })).ran, true);
});
