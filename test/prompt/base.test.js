import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basePrompt, CLODENT_BASE_PROMPT } from '../../src/prompt/base.js';

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

const ALL = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'];
const without = (...names) => ALL.filter((name) => !names.includes(name));
const bullets = (prompt) => prompt.split('\n').filter((line) => /^- (Reach for|Use the file tools|Use Bash|To change|To create)/.test(line));

test('the tool bullets keep their wording with all six tools and name only the tools that are sent', () => {
  assert.deepEqual(bullets(CLODENT_BASE_PROMPT), [
    '- To change an existing file, use Edit. Use Write for a new file, or when the user asked for a file to be replaced wholesale.',
    '- Reach for the file tools first: Read to view a file, Grep to search contents, Glob to find files by name, Edit and Write to change files. Use Bash to run programs such as tests, builds, git and package managers, not to read or edit files.',
  ]);
  assert.deepEqual(bullets(basePrompt(without('Bash'))).at(-1), '- Use the file tools: Read to view a file, Grep to search contents, Glob to find files by name, Edit and Write to change files.');
  assert.deepEqual(
    bullets(basePrompt(without('Grep'))).at(-1),
    '- Reach for the file tools first: Read to view a file, Glob to find files by name, Edit and Write to change files. Use Bash to run programs such as tests, builds, git and package managers, not to read or edit files.',
  );
  assert.deepEqual(bullets(basePrompt(['Bash', 'Edit'])), [
    '- To change an existing file, use Edit.',
    '- Reach for the file tools first: Edit to change files. Use Bash to run programs such as tests, builds, git and package managers, not to edit files.',
  ]);
  assert.deepEqual(bullets(basePrompt(['Write', 'Read'])), [
    '- To create a file or change one, use Write, which writes the whole file.',
    '- Use the file tools: Read to view a file, Write to change files.',
  ]);
  assert.deepEqual(bullets(basePrompt(['Bash'])), ['- Use Bash to run programs such as tests, builds, git and package managers.']);
  assert.deepEqual(bullets(basePrompt([])), []);
  assert.match(CLODENT_BASE_PROMPT, /^- Shell commands run without a terminal attached/m);
  assert.doesNotMatch(basePrompt(without('Bash')), /Shell commands/);
  for (const removed of ALL) {
    const prompt = basePrompt(without(removed)).replace('Read a file before you edit it', '');
    assert.doesNotMatch(prompt, new RegExp(`\\b${removed}\\b`), removed);
  }
});

const opening = (prompt) => prompt.split('\n')[0];

test('the opening sentence claims only what the sent tools can do', () => {
  assert.match(opening(CLODENT_BASE_PROMPT), /your tools: you read and search files, edit and create them, and run shell commands\. Your replies/);
  const noRead = opening(basePrompt(without('Read')));
  assert.match(noRead, /your tools: you search files, edit and create them, and run shell commands\. Your replies/);
  assert.doesNotMatch(noRead, /read (and search )?files/);
  assert.match(opening(basePrompt(without('Bash'))), /your tools: you read and search files, and edit and create them\. Your replies/);
  assert.match(opening(basePrompt(without('Edit', 'Write'))), /your tools: you read and search files, and run shell commands\. Your replies/);
  assert.match(opening(basePrompt(['Bash'])), /your tools: you run shell commands\. Your replies/);
  assert.match(opening(basePrompt([])), /your tools\. Your replies/);
});
