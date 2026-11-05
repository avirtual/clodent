import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRule, parseRules, RuleError, ruleHome } from '../../src/permissions/rules.js';
import { loadSettings } from '../../src/settings/load.js';

const WHERE = { file: '/etc/clodent/settings.json', cwd: '/work', home: '/Users/u' };
const rule = (text) => parseRule(text, WHERE);
const matches = (text, path) => rule(text).regex.test(path);

function fakeFs(files) {
  return {
    readFile: async (path) => {
      if (!Object.hasOwn(files, path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return JSON.stringify(files[path]);
    },
  };
}

test('a bare clodent tool name is a tool rule; Bash(...) is a command rule; a path tool takes a path', () => {
  for (const name of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']) assert.deepEqual(rule(name), { text: name, kind: 'tool', tool: name });
  assert.equal(rule('Bash(git push:*)').kind, 'bash');
  const tools = Object.fromEntries(['Read', 'Edit', 'Write', 'Grep', 'Glob'].map((name) => [name, rule(`${name}(/x)`)]));
  assert.deepEqual(tools.Read.tools, ['Read', 'Edit', 'Grep', 'Glob']);
  assert.deepEqual(tools.Edit.tools, ['Edit', 'Write']);
  assert.deepEqual(tools.Write.tools, ['Write']);
  assert.deepEqual(tools.Grep.tools, ['Grep']);
  assert.deepEqual(tools.Glob.tools, ['Glob']);
  assert.deepEqual(['Read', 'Edit', 'Write', 'Grep', 'Glob'].map((name) => tools[name].bash), ['read', 'edit', 'edit', null, null]);
});

test('path specifiers expand: // is absolute, ~ is HOME, / is the settings dir, ./ and bare are the cwd', () => {
  const cases = {
    'Read(//abs/path)': '/abs/path',
    'Read(~/p)': '/Users/u/p',
    'Read(~)': '/Users/u',
    'Read(/p)': '/etc/clodent/p',
    'Read(./p)': '/work/p',
    'Read(p/q)': '/work/p/q',
    'Read(~/.ssh/)': '/Users/u/.ssh',
  };
  for (const [text, pattern] of Object.entries(cases)) assert.equal(rule(text).pattern, pattern, text);
  assert.equal(ruleHome({ HOME: '/h' }, () => '/os'), '/h');
  assert.equal(ruleHome({}, () => '/os'), '/os');
  assert.equal(ruleHome({ HOME: '' }, () => '/os'), '/os');
});

test('* stays within one segment, ** spans zero or more, and a rule matches the path or any ancestor', () => {
  assert.equal(matches('Read(//a/*.env)', '/a/x.env'), true);
  assert.equal(matches('Read(//a/*.env)', '/a/b/x.env'), false);
  assert.equal(matches('Read(//a/**/x.env)', '/a/x.env'), true);
  assert.equal(matches('Read(//a/**/x.env)', '/a/b/c/x.env'), true);
  assert.equal(matches('Read(//a/*/seat.json)', '/a/s1/seat.json'), true);
  assert.equal(matches('Read(//a/*/seat.json)', '/a/s1/s2/seat.json'), false);
  assert.equal(matches('Read(~/.ssh)', '/Users/u/.ssh/id_rsa'), true);
  assert.equal(matches('Read(~/.ssh)', '/Users/u/.ssh'), true);
  assert.equal(matches('Read(~/.ssh)', '/Users/u/.sshx'), false);
  assert.equal(matches('Read(~/.ssh/**)', '/Users/u/.ssh'), true);
  assert.equal(matches('Read(~/.ssh/**)', '/Users/u/.ssh/a/b'), true);
  assert.equal(matches('Read(//a/ui.json*)', '/a/ui.json.tmp'), true);
  assert.equal(matches('Read(//)', '/anything/at/all'), true);
});

test('a specifier may contain spaces', () => {
  const text = 'Read(//Users/u/Library/Application Support/Clodex/remote.env)';
  assert.equal(rule(text).pattern, '/Users/u/Library/Application Support/Clodex/remote.env');
  assert.equal(matches(text, '/Users/u/Library/Application Support/Clodex/remote.env'), true);
  assert.equal(matches(text, '/Users/u/Library/Application/Clodex/remote.env'), false);
});

test('rules for tools clodent does not have are ignored, bare or with a specifier', () => {
  const list = ['WebFetch', 'NotebookEdit', 'Agent(claude-code-guide)', 'mcp__clodex', 'mcp__clodex__*', 'mcp__other__dm', 'mcp__clodex__', 'Skill', 'Agent()', 'Reads(/x)', 'Bash_(x)', 'Read(/x)'];
  assert.deepEqual(parseRules(list, 'permissions.deny', WHERE).map((r) => r.text), ['Read(/x)']);
  assert.deepEqual(parseRules(undefined, 'permissions.deny', WHERE), []);
});

test('an exact mcp__clodex__<name> rule is a bare tool rule, and a specifier on it is ignored', () => {
  assert.deepEqual(rule('mcp__clodex__dm'), { text: 'mcp__clodex__dm', kind: 'tool', tool: 'mcp__clodex__dm' });
  assert.deepEqual(rule('mcp__clodex__term_exec(rm -rf)'), { text: 'mcp__clodex__term_exec(rm -rf)', kind: 'tool', tool: 'mcp__clodex__term_exec' });
});

test('each malformed rule list is an error naming the key, the index and the rule', () => {
  const bad = [
    ['nope', 'permissions.deny is not an array'],
    [{}, 'permissions.deny is not an array'],
    [['Read(/x)', 7], 'permissions.deny[1] is not a string'],
    [['Read(/x'], 'permissions.deny[0] "Read(/x": unbalanced parenthesis'],
    [['Read/x)'], 'permissions.deny[0] "Read/x)": unbalanced parenthesis'],
    [['Bash(a))'], 'permissions.deny[0] "Bash(a))": unbalanced parenthesis'],
    [['WebFetch(x'], 'permissions.deny[0] "WebFetch(x": unbalanced parenthesis'],
    [['Read(/x)y'], 'permissions.deny[0] "Read(/x)y": text after the closing parenthesis'],
    [['Read()'], 'permissions.deny[0] "Read()": empty () on Read'],
    [['Bash( )'], 'permissions.deny[0] "Bash( )": empty () on Bash'],
    [['(x)'], 'permissions.deny[0] "(x)": no tool name'],
    [['Read (x)'], 'permissions.deny[0] "Read (x)": tool name "Read " is not exactly Read'],
    [['read(x)'], 'permissions.deny[0] "read(x)": tool name "read" is not exactly Read'],
    [['BASH'], 'permissions.deny[0] "BASH": tool name "BASH" is not exactly Bash'],
    [['Read(/x)', ' glob '], 'permissions.deny[1] " glob ": tool name "glob" is not exactly Glob'],
    [['WRITE(./x)'], 'permissions.deny[0] "WRITE(./x)": tool name "WRITE" is not exactly Write'],
  ];
  for (const [list, message] of bad) {
    assert.throws(() => parseRules(list, 'permissions.deny', WHERE), (err) => err instanceof RuleError && err.message === message, message);
  }
  assert.throws(() => parseRules(['Read(~/.ssh)'], 'permissions.ask', { ...WHERE, home: '' }), {
    message: 'permissions.ask[0] "Read(~/.ssh)": the path expands to nothing (HOME is not set)',
  });
});

test('loadSettings concatenates deny and ask across sources in order and reports fatal errors as settings <path>: <message>', async () => {
  const fs = fakeFs({
    '/h/settings.json': { permissions: { deny: ['Read(~/.ssh)', 'WebFetch'], ask: ['Bash(git push:*)'], allow: ['Bash'], defaultMode: 'plan' } },
    '/1.json': { permissions: { deny: ['Bash'] }, skillOverrides: {}, sandbox: { enabled: false, network: {} } },
  });
  const { settings, warnings } = await loadSettings({ clodentHome: '/h', files: ['/1.json'], cwd: '/w', home: '/Users/u' }, fs);
  assert.deepEqual(warnings, []);
  assert.deepEqual(settings.permissions.deny.map((r) => r.text), ['Read(~/.ssh)', 'Bash']);
  assert.deepEqual(settings.permissions.ask.map((r) => r.text), ['Bash(git push:*)']);
  const fatal = [
    [{ permissions: [] }, 'permissions is not an object'],
    [{ permissions: { ask: 'Read' } }, 'permissions.ask is not an array'],
    [{ permissions: { deny: ['Edit()'] } }, 'permissions.deny[0] "Edit()": empty () on Edit'],
  ];
  for (const [source, message] of fatal) {
    await assert.rejects(loadSettings({ files: ['/2.json'], cwd: '/w', home: '/Users/u' }, fakeFs({ '/2.json': source })), { message: `settings /2.json: ${message}` });
  }
});
