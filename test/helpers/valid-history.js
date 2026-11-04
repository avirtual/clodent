import assert from 'node:assert/strict';

export function assertValidHistory(messages) {
  assert.equal(messages[0].role, 'user');
  for (let i = 0; i < messages.length; i++) {
    assert.equal(messages[i].role, i % 2 === 0 ? 'user' : 'assistant', `message ${i} role`);
    assert.ok(messages[i].content.length > 0, `message ${i} is empty`);
    if (messages[i].role !== 'assistant') continue;
    const ids = messages[i].content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (ids.length === 0) continue;
    const next = messages[i + 1]?.content ?? [];
    const results = next.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
    assert.deepEqual(results, ids, `tool_use ids of message ${i} have results in order`);
    assert.deepEqual(next.slice(0, ids.length).map((b) => b.type), ids.map(() => 'tool_result'));
  }
}
