import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAY_BASE_PROMPT } from '../../src/prompt/base.js';
import { buildSystemPrompt } from '../../src/prompt/system.js';
import { DIR, fakeFs } from './fake-fs.js';

function deps(entries, now = new Date(2026, 10, 4, 23, 59, 30)) {
  return { ...fakeFs(entries), env: {}, platform: 'darwin', clock: () => now };
}

function input(extra = {}) {
  return { cwd: '/repo/pkg', model: 'claude-opus-5-5', addDirs: [], appendSystemPrompt: [], appendSystemPromptFile: [], ...extra };
}

const ENV = [
  '# Environment',
  'Working directory: /repo/pkg',
  'Git repository: yes, root /repo',
  'Platform: darwin',
  'Date: 2026-11-04',
  'Model: claude-opus-5-5',
].join('\n');

test('parts run base, environment, AGENTS.md, then appends, separated by blank lines', () => {
  const d = deps({
    '/repo/.git': DIR,
    '/repo/AGENTS.md': 'root rules\n',
    '/repo/pkg/AGENTS.md': 'pkg rules',
    '/repo/pkg/extra.md': 'from a file\n',
  });
  const out = buildSystemPrompt(input({ appendSystemPrompt: ['appended text'], appendSystemPromptFile: ['extra.md'] }), d);
  assert.equal(
    out,
    [
      CLAY_BASE_PROMPT,
      ENV,
      '# Instructions (AGENTS.md)',
      '## /repo/AGENTS.md\n\nroot rules',
      '## /repo/pkg/AGENTS.md\n\npkg rules',
      'appended text',
      'from a file',
    ].join('\n\n'),
  );
});

test('with no AGENTS.md and no appends the prompt is base plus environment', () => {
  const out = buildSystemPrompt(input(), deps({ '/repo/.git': DIR }));
  assert.equal(out, `${CLAY_BASE_PROMPT}\n\n${ENV}`);
});

test('outside a git repository the environment says so', () => {
  const out = buildSystemPrompt(input(), deps({}));
  assert.match(out, /\nGit repository: no\n/);
});

test('--system-prompt beats --system-prompt-file, which beats the base prompt', () => {
  const d = deps({ '/repo/.git': DIR, '/repo/pkg/sys.md': 'from file' });
  assert.ok(buildSystemPrompt(input(), d).startsWith(`${CLAY_BASE_PROMPT}\n\n# Environment`));
  assert.ok(buildSystemPrompt(input({ systemPromptFile: 'sys.md' }), d).startsWith('from file\n\n# Environment'));
  assert.ok(buildSystemPrompt(input({ systemPromptFile: '/repo/pkg/sys.md' }), d).startsWith('from file\n\n# Environment'));
  const both = buildSystemPrompt(input({ systemPrompt: 'inline', systemPromptFile: 'sys.md' }), d);
  assert.ok(both.startsWith('inline\n\n# Environment'));
  assert.ok(!both.includes(CLAY_BASE_PROMPT));
});

test('multiple appends keep argv order, texts before files', () => {
  const d = deps({ '/repo/.git': DIR, '/repo/pkg/one.md': 'file one', '/abs/two.md': 'file two' });
  const out = buildSystemPrompt(
    input({ appendSystemPrompt: ['text one', 'text two'], appendSystemPromptFile: ['one.md', '/abs/two.md'] }),
    d,
  );
  assert.ok(out.endsWith(`${ENV}\n\ntext one\n\ntext two\n\nfile one\n\nfile two`), out.slice(-200));
});

test('the date is the local calendar day with no time', () => {
  for (const [when, day] of [
    [new Date(2026, 0, 2, 0, 0, 1), '2026-01-02'],
    [new Date(2026, 11, 31, 23, 59, 59), '2026-12-31'],
  ]) {
    const out = buildSystemPrompt(input(), deps({}, when));
    const line = out.split('\n').find((l) => l.startsWith('Date: '));
    assert.equal(line, `Date: ${day}`);
    assert.doesNotMatch(out, /\d{2}:\d{2}/);
  }
});

test('the date uses the local getters even where the UTC day differs', () => {
  const local = { getFullYear: () => 2026, getMonth: () => 10, getDate: () => 4 };
  const utc = { getUTCFullYear: () => 2026, getUTCMonth: () => 10, getUTCDate: () => 5, getUTCDay: () => 4 };
  const when = { ...local, ...utc, toISOString: () => '2026-11-05T01:00:00.000Z', toJSON: () => '2026-11-05T01:00:00.000Z' };
  const out = buildSystemPrompt(input(), deps({}, when));
  assert.equal(out.split('\n').find((l) => l.startsWith('Date: ')), 'Date: 2026-11-04');
});

test('additional directories are listed one per line, resolved against cwd', () => {
  const out = buildSystemPrompt(input({ addDirs: ['/msgs', '../shared'] }), deps({ '/repo/.git': DIR }));
  assert.ok(out.endsWith(`${ENV}\nAdditional directories:\n/msgs\n/repo/shared`), out.slice(-200));
});

test('a missing --system-prompt-file throws an error naming the resolved path', () => {
  assert.throws(
    () => buildSystemPrompt(input({ systemPromptFile: 'nope.md' }), deps({})),
    { message: 'cannot read --system-prompt-file /repo/pkg/nope.md: ENOENT' },
  );
});

test('a missing --append-system-prompt-file throws an error naming the resolved path', () => {
  assert.throws(
    () => buildSystemPrompt(input({ appendSystemPromptFile: ['/etc/gone.md'] }), deps({})),
    { message: 'cannot read --append-system-prompt-file /etc/gone.md: ENOENT' },
  );
});

test('an unreadable prompt file throws an error naming the path', () => {
  const d = deps({ '/repo/pkg/dir.md': DIR });
  assert.throws(() => buildSystemPrompt(input({ systemPromptFile: 'dir.md' }), d), /\/repo\/pkg\/dir\.md/);
});

test('an empty --system-prompt leaves no leading blank part', () => {
  const out = buildSystemPrompt(input({ systemPrompt: '' }), deps({ '/repo/.git': DIR }));
  assert.equal(out, ENV);
});
