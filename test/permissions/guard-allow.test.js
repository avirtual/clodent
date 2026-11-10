import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard } from '../../src/permissions/guard.js';
import { parseRules } from '../../src/permissions/rules.js';

const HOME = '/Users/u';
const WHERE = { file: '/etc/clodent/settings.json', cwd: '/work', home: HOME };
const missing = async () => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

function guardOf({ deny = [], ask = [], allow = [] }, deps = {}) {
  const lists = { deny: parseRules(deny, 'permissions.deny', WHERE), ask: parseRules(ask, 'permissions.ask', WHERE), allow: parseRules(allow, 'permissions.allow', WHERE) };
  return createGuard(lists, { realpath: missing, lstat: missing, readdir: missing, platform: 'linux', home: HOME, ...deps });
}

async function verdictOf(guard, tool, input) {
  const ruled = await guard.check(tool, input, '/work');
  return ruled && `${ruled.decision} ${ruled.rule.text}`;
}

const bash = (guard, command) => verdictOf(guard, 'Bash', { command });

test('Bash(prefix:*) allows a command only when every command in it matches an allow rule or is read-only', async () => {
  const guard = guardOf({ allow: ['Bash(git status:*)'] });
  for (const command of ['git status -s', 'git status', 'git status | head -5', 'git status && ls src']) {
    assert.equal(await bash(guard, command), 'allow Bash(git status:*)', command);
  }
  for (const command of ['git status && rm x', 'git status; curl https://example.com', 'git status\nrm x', 'git status || rm x', 'git statusx', 'rm x && git status']) {
    assert.equal(await bash(guard, command), null, command);
  }
});

test('Bash allow: a substitution, a quoted separator or a comment is uncertain and asks, even when every piece matches', async () => {
  const guard = guardOf({ allow: ['Bash(git status:*)', 'Bash(rm:*)', 'Bash(git commit:*)'] });
  assert.equal(await bash(guard, 'git status && rm x'), 'allow Bash(git status:*)');
  assert.equal(await bash(guard, 'git commit -m "fix the bug"'), 'allow Bash(git commit:*)');
  const uncertain = ['git status $(rm x)', 'git status `rm x`', 'git status "$(rm x)"', 'git status <(rm x)', 'git status $\\\n(rm x)', 'git commit -m "a; rm x"', 'git status # rm x', 'git status \\\n-s'];
  for (const command of uncertain) assert.equal(await bash(guard, command), null, JSON.stringify(command));
});

test('Bash(exact) allows only the exact trimmed command', async () => {
  const guard = guardOf({ allow: ['Bash(npm test)'] });
  assert.equal(await bash(guard, 'npm test'), 'allow Bash(npm test)');
  assert.equal(await bash(guard, '  npm test '), 'allow Bash(npm test)');
  for (const command of ['npm test --foo', 'npm testx', 'FOO=1 npm test']) assert.equal(await bash(guard, command), null, command);
  assert.equal(await bash(guardOf({ allow: ['Bash(npm test:*)'] }), 'npm test 2>&1'), null);
});

test('Bash allow: the read-only commands next to an allowed one are judged as if any cd could reach /', async () => {
  const guard = guardOf({ allow: ['Bash(git status:*)'] });
  assert.equal(await bash(guard, 'git status && grep -r TODO .'), 'allow Bash(git status:*)');
  assert.equal(await bash(guard, 'git status && cd / && grep -r TODO .'), null);
  assert.equal(await bash(guard, 'cd / && git status && grep -r TODO .'), null);
});

test('path rules never allow a Bash call; only Bash rules do', async () => {
  const guard = guardOf({ allow: ['Edit(./src/**)', 'Write(./src/**)'] });
  for (const command of ['rm src/a.js', 'echo x > src/a.js']) assert.equal(await bash(guard, command), null, command);
  assert.equal(await verdictOf(guard, 'Edit', { file_path: 'src/a.js' }), 'allow Edit(./src/**)');
});

test('Edit(<path>) allows Edit and Write under it; Write(<path>) allows only Write; Read(<path>) allows no edit', async () => {
  const guard = guardOf({ allow: ['Edit(./src/**)', 'Write(./out/**)', 'Read(./docs/**)'] });
  const rows = [
    ['Edit', 'src/a.js', 'allow Edit(./src/**)'],
    ['Write', 'src/new/b.js', 'allow Edit(./src/**)'],
    ['Write', 'out/c.txt', 'allow Write(./out/**)'],
    ['Edit', 'out/c.txt', null],
    ['Edit', 'docs/d.md', null],
    ['Write', 'docs/d.md', null],
    ['Read', 'docs/d.md', 'allow Read(./docs/**)'],
    ['Edit', 'lib/e.js', null],
    ['Edit', '/work/srcx/a.js', null],
  ];
  for (const [tool, file, expected] of rows) assert.equal(await verdictOf(guard, tool, { file_path: file }), expected, `${tool} ${file}`);
});

test('a path allow rule needs both the lexical and the real path, so a symlink out of an allowed directory asks', async () => {
  const links = { '/work/src/link': '/elsewhere', '/work/src/git': '/work/.git' };
  const realpath = async (path) => {
    const from = Object.keys(links).find((link) => path === link || path.startsWith(`${link}/`));
    if (from) return links[from] + path.slice(from.length);
    if (path === '/work' || path === '/work/src') return path;
    return missing();
  };
  const guard = guardOf({ allow: ['Edit(./**)'] }, { realpath });
  const narrow = guardOf({ allow: ['Edit(./src/**)'] }, { realpath });
  assert.equal(await verdictOf(narrow, 'Edit', { file_path: 'src/a.js' }), 'allow Edit(./src/**)');
  assert.equal(await verdictOf(narrow, 'Write', { file_path: 'src/link/x.js', content: '' }), null);
  assert.equal(await verdictOf(narrow, 'Edit', { file_path: 'src/link' }), null);
  assert.equal(await verdictOf(guard, 'Edit', { file_path: 'src/git/config' }), null);
  const deny = guardOf({ deny: ['Edit(./src/**)'] }, { realpath });
  assert.equal(await verdictOf(deny, 'Edit', { file_path: 'src/link/x.js' }), 'deny Edit(./src/**)');
});

test('a path that exists but does not resolve, as a dangling or looping link or an unreadable entry, asks under a path rule and a bare rule', async () => {
  const entries = { '/work/src/out': 'link', '/work/src/dir': 'link', '/work/src/locked': 'EACCES' };
  const realpath = async (path) => (path === '/work' || path === '/work/src' ? path : missing());
  const lstat = async (path) => {
    if (entries[path] === 'link') return { isSymbolicLink: () => true, isDirectory: () => false };
    if (entries[path]) throw Object.assign(new Error(entries[path]), { code: entries[path] });
    return missing();
  };
  for (const allow of ['Edit(./src/**)', 'Write']) {
    const guard = guardOf({ allow: [allow] }, { realpath, lstat });
    assert.equal(await verdictOf(guard, 'Write', { file_path: 'src/new.js', content: '' }), `allow ${allow}`);
    for (const file of ['src/out', 'src/dir/x.js', 'src/locked/a.js']) {
      assert.equal(await verdictOf(guard, 'Write', { file_path: file, content: '' }), null, `${allow} ${file}`);
    }
  }
});

test('Bash allow: a command only a Bash rule admits asks when it redirects output anywhere but /dev/null or another fd', async () => {
  const guard = guardOf({ allow: ['Bash(git status:*)', 'Bash(git log:*)'] });
  for (const command of ['git status > /dev/null', 'git status 2>/dev/null', 'git status < in']) {
    assert.equal(await bash(guard, command), 'allow Bash(git status:*)', command);
  }
  for (const command of ['git status > x', 'git status >> x', 'git log > ~/.bashrc', 'git status > $OUT', 'git status && git log > x']) {
    assert.equal(await bash(guard, command), null, command);
  }
});

test('protected paths ask even when an allow rule matches: .git, .clodent and .claude parts, hook scripts and settings files', async () => {
  const files = ['/work/hooks/pre.sh', '/Users/u/.config/seat-settings.json', '/work/node'];
  const exists = (path) => files.includes(path) && path !== '/work/node';
  const lstat = async (path) => (exists(path) ? { isDirectory: () => false } : missing());
  const realpath = async (path) => (exists(path) ? path : missing());
  const guard = guardOf({ allow: ['Edit', 'Write', 'Bash'] }, { protect: files, lstat, realpath });
  for (const file of ['.git/config', 'sub/.GIT/hooks/pre-commit', '.clodent/settings.json', '.claude/settings.json', 'hooks/pre.sh', '/Users/u/.config/seat-settings.json']) {
    for (const tool of ['Edit', 'Write']) assert.equal(await verdictOf(guard, tool, { file_path: file }), null, `${tool} ${file}`);
  }
  assert.equal(await verdictOf(guard, 'Edit', { file_path: 'src/a.js' }), 'allow Edit');
  assert.equal(await verdictOf(guard, 'Write', { file_path: 'hooks/other.sh' }), 'allow Write');
  for (const command of ['rm -rf .git', 'echo x > .claude/settings.json', 'cp x hooks/pre.sh', 'sed -i s/a/b/ ~/.config/seat-settings.json', 'cd .clodent && rm settings.json']) {
    assert.equal(await bash(guard, command), null, command);
  }
  for (const command of ['rm -rf build', 'node --test test/a.test.js', 'git commit -m "x"', 'git status $(rm x)']) {
    assert.equal(await bash(guard, command), 'allow Bash', command);
  }
});

test('a deny or ask rule wins over an allow rule on the same call; an uncertain deny still asks', async () => {
  const guard = guardOf({ deny: ['Bash(git push:*)', 'Edit(./src/secret.js)'], ask: ['Edit(./src/ask.js)'], allow: ['Bash(git:*)', 'Edit(./src/**)'] });
  assert.equal(await bash(guard, 'git push origin'), 'deny Bash(git push:*)');
  assert.equal(await verdictOf(guard, 'Edit', { file_path: 'src/secret.js' }), 'deny Edit(./src/secret.js)');
  assert.equal(await verdictOf(guard, 'Edit', { file_path: 'src/ask.js' }), 'ask Edit(./src/ask.js)');
  assert.equal(await bash(guard, "git 'push' x"), 'ask Bash(git push:*)');
  assert.equal(await bash(guard, 'git log'), 'allow Bash(git:*)');
});

test('bare tool rules: Edit allows Edit only, an exact Clodex tool name allows that tool, unknown names are ignored', async () => {
  const guard = guardOf({ allow: ['Edit', 'mcp__clodex__dm', 'WebFetch', 'mcp__other__x'] });
  assert.equal(await verdictOf(guard, 'Edit', { file_path: '/tmp/a' }), 'allow Edit');
  assert.equal(await verdictOf(guard, 'Write', { file_path: '/tmp/a' }), null);
  assert.equal(await verdictOf(guard, 'mcp__clodex__dm', { to: 'x' }), 'allow mcp__clodex__dm');
  assert.equal(await verdictOf(guard, 'mcp__clodex__exec', { name: 'x' }), null);
  assert.equal(await bash(guard, 'rm x'), null);
  assert.equal(guardOf({ allow: ['WebFetch'] }).active, false);
  assert.equal(guardOf({ allow: ['Bash(ls:*)'] }).active, true);
});

test('allow rules leave the Grep and Glob listing filters as the deny and ask rules make them', async () => {
  const guard = guardOf({ deny: ['Read(./secret)'], allow: ['Read(./**)', 'Grep(./**)'] });
  const { ruled, hidden, approved } = await guard.screen('Grep', { pattern: 'x', path: '.' }, '/work', 'ask');
  assert.equal(ruled.decision, 'allow');
  assert.deepEqual(await Promise.all(['/work/secret/a', '/work/b'].map(hidden)), [true, false]);
  assert.equal(approved, hidden);
});
