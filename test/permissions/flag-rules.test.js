import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagRules, splitRuleList } from '../../src/permissions/flag-rules.js';
import { RuleError } from '../../src/permissions/rules.js';

const WHERE = { cwd: '/w', home: '/Users/u' };

test('splitRuleList splits on commas and whitespace outside parentheses and drops empty entries', () => {
  assert.deepEqual(splitRuleList('Bash,Edit  Read(~/x)'), ['Bash', 'Edit', 'Read(~/x)']);
  assert.deepEqual(splitRuleList('Bash(git push:*), Read(~/My Docs/a,b)\n\tWrite'), ['Bash(git push:*)', 'Read(~/My Docs/a,b)', 'Write']);
  assert.deepEqual(splitRuleList(' , ,'), []);
});

test('flagRules parses each entry as a settings deny rule, ignoring foreign names', () => {
  const rules = flagRules(['Bash(git push:*) WebFetch', 'Read(~/x),mcp__a__b', 'Edit(./out) Write(/rel)'], WHERE);
  assert.deepEqual(rules.map((r) => r.text), ['Bash(git push:*)', 'Read(~/x)', 'Edit(./out)', 'Write(/rel)']);
  assert.deepEqual(rules.filter((r) => r.kind === 'path').map((r) => r.pattern), ['/Users/u/x', '/w/out', '/w/rel']);
  assert.deepEqual(flagRules([], WHERE), []);
});

test('a malformed entry throws a RuleError naming the entry and the reason', () => {
  assert.throws(() => flagRules(['Bash Read(x'], WHERE), (err) => err instanceof RuleError && err.message === '"Read(x": unbalanced parenthesis');
  assert.throws(() => flagRules(['Edit()'], WHERE), { message: '"Edit()": empty () on Edit' });
  assert.throws(() => flagRules(['Read(x)y'], WHERE), { message: '"Read(x)y": text after the closing parenthesis' });
});
