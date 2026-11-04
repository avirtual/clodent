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
    system: 'You are clay.',
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

test('headers are exactly key, version, content type and clay user agent', () => {
  const { headers } = buildRequest(base(), deps);
  assert.deepEqual(headers, {
    'x-api-key': 'sk-test-key',
    'anthropic-version': '2026-10-21',
    'content-type': 'application/json',
    'user-agent': `clay/${PACKAGE_VERSION}`,
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
  assert.deepEqual(body.system, [{ type: 'text', text: 'You are clay.', cache_control: { type: 'ephemeral' } }]);
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
  for (const effort of ['low', 'medium', 'high']) {
    assert.deepEqual(buildRequest(base({ effort }), deps).body.output_config, { effort });
  }
});

test('toolChoice maps to tool_choice only when set', () => {
  assert.equal('tool_choice' in buildRequest(base(), deps).body, false);
  assert.equal('tool_choice' in buildRequest(base({ toolChoice: null }), deps).body, false);
  assert.deepEqual(buildRequest(base({ toolChoice: { type: 'none' } }), deps).body.tool_choice, { type: 'none' });
});

test('an invalid effort throws', () => {
  for (const effort of ['max', 'HIGH', '', 3]) {
    assert.throws(() => buildRequest(base({ effort }), deps), /invalid effort/);
  }
});

test('exactly three cache breakpoints: system, last tool, last message block', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
  ];
  const { body } = buildRequest(base({ messages }), deps);
  assert.deepEqual(cachePaths(body), ['$.system[0]', '$.tools[1]', '$.messages[2].content[1]']);
});

test('string content of the last message becomes a marked text block', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'again' },
  ];
  const { body } = buildRequest(base({ messages }), deps);
  assert.equal(body.messages[0].content, 'first');
  assert.equal(body.messages[1].content, 'ok');
  assert.deepEqual(body.messages[2].content, [
    { type: 'text', text: 'again', cache_control: { type: 'ephemeral' } },
  ]);
  assert.equal(cachePaths(body).length, 3);
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
  const system = 'You are clay.';
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
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    { role: 'user', content: 'new' },
  ];
  const tools = [{ ...TOOLS[0], cache_control: { type: 'ephemeral' } }, TOOLS[1]];
  const { body } = buildRequest(base({ messages, tools }), deps);
  assert.deepEqual(cachePaths(body), ['$.system[0]', '$.tools[1]', '$.messages[2].content[0]']);
  assert.deepEqual(messages[0].content[0].cache_control, { type: 'ephemeral' });
});
