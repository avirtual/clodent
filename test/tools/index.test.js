import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../../src/tools/index.js';

const tools = createTools();
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

test('tools come in order with their kinds', () => {
  assert.deepEqual(tools.map((tool) => [tool.name, tool.kind]), [
    ['Read', 'read'],
    ['Write', 'write'],
    ['Edit', 'write'],
    ['Bash', 'exec'],
    ['Grep', 'read'],
    ['Glob', 'read'],
  ]);
});

test('each tool carries a description and an object input_schema with the agreed input names', () => {
  const inputs = {
    Read: ['file_path', 'offset', 'limit'],
    Write: ['file_path', 'content'],
    Edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
    Bash: ['command', 'timeout', 'description'],
    Grep: ['pattern', 'path', 'glob', 'output_mode', 'ignore_case', 'head_limit'],
    Glob: ['pattern', 'path'],
  };
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.input_schema.type, 'object');
    assert.deepEqual(Object.keys(tool.input_schema.properties), inputs[tool.name]);
    for (const name of tool.input_schema.required) assert.ok(inputs[tool.name].includes(name));
  }
});

test('summaries are one line of at most 200 chars', () => {
  assert.equal(byName.Bash.summary({ command: 'echo a\necho b\r\necho c' }), 'echo a⏎echo b⏎echo c');
  assert.equal(byName.Write.summary({ file_path: '/x/y.txt', content: 'z' }), '/x/y.txt');
  assert.equal(byName.Edit.summary({ file_path: 'y.txt' }), 'y.txt');
  assert.equal(byName.Read.summary({ file_path: 'r.txt' }), 'r.txt');
  assert.equal(byName.Grep.summary({ pattern: 'fo+' }), 'fo+');
  assert.equal(byName.Glob.summary({ pattern: '**/*.js' }), '**/*.js');
  const long = byName.Bash.summary({ command: `${'x\n'.repeat(300)}😀` });
  assert.equal(Array.from(long).length, 200);
  assert.ok(long.endsWith('…'));
  assert.ok(!/[\r\n]/.test(long));
  assert.equal(byName.Read.summary(undefined), '');
});

test('an unexpected failure inside run resolves as an error instead of throwing', async () => {
  const result = await byName.Read.run({ file_path: 'x' }, {});
  assert.equal(result.isError, true);
  assert.match(result.content, /^Read failed: /);
  assert.deepEqual(await byName.Glob.run(null, {}), { content: 'input must be an object', isError: true });
});
