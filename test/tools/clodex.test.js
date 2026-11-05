import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  BAD_REPLY,
  COMPLETION_UNKNOWN,
  INTERRUPTED,
  LOOP_WINDOW_MS,
  createClodexTools,
  createClodexToolset,
  readClodexCatalog,
} from '../../src/tools/clodex.js';
import { hookGroup, readJsonl, runMain, textReply, toolsReply, writeSettings } from '../helpers/run-main.js';
import { script } from '../hooks/scripts.js';
import { useTempDir } from './tmp-dir.js';

const GUARD = { timeout: 10000 };
const CRED = 'c0ffee'.repeat(8);
const BUILTINS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'];
const WIRE_BUILTINS = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'];
const SCHEMA = { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] };
const DM = { name: 'dm', description: 'Send a dm.', inputSchema: SCHEMA, logKeys: ['to'] };
const EXEC = { name: 'exec', description: 'Run an exec.', inputSchema: { type: 'object', properties: { command: { type: 'string' } } }, logKeys: ['command'] };
const OK = { ok: true, status: 'ok', reply: 'sent' };
const REFUSED = { ok: false, status: 'refused', error: 'refused: not granted' };

const catalog = (tools, rev = 'r1') => ({ v: 1, rev, tools, briefs: ['a subagent brief'] });

function seatEnv(dir) {
  return { CLODEX_INTENT_SOCK: join(dir, 'intent.sock'), CLODEX_INTENT_CRED: CRED };
}

function writeCatalog(dir, content) {
  writeFileSync(join(dir, 'mcp-tools.json'), typeof content === 'string' ? content : JSON.stringify(content));
}

async function seat(t, dir, replies = []) {
  const env = seatEnv(dir);
  const lines = [];
  const queue = [...replies];
  const server = createServer((conn) => {
    let buf = '';
    conn.on('data', (data) => {
      if (buf === null) return;
      buf += data;
      const end = buf.indexOf('\n');
      if (end === -1) return;
      lines.push(buf.slice(0, end));
      buf = null;
      const next = queue.shift() ?? OK;
      if (typeof next === 'function') next(conn);
      else conn.end(typeof next === 'string' ? next : `${JSON.stringify(next)}\n`);
    });
    conn.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(env.CLODEX_INTENT_SOCK, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { env, lines, payloads: () => lines.map((line) => JSON.parse(line)) };
}

function dmTool(env, deps = {}) {
  const [tool] = createClodexTools({ tools: [{ name: 'mcp__clodex__dm', tool: 'dm', description: 'Send a dm.', inputSchema: SCHEMA }] }, { env, ...deps });
  return tool;
}

const run = (tool, input, ctx = {}) => tool.run(input, { cwd: '/', env: {}, ...ctx });

test('without both CLODEX_INTENT_SOCK and CLODEX_INTENT_CRED there is no catalog read, no tool and no warning', async (t) => {
  const dir = await useTempDir(t);
  writeCatalog(dir, catalog([DM]));
  const fs = { readFileSync: () => assert.fail('the catalog must not be read') };
  const { CLODEX_INTENT_SOCK, CLODEX_INTENT_CRED } = seatEnv(dir);
  for (const env of [{}, { CLODEX_INTENT_SOCK }, { CLODEX_INTENT_CRED }, { CLODEX_INTENT_SOCK, CLODEX_INTENT_CRED: '' }]) {
    assert.deepEqual(readClodexCatalog(env, { fs }), { tools: [], warnings: [], rev: null });
  }
});

test('an absent, empty or malformed catalog is no tools and no warning', async (t) => {
  const dir = await useTempDir(t);
  const env = seatEnv(dir);
  assert.deepEqual(readClodexCatalog(env), { tools: [], warnings: [], rev: null });
  for (const content of ['', '{"v":1,', 'null', '[]', '"v"']) {
    writeCatalog(dir, content);
    assert.deepEqual(readClodexCatalog(env), { tools: [], warnings: [], rev: null }, content);
  }
  writeCatalog(dir, { v: 1, rev: 'r9', tools: 'dm' });
  assert.deepEqual(readClodexCatalog(env), { tools: [], warnings: [], rev: 'r9' });
  writeCatalog(dir, catalog([]));
  assert.deepEqual(readClodexCatalog(env), { tools: [], warnings: [], rev: 'r1' });
});

test('a catalog whose v is not 1 is no tools and one warning', async (t) => {
  const dir = await useTempDir(t);
  const env = seatEnv(dir);
  const file = join(dir, 'mcp-tools.json');
  writeCatalog(dir, { ...catalog([DM]), v: 2 });
  assert.deepEqual(readClodexCatalog(env), { tools: [], warnings: [`Clodex tool catalog ${file}: version 2 is not supported; no Clodex tools`], rev: 'r1' });
  writeCatalog(dir, { rev: 'r1', tools: [DM] });
  assert.deepEqual(readClodexCatalog(env).warnings, [`Clodex tool catalog ${file}: version missing is not supported; no Clodex tools`]);
});

test('rows are prefixed mcp__clodex__ in catalog order; bad names and schemas are dropped; briefs and logKeys are ignored', async (t) => {
  const dir = await useTempDir(t);
  const rows = [
    EXEC,
    { name: 'bad name', inputSchema: {} },
    { name: '', inputSchema: {} },
    { name: 'x'.repeat(52), inputSchema: {} },
    { name: 7, inputSchema: {} },
    { name: 'noschema' },
    { name: 'arrayschema', inputSchema: [] },
    { name: 'nullschema', inputSchema: null },
    'dm',
    null,
    { ...DM, description: 42 },
    { name: `Up-${'y'.repeat(48)}`, description: 'longest', inputSchema: {} },
  ];
  writeCatalog(dir, catalog(rows));
  const read = readClodexCatalog(seatEnv(dir), { builtins: BUILTINS });
  assert.deepEqual(read, {
    tools: [
      { name: 'mcp__clodex__exec', tool: 'exec', description: 'Run an exec.', inputSchema: EXEC.inputSchema },
      { name: 'mcp__clodex__dm', tool: 'dm', description: '', inputSchema: SCHEMA },
      { name: `mcp__clodex__Up-${'y'.repeat(48)}`, tool: `Up-${'y'.repeat(48)}`, description: 'longest', inputSchema: {} },
    ],
    warnings: [],
    rev: 'r1',
  });
  const tools = createClodexTools(read, { env: seatEnv(dir) });
  assert.deepEqual(
    tools.map(({ name, kind, description, input_schema }) => ({ name, kind, description, input_schema })),
    read.tools.map(({ name, description, inputSchema }) => ({ name, kind: 'read', description, input_schema: inputSchema })),
  );
});

test('a row whose prefixed name is already a tool is skipped with a warning; the earlier tool wins', async (t) => {
  const dir = await useTempDir(t);
  const file = join(dir, 'mcp-tools.json');
  writeCatalog(dir, catalog([DM, { ...DM, description: 'second' }, EXEC]));
  const read = readClodexCatalog(seatEnv(dir), { builtins: [...BUILTINS, 'mcp__clodex__exec'] });
  assert.deepEqual(read.tools.map((tool) => [tool.name, tool.description]), [['mcp__clodex__dm', 'Send a dm.']]);
  assert.deepEqual(read.warnings, [
    `Clodex tool catalog ${file}: skipped "dm": a tool named mcp__clodex__dm already exists`,
    `Clodex tool catalog ${file}: skipped "exec": a tool named mcp__clodex__exec already exists`,
  ]);
});

test('a call writes one line {cred, tool, args} with the bare name; ident is lifted out of args only when it is a non-empty string', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const s = await seat(t, dir);
  const tool = dmTool(s.env);
  for (const ident of [undefined, '', 7]) {
    const input = ident === undefined ? { to: 'lead', body: 'hi' } : { to: 'lead', body: 'hi', ident };
    assert.deepEqual(await run(tool, input), { content: 'sent', isError: false });
  }
  await run(tool, { body: 'hi', to: 'lead', ident: 'main.0123' });
  const plain = `{"cred":"${CRED}","tool":"dm","args":{"to":"lead","body":"hi"}}`;
  assert.deepEqual(s.lines, [plain, plain, plain, `{"cred":"${CRED}","tool":"dm","args":{"body":"hi","to":"lead"},"ident":"main.0123"}`]);
});

test('each reply maps to plain text and never to isError', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const s = await seat(t, dir, [
    OK,
    { ok: true, status: 'ok' },
    { ok: false, status: 'invalid', error: 'body is required' },
    REFUSED,
    { ok: false, status: 'error' },
    'not json\n',
    '42\n',
    JSON.stringify({ ok: true, status: 'ok', reply: 'no newline' }),
    (conn) => conn.write(`${JSON.stringify({ ok: true, status: 'ok', reply: 'line kept open' })}\n`),
  ]);
  const tool = dmTool(s.env);
  const texts = [];
  for (let i = 0; i < 9; i += 1) {
    const result = await run(tool, { to: 'lead', body: `m${i}` });
    assert.equal(result.isError, false);
    texts.push(result.content);
  }
  assert.deepEqual(texts, ['sent', '', 'invalid: body is required', 'refused: not granted', 'failed', BAD_REPLY, BAD_REPLY, 'no newline', 'line kept open']);
});

test('no socket is "no seat channel: <message>", not an error', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const result = await run(dmTool(seatEnv(dir)), { to: 'lead', body: 'hi' });
  assert.equal(result.isError, false);
  assert.match(result.content, /^no seat channel: connect ENOENT .*intent\.sock$/);
});

test('a seat that does not answer in time is "completion unknown", not an error', GUARD, async (t) => {
  const dir = await useTempDir(t);
  let fire = null;
  const waits = [];
  const s = await seat(t, dir, [() => fire()]);
  const timers = {
    setTimeout: (fn, ms) => {
      fire = fn;
      waits.push(ms);
      return 1;
    },
    clearTimeout: () => {},
  };
  const result = await run(dmTool(s.env, timers), { to: 'lead', body: 'hi' });
  assert.deepEqual(waits, [500000]);
  assert.deepEqual(result, {
    content: `${COMPLETION_UNKNOWN}: the seat did not answer within 500 s; the action may still have run — read the page before repeating it`,
    isError: false,
  });
});

test('a reply over 32 KiB is capped like every tool result', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const s = await seat(t, dir, [{ ok: true, status: 'ok', reply: 'z'.repeat(40000) }]);
  const result = await run(dmTool(s.env), { to: 'lead', body: 'hi' });
  assert.equal(result.isError, false);
  assert.match(result.content, /\[clodent: truncated 7232 bytes\]/);
});

test('two failures make an identical third call return the loop text without sending it', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const s = await seat(t, dir, [REFUSED, REFUSED, OK]);
  const tool = dmTool(s.env, { now: () => 0 });
  await run(tool, { to: 'lead', body: 'hi', ident: 'main.1' });
  await run(tool, { body: 'hi', to: 'lead', ident: 'main.2' });
  const third = await run(tool, { to: 'lead', body: 'hi', ident: 'main.3' });
  assert.deepEqual(third, { content: 'the same call failed 3 times — stop retrying: refused: not granted', isError: false });
  assert.equal(s.lines.length, 2);
  assert.deepEqual(await run(tool, { to: 'other', body: 'hi' }), { content: 'sent', isError: false });
});

test('a success clears the loop key, and failures over 60 s apart do not add up', GUARD, async (t) => {
  const dir = await useTempDir(t);
  let clock = 0;
  const s = await seat(t, dir, [REFUSED, OK, REFUSED, REFUSED, REFUSED, REFUSED]);
  const tool = dmTool(s.env, { now: () => clock });
  const call = () => run(tool, { to: 'lead', body: 'hi' });
  await call();
  await call();
  await call();
  await call();
  clock = LOOP_WINDOW_MS;
  await call();
  await call();
  assert.equal(s.lines.length, 6);
});

test('invalid replies and timeouts do not count toward the loop breaker', GUARD, async (t) => {
  const dir = await useTempDir(t);
  let fire = null;
  const timers = {
    setTimeout: (fn) => {
      fire = fn;
      return 1;
    },
    clearTimeout: () => {},
  };
  const invalid = { ok: false, status: 'invalid', error: 'bad' };
  const s = await seat(t, dir, [invalid, invalid, invalid, () => fire(), () => fire(), () => fire()]);
  const tool = dmTool(s.env, { now: () => 0, ...timers });
  for (let i = 0; i < 6; i += 1) assert.doesNotMatch((await run(tool, { to: 'lead', body: 'hi' })).content, /stop retrying/);
  assert.equal(s.lines.length, 6);
});

test('an abort through ctx.signal closes the socket and is the interrupted result', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const controller = new AbortController();
  let closed;
  const sawClose = new Promise((resolve) => {
    closed = resolve;
  });
  const s = await seat(t, dir, [
    (conn) => {
      conn.on('close', closed);
      controller.abort();
    },
    OK,
  ]);
  const tool = dmTool(s.env, { now: () => 0 });
  const result = await run(tool, { to: 'lead', body: 'hi' }, { signal: controller.signal });
  await sawClose;
  assert.deepEqual(result, { content: INTERRUPTED, isError: true });
  assert.deepEqual(await run(tool, { to: 'lead', body: 'hi' }, { signal: AbortSignal.abort() }), { content: INTERRUPTED, isError: true });
  assert.equal(s.lines.length, 1);
});

test('the summary is the first string argument on one line, never ident', () => {
  const tool = dmTool({});
  assert.equal(tool.summary({ ident: 'main.1', n: 3, to: 'lead\nteam', body: 'hi' }), 'lead⏎team');
  assert.equal(tool.summary({ n: 3 }), '');
  assert.equal(tool.summary(null), '');
});

test('the toolset rebuilds only when rev changes and applies the removes filter', async (t) => {
  const dir = await useTempDir(t);
  const env = seatEnv(dir);
  const toolset = createClodexToolset(env, { builtins: BUILTINS, removes: (name) => name === 'mcp__clodex__exec' });
  const names = (r) => r.tools.map((tool) => tool.name);
  const first = toolset.refresh();
  assert.deepEqual([names(first), first.changed], [[], true]);
  writeCatalog(dir, catalog([DM, EXEC]));
  const second = toolset.refresh();
  assert.deepEqual([names(second), second.changed], [['mcp__clodex__dm'], true]);
  writeCatalog(dir, catalog([EXEC, DM]));
  const same = toolset.refresh();
  assert.deepEqual([same.changed, same.warnings], [false, []]);
  assert.equal(same.tools, second.tools);
  writeCatalog(dir, { ...catalog([DM], 'r2'), v: 3 });
  const unsupported = toolset.refresh();
  assert.deepEqual([names(unsupported), unsupported.warnings.length], [[], 1]);
  assert.deepEqual(toolset.refresh().warnings, []);
});

async function e2e(t, { settings = {}, args = [], uses, replies, onFetch, rows = [DM, EXEC] }) {
  const home = await useTempDir(t);
  const cwd = await useTempDir(t);
  const dir = await useTempDir(t);
  writeCatalog(dir, catalog(rows));
  const s = await seat(t, dir, replies);
  const file = writeSettings(dir, settings, 'clodent-settings.json');
  const responses = [...uses.map((list) => toolsReply(list)), textReply('done')];
  const res = await runMain(['-p', 'go', '--settings', file, ...args], { home, cwd, env: s.env, responses, onFetch: (info) => onFetch?.(info, dir) });
  return { ...res, seat: s, dir };
}

const toolNames = (call) => call.body.tools.map((tool) => tool.name);
const resultsOf = (call) => call.body.messages.at(-1).content.filter((block) => block.type === 'tool_result');

test('through the loop, a PreToolUse updatedInput ident replaces the model one and is sent top-level; the hook sees the fields a built-in gets', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const log = join(dir, 'pre.jsonl');
  const body = `${JSON.stringify(process.execPath)} -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{require("fs").appendFileSync(${JSON.stringify(log)},s.trim()+"\\n");const i=JSON.parse(s);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",updatedInput:{...i.tool_input,ident:"main.hook"}}}))})'`;
  const ident = await script(dir, 'ident.sh', body);
  const res = await e2e(t, {
    settings: { hooks: { PreToolUse: [hookGroup('mcp__clodex__dm|mcp__clodex__exec', ident)] } },
    uses: [[['mcp__clodex__dm', { to: 'lead', body: 'hi', ident: 'model.made' }]]],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.seat.payloads(), [{ cred: CRED, tool: 'dm', args: { to: 'lead', body: 'hi' }, ident: 'main.hook' }]);
  assert.deepEqual(resultsOf(res.calls[1]).map((block) => [block.content, block.is_error]), [['sent', false]]);
  const [input] = readJsonl(log);
  assert.deepEqual(Object.keys(input).sort(), ['cwd', 'hook_event_name', 'permission_mode', 'session_id', 'tool_input', 'tool_name', 'tool_use_id', 'transcript_path']);
  assert.deepEqual([input.tool_name, input.tool_use_id, input.session_id, input.permission_mode], ['mcp__clodex__dm', 'toolu_1', res.id, 'default']);
  assert.deepEqual(input.tool_input, { to: 'lead', body: 'hi', ident: 'model.made' });
});

test('without a hook, a model-supplied ident is lifted and sent as the model wrote it', GUARD, async (t) => {
  const res = await e2e(t, { uses: [[['mcp__clodex__exec', { command: 'status', ident: 'model.made' }]]] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.seat.payloads(), [{ cred: CRED, tool: 'exec', args: { command: 'status' }, ident: 'model.made' }]);
});

test('Clodex tools run without an ask in --read-only too', GUARD, async (t) => {
  const res = await e2e(t, { args: ['--read-only'], uses: [[['mcp__clodex__dm', { to: 'lead', body: 'hi' }]]] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.seat.lines.length, 1);
  assert.doesNotMatch(res.stderr, /clodent:permit/);
});

test('a bare mcp__clodex__dm deny rule removes the tool from every request; a call to it is not sent', GUARD, async (t) => {
  const res = await e2e(t, { settings: { permissions: { deny: ['mcp__clodex__dm'] } }, uses: [[['mcp__clodex__dm', { to: 'lead', body: 'hi' }]]] });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(toolNames(res.calls[0]), [...WIRE_BUILTINS, 'mcp__clodex__exec']);
  assert.deepEqual(toolNames(res.calls[1]), [...WIRE_BUILTINS, 'mcp__clodex__exec']);
  assert.deepEqual(res.seat.lines, []);
});

test('a rev change between requests adds and removes tools, built-ins first; a removed tool still goes to the socket', GUARD, async (t) => {
  const res = await e2e(t, {
    rows: [DM],
    uses: [[['mcp__clodex__dm', { to: 'lead', body: 'one' }]], [['mcp__clodex__dm', { to: 'lead', body: 'two' }]]],
    onFetch: ({ calls }, dir) => {
      if (calls === 0) writeCatalog(dir, catalog([EXEC], 'r2'));
    },
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.calls.map(toolNames), [
    [...WIRE_BUILTINS, 'mcp__clodex__dm'],
    [...WIRE_BUILTINS, 'mcp__clodex__exec'],
    [...WIRE_BUILTINS, 'mcp__clodex__exec'],
  ]);
  assert.deepEqual(res.calls[0].body.tools.at(-1).cache_control, { type: 'ephemeral' });
  assert.deepEqual(res.seat.payloads().map((payload) => payload.args.body), ['one', 'two']);
});

test('CLODEX_INTENT_CRED reaches the Bash tool and hooks, but not the statusLine command', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const hookOut = join(dir, 'hook.txt');
  const statusOut = join(dir, 'status.txt');
  const hook = await script(dir, 'hook.sh', `printf %s "\${CLODEX_INTENT_CRED-unset}" > ${JSON.stringify(hookOut)}`);
  const status = await script(dir, 'status.sh', `printf %s "\${CLODEX_INTENT_CRED-unset}" > ${JSON.stringify(statusOut)}`);
  const res = await e2e(t, {
    args: ['--yolo'],
    settings: { hooks: { PreToolUse: [hookGroup('Bash', hook)] }, statusLine: { type: 'command', command: status } },
    uses: [[['Bash', { command: 'printf %s "${CLODEX_INTENT_CRED-unset}"' }]]],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(resultsOf(res.calls[1])[0].content, `${CRED}\n[exit 0]`);
  assert.equal(readFileSync(hookOut, 'utf8'), CRED);
  assert.equal(readFileSync(statusOut, 'utf8'), 'unset');
});
