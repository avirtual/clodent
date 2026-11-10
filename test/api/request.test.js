import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRequest, API_URL, DEFAULT_MAX_TOKENS } from '../../src/api/request.js';

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;
const deps = { env: { ANTHROPIC_API_KEY: 'sk-test-key' } };

const TOOLS = [
  { name: 'Read', description: 'Read a file.', input_schema: { type: 'object', properties: {} } },
  { name: 'Bash', description: 'Run a command.', input_schema: { type: 'object', properties: {} } },
];

function base(overrides = {}) {
  return {
    model: 'claude-opus-5-5',
    system: 'You are clodent.',
    tools: TOOLS,
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

function cachePaths(value, path = '$', out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => cachePaths(item, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'cache_control') {
        assert.deepEqual(child, { type: 'ephemeral' });
        out.push(path);
      } else {
        cachePaths(child, `${path}.${key}`, out);
      }
    }
  }
  return out;
}

test('url is the Messages API endpoint', () => {
  assert.equal(buildRequest(base(), deps).url, 'https://api.anthropic.com/v1/messages');
  assert.equal(API_URL, 'https://api.anthropic.com/v1/messages');
});

test('baseUrl replaces the origin, trailing slashes dropped, and leaves the headers alone', () => {
  const plain = buildRequest(base(), deps);
  for (const [baseUrl, url] of [['http://127.0.0.1:8787', 'http://127.0.0.1:8787/v1/messages'], ['https://proxy.example/seat/x//', 'https://proxy.example/seat/x/v1/messages']]) {
    const req = buildRequest({ ...base(), baseUrl }, deps);
    assert.equal(req.url, url);
    assert.deepEqual(req.headers, plain.headers);
    assert.deepEqual(req.body, plain.body);
  }
});

test('headers are exactly key, version, content type and clodent user agent', () => {
  const { headers } = buildRequest(base(), deps);
  assert.deepEqual(headers, {
    'x-api-key': 'sk-test-key',
    'anthropic-version': '2026-10-21',
    'content-type': 'application/json',
    'user-agent': `clodent/${PACKAGE_VERSION}`,
  });
});

test('no header name or value carries a Claude Code identifier or a beta flag', () => {
  const { headers } = buildRequest(base(), deps);
  for (const [name, value] of Object.entries(headers)) {
    assert.doesNotMatch(name, /claude-code|claude-cli|anthropic-beta/i);
    assert.doesNotMatch(value, /claude-code|claude-cli/i);
  }
  assert.equal('anthropic-beta' in headers, false);
});

test('missing ANTHROPIC_API_KEY throws', () => {
  assert.throws(() => buildRequest(base(), { env: {} }), /ANTHROPIC_API_KEY is not set/);
});

test('body carries model, default max_tokens, stream, system block, tools, messages and adaptive thinking', () => {
  const { body } = buildRequest(base(), deps);
  assert.deepEqual(Object.keys(body), ['model', 'max_tokens', 'stream', 'system', 'tools', 'messages', 'thinking']);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.max_tokens, DEFAULT_MAX_TOKENS);
  assert.equal(DEFAULT_MAX_TOKENS, 32000);
  assert.equal(body.stream, true);
  assert.deepEqual(body.system, [{ type: 'text', text: 'You are clodent.', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(body.thinking, { type: 'adaptive' });
});

test('maxTokens overrides the default', () => {
  assert.equal(buildRequest(base({ maxTokens: 1024 }), deps).body.max_tokens, 1024);
});

test('an empty tool list omits tools', () => {
  const { body } = buildRequest(base({ tools: [] }), deps);
  assert.equal('tools' in body, false);
  assert.equal('tools' in buildRequest(base({ tools: undefined }), deps).body, false);
});

test('empty or non-string system throws', () => {
  assert.throws(() => buildRequest(base({ system: '' }), deps), /system/);
  assert.throws(() => buildRequest(base({ system: undefined }), deps), /system/);
});

test('effort maps to output_config only when set', () => {
  assert.equal('output_config' in buildRequest(base(), deps).body, false);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(buildRequest(base({ effort }), deps).body.output_config, { effort });
  }
});

test('toolChoice maps to tool_choice only when set', () => {
  assert.equal('tool_choice' in buildRequest(base(), deps).body, false);
  assert.equal('tool_choice' in buildRequest(base({ toolChoice: null }), deps).body, false);
  assert.deepEqual(buildRequest(base({ toolChoice: { type: 'none' } }), deps).body.tool_choice, { type: 'none' });
});

test('sessionId maps to metadata.user_id as a JSON string only when set, and leaves the cache breakpoints alone', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  assert.equal('metadata' in buildRequest(base(), deps).body, false);
  assert.equal('metadata' in buildRequest(base({ sessionId: null }), deps).body, false);
  const plain = buildRequest(base(), deps);
  const req = buildRequest(base({ sessionId: id }), deps);
  assert.deepEqual(req.body.metadata, { user_id: `{"session_id":"${id}"}` });
  const { metadata: _metadata, ...rest } = req.body;
  assert.deepEqual(rest, plain.body);
  assert.deepEqual(req.headers, plain.headers);
});

test('an invalid effort throws', () => {
  for (const effort of ['ultra', 'MAX', 'HIGH', '', 3]) {
    assert.throws(() => buildRequest(base({ effort }), deps), /invalid effort/);
  }
});

test('a first-turn request carries three cache breakpoints: system, last tool, last message block', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }, { type: 'tool_result', tool_use_id: 't2', content: 'b' }] },
  ];
  const { body } = buildRequest(base({ messages }), deps);
  assert.deepEqual(cachePaths(body), ['$.system[0]', '$.tools[1]', '$.messages[2].content[1]']);
});

test('string content of the last message becomes a marked text block', () => {
  const messages = [
    { role: 'user', content: 'zero' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'again' },
  ];
  const { body } = buildRequest(base({ messages }), deps);
  assert.equal(body.messages[0].content, 'zero');
  assert.equal(body.messages[1].content, 'ok');
  assert.equal(body.messages[3].content, 'ok');
  assert.deepEqual(body.messages[4].content, [
    { type: 'text', text: 'again', cache_control: { type: 'ephemeral' } },
  ]);
  assert.deepEqual(cachePaths(body), ['$.system[0]', '$.tools[1]', '$.messages[2].content[0]', '$.messages[4].content[0]']);
});

test('a trailing thinking block is skipped for the nearest other block', () => {
  const messages = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'answer' },
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'redacted_thinking', data: 'opaque' },
      ],
    },
  ];
  const { body } = buildRequest(base({ messages }), deps);
  assert.deepEqual(cachePaths(body), ['$.system[0]', '$.tools[1]', '$.messages[1].content[0]']);
  assert.deepEqual(body.messages[1].content[1], { type: 'thinking', thinking: 'hmm', signature: 'sig' });
});

test('building twice over a growing history keeps three markers and never mutates the caller', () => {
  const tools = structuredClone(TOOLS);
  const messages = [{ role: 'user', content: 'one' }];
  const system = 'You are clodent.';
  const first = buildRequest({ model: 'm', system, tools, messages }, deps);
  assert.equal(cachePaths(first.body).length, 3);
  messages.push(
    { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'three' }] },
  );
  const snapshot = structuredClone({ tools, messages });
  const second = buildRequest({ model: 'm', system, tools, messages }, deps);
  assert.deepEqual(cachePaths(second.body), ['$.system[0]', '$.tools[1]', '$.messages[2].content[0]']);
  assert.deepEqual({ tools, messages }, snapshot);
  assert.deepEqual(cachePaths({ tools, messages }), []);
  assert.equal(messages[0].content, 'one');
});

test('stale cache_control on caller blocks is dropped so the count stays three', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'old', cache_control: { type: 'ephemeral' } }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {}, cache_control: { type: 'ephemeral' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'new' }] },
  ];
  const tools = [{ ...TOOLS[0], cache_control: { type: 'ephemeral' } }, TOOLS[1]];
  const { body } = buildRequest(base({ messages, tools }), deps);
  assert.deepEqual(cachePaths(body), ['$.system[0]', '$.tools[1]', '$.messages[2].content[0]']);
  assert.deepEqual(messages[0].content[0].cache_control, { type: 'ephemeral' });
});

const userText = (text) => ({ role: 'user', content: text });
const toolUse = (id) => ({
  role: 'assistant',
  content: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }, { type: 'tool_use', id, name: 'Read', input: {} }],
});
const toolResult = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'r' }] });
const answer = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const TURN_ONE = [userText('one'), toolUse('t1'), toolResult('t1'), answer('done one')];

function messagePaths(body) {
  return cachePaths(body).filter((path) => path.startsWith('$.messages'));
}

test('turn 1 carries no settled pin: three breakpoints on request 1 and after a tool round', () => {
  const first = buildRequest(base({ messages: [userText('one')] }), deps).body;
  assert.deepEqual(cachePaths(first), ['$.system[0]', '$.tools[1]', '$.messages[0].content[0]']);
  const second = buildRequest(base({ messages: TURN_ONE.slice(0, 3) }), deps).body;
  assert.deepEqual(cachePaths(second), ['$.system[0]', '$.tools[1]', '$.messages[2].content[0]']);
});

test('turn 2 request 1 pins msg 0 as one marked text block and leaves the caller history unchanged', () => {
  const messages = [...structuredClone(TURN_ONE), userText('two')];
  const snapshot = structuredClone(messages);
  const { body } = buildRequest(base({ messages }), deps);
  assert.deepEqual(cachePaths(body), ['$.system[0]', '$.tools[1]', '$.messages[0].content[0]', '$.messages[4].content[0]']);
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'one', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(messages, snapshot);
  assert.equal(messages[0].content, 'one');
});

test('turn 2 request 2 onward pins turn 2 opening user message', () => {
  const messages = [...structuredClone(TURN_ONE), userText('two'), toolUse('t2'), toolResult('t2')];
  const second = buildRequest(base({ messages }), deps).body;
  assert.deepEqual(messagePaths(second), ['$.messages[4].content[0]', '$.messages[6].content[0]']);
  assert.deepEqual(second.messages[4].content, [{ type: 'text', text: 'two', cache_control: { type: 'ephemeral' } }]);
  messages.push(toolUse('t3'), toolResult('t3'));
  const third = buildRequest(base({ messages }), deps).body;
  assert.deepEqual(messagePaths(third), ['$.messages[4].content[0]', '$.messages[8].content[0]']);
  assert.equal(cachePaths(third).length, 4);
});

test('a tool_result-only user message is never the anchor; a tool_result with a text block is a boundary', () => {
  const skipped = buildRequest(base({ messages: [...TURN_ONE.slice(0, 3), toolUse('t2'), toolResult('t2'), answer('x'), userText('two')] }), deps).body;
  assert.deepEqual(messagePaths(skipped), ['$.messages[0].content[0]', '$.messages[6].content[0]']);
  const withText = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }, { type: 'text', text: 'also this' }],
  };
  const opening = buildRequest(base({ messages: [userText('one'), toolUse('t1'), withText] }), deps).body;
  assert.deepEqual(messagePaths(opening), ['$.messages[0].content[0]', '$.messages[2].content[1]']);
  const advanced = buildRequest(base({ messages: [userText('one'), toolUse('t1'), withText, toolUse('t2'), toolResult('t2')] }), deps).body;
  assert.deepEqual(messagePaths(advanced), ['$.messages[2].content[1]', '$.messages[4].content[0]']);
  const blank = buildRequest(base({ messages: [userText('one'), answer('a'), userText('  \n'), toolUse('t2'), toolResult('t2')] }), deps).body;
  assert.deepEqual(messagePaths(blank), ['$.messages[4].content[0]']);
});

test('with no tools the breakpoints are the system block, the settled pin and the tail', () => {
  const { body } = buildRequest(base({ tools: [], messages: [...structuredClone(TURN_ONE), userText('two')] }), deps);
  assert.deepEqual(cachePaths(body), ['$.system[0]', '$.messages[0].content[0]', '$.messages[4].content[0]']);
});

test('a scripted 3-turn session with tool rounds never sends more than four breakpoints', () => {
  const messages = [];
  const pins = [];
  for (const [turn, rounds] of [['one', 1], ['two', 2], ['three', 0]]) {
    messages.push(userText(turn));
    for (let round = 0; round <= rounds; round++) {
      if (round > 0) messages.push(toolUse(`${turn}${round}`), toolResult(`${turn}${round}`));
      const paths = cachePaths(buildRequest(base({ messages }), deps).body);
      assert.ok(paths.length <= 4, `${paths.length} breakpoints at ${messages.length} messages`);
      pins.push(paths.length === 4 ? paths[2] : null);
    }
    messages.push(answer(`done ${turn}`));
  }
  assert.deepEqual(pins, [
    null,
    null,
    '$.messages[0].content[0]',
    '$.messages[4].content[0]',
    '$.messages[4].content[0]',
    '$.messages[4].content[0]',
  ]);
  assert.deepEqual(cachePaths(messages), []);
});

const FIXTURE_5M = readFileSync(new URL('./fixtures/request-5m-body.json', import.meta.url), 'utf8').trimEnd();
const ONE_HOUR = { type: 'ephemeral', ttl: '1h' };

function cacheMarks(value, path = '$', out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => cacheMarks(item, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'cache_control') out.push([path, child]);
      else cacheMarks(child, `${path}.${key}`, out);
    }
  }
  return out;
}

function fixtureInput(tools, cacheTtl) {
  const messages = [...structuredClone(TURN_ONE), userText('two'), toolUse('t2'), toolResult('t2')];
  return base({ tools, messages, effort: 'high', sessionId: '00000000-0000-4000-8000-000000000000', cacheTtl });
}

test('5m mode sends the pre-change request bytes; only the tool order differs, and an unsorted tool list sorts into them', () => {
  const sorted = [TOOLS[1], TOOLS[0]];
  for (const cacheTtl of [undefined, '5m']) {
    assert.equal(JSON.stringify(buildRequest(fixtureInput(sorted, cacheTtl), deps).body), FIXTURE_5M);
    assert.equal(JSON.stringify(buildRequest(fixtureInput(TOOLS, cacheTtl), deps).body), FIXTURE_5M);
  }
});

test('an unknown cacheTtl throws', () => {
  assert.throws(() => buildRequest(base({ cacheTtl: '2h' }), deps), /invalid cacheTtl "2h": expected one of 5m, 1h/);
});

test('1h turn 1: system, last tool and tail carry ttl 1h', () => {
  const { body } = buildRequest(base({ messages: [userText('one')], cacheTtl: '1h' }), deps);
  assert.deepEqual(cacheMarks(body), [
    ['$.system[0]', ONE_HOUR],
    ['$.tools[1]', ONE_HOUR],
    ['$.messages[0].content[0]', ONE_HOUR],
  ]);
});

test('1h turn 2 requests 1 and 2: system, last tool, settled pin and tail carry ttl 1h', () => {
  const messages = [...structuredClone(TURN_ONE), userText('two')];
  assert.deepEqual(cacheMarks(buildRequest(base({ messages, cacheTtl: '1h' }), deps).body), [
    ['$.system[0]', ONE_HOUR],
    ['$.tools[1]', ONE_HOUR],
    ['$.messages[0].content[0]', ONE_HOUR],
    ['$.messages[4].content[0]', ONE_HOUR],
  ]);
  messages.push(toolUse('t2'), toolResult('t2'));
  assert.deepEqual(cacheMarks(buildRequest(base({ messages, cacheTtl: '1h' }), deps).body), [
    ['$.system[0]', ONE_HOUR],
    ['$.tools[1]', ONE_HOUR],
    ['$.messages[4].content[0]', ONE_HOUR],
    ['$.messages[6].content[0]', ONE_HOUR],
  ]);
});

test('1h with no tools: system, settled pin and tail carry ttl 1h', () => {
  const { body } = buildRequest(base({ tools: [], messages: [...structuredClone(TURN_ONE), userText('two')], cacheTtl: '1h' }), deps);
  assert.deepEqual(cacheMarks(body), [
    ['$.system[0]', ONE_HOUR],
    ['$.messages[0].content[0]', ONE_HOUR],
    ['$.messages[4].content[0]', ONE_HOUR],
  ]);
});

test('1h: every marker in every request of a scripted 3-turn session carries ttl 1h', () => {
  const messages = [];
  let requests = 0;
  for (const [turn, rounds] of [['one', 1], ['two', 2], ['three', 0]]) {
    messages.push(userText(turn));
    for (let round = 0; round <= rounds; round++) {
      if (round > 0) messages.push(toolUse(`${turn}${round}`), toolResult(`${turn}${round}`));
      const { body } = buildRequest(base({ messages, cacheTtl: '1h' }), deps);
      const marks = cacheMarks(body).map(([, mark]) => mark);
      const where = `at ${messages.length} messages`;
      assert.ok(marks.length >= 3, where);
      assert.deepEqual(marks, marks.map(() => ONE_HOUR), where);
      requests++;
    }
    messages.push(answer(`done ${turn}`));
  }
  assert.equal(requests, 6);
});

test('tools go out sorted by name in code-unit order with the marker on the last, and the caller list keeps its order', () => {
  const tools = ['Write', 'Bash', 'grep', 'Read', 'Glob'].map((name) => ({ name, description: name, input_schema: { type: 'object' } }));
  const order = tools.map((tool) => tool.name);
  for (const cacheTtl of ['5m', '1h']) {
    const { body } = buildRequest(base({ tools, cacheTtl }), deps);
    assert.deepEqual(body.tools.map((tool) => tool.name), ['Bash', 'Glob', 'Read', 'Write', 'grep']);
    assert.deepEqual(cacheMarks(body.tools).map(([path]) => path), ['$[4]']);
    assert.deepEqual(tools.map((tool) => tool.name), order);
  }
});
