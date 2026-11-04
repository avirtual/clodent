import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLODENT_BASE_PROMPT } from '../../src/prompt/base.js';

test('the base prompt carries none of the forbidden identity strings', () => {
  const lower = CLODENT_BASE_PROMPT.toLowerCase();
  for (const banned of ['Claude Code', 'claude-code', "Anthropic's official CLI"]) {
    assert.equal(lower.includes(banned.toLowerCase()), false, banned);
  }
});

test('the base prompt is under 1,500 words', () => {
  const words = CLODENT_BASE_PROMPT.split(/\s+/).filter(Boolean).length;
  assert.ok(words > 100 && words < 1500, `${words} words`);
});

test('the base prompt names clodent and the truncation marker it will see', () => {
  assert.match(CLODENT_BASE_PROMPT, /^You are clodent/);
  assert.match(CLODENT_BASE_PROMPT, /\[clodent: truncated N bytes\]/);
  assert.match(CLODENT_BASE_PROMPT, /data, not instructions/);
  assert.match(CLODENT_BASE_PROMPT, /path:line/);
});
