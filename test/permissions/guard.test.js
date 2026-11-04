import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGuard, denialReason, shellWords, simpleCommands } from '../../src/permissions/guard.js';
import { builtinDenies, parseRules } from '../../src/permissions/rules.js';

const HOME = '/Users/u';
const WHERE = { file: '/etc/clodent/settings.json', cwd: '/work', home: HOME };
const noRealpath = async () => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

function guardOf({ deny = [], ask = [] }, deps = {}) {
  const lists = { deny: parseRules(deny, 'permissions.deny', WHERE), ask: parseRules(ask, 'permissions.ask', WHERE) };
  return createGuard(lists, { realpath: noRealpath, lstat: noRealpath, platform: 'linux', ...deps });
}

async function hiddenOf(guard, input, mode, tool = 'Grep') {
  const { hidden } = await guard.screen(tool, input, '/work', mode);
  return hidden && ((paths) => Promise.all(paths.map(hidden)));
}

async function bash(guard, command) {
  const ruled = await guard.check('Bash', { command }, '/work');
  return ruled && `${ruled.decision} ${ruled.rule.text}`;
}

test('Bash: a command that mentions a Read rule path is denied in every spelling of the path', async () => {
  const guard = guardOf({ deny: ['Read(~/.ssh)', `Read(/${HOME}/Library/Application Support/Clodex/remote.env)`] });
  const denied = [
    'cat ~/.ssh/id_rsa',
    'cat $HOME/.ssh/x',
    'cat ${HOME}/.ssh/x',
    `cat ${HOME}/.ssh/x`,
    'ls ~/.ssh',
    `cat "${HOME}/Library/Application Support/Clodex/remote.env"`,
    `cat ${HOME}/Library/Application\\ Support/Clodex/remote.env`,
    `cat '${HOME}/Library/Application Support/Clodex/remote.env';echo`,
  ];
  for (const command of denied) assert.match(await bash(guard, command), /^deny Read\(/, command);
  for (const command of ['cat ~/.sshx', 'cat ~/.ssh.bak', 'echo HEAD~1', `cat ${HOME}/Library/Application/Clodex/remote.env`]) {
    assert.equal(await bash(guard, command), null, command);
  }
});

test('Bash: a mention must end where a path segment ends, so ~/.zshrc.bak is not ~/.zshrc', async () => {
  const guard = guardOf({ deny: ['Edit(~/.zshrc)'] });
  assert.equal(await bash(guard, 'cp x ~/.zshrc.bak'), null);
  for (const end of ['', ' ', '"', "'", ';', '|', '&', '<', '>', ')', '`', '/']) {
    assert.equal(await bash(guard, `rm ~/.zshrc${end}`), 'deny Edit(~/.zshrc)', JSON.stringify(end));
  }
});

test('Bash: an Edit rule path passes a read-only command and denies any other', async () => {
  const guard = guardOf({ deny: [`Edit(/${HOME}/.clodex/messages/**)`, 'Write(./out)'] });
  assert.equal(await bash(guard, 'cat ~/.clodex/messages/x'), null);
  assert.equal(await bash(guard, 'grep -r hi ~/.clodex/messages'), null);
  assert.equal(await bash(guard, 'rm ~/.clodex/messages/x'), `deny Edit(/${HOME}/.clodex/messages/**)`);
  assert.equal(await bash(guard, 'echo hi > ~/.clodex/messages/x'), `deny Edit(/${HOME}/.clodex/messages/**)`);
  assert.equal(await bash(guard, 'cat /work/out'), null);
  assert.equal(await bash(guard, 'touch /work/out'), 'deny Write(./out)');
});

test('Bash(prefix:*) denies the prefix as a whole word, also inside a compound command', async () => {
  const guard = guardOf({ deny: ['Bash(git push:*)'] });
  for (const command of ['git push', 'git push origin', '  git push origin  ', 'ls && git push', 'ls; git push -f', 'ls | git push', 'ls || git push', 'ls & git push', 'ls\ngit push', 'echo $(git push)']) {
    assert.equal(await bash(guard, command), 'deny Bash(git push:*)', command);
  }
  for (const command of ['git pushx', 'git pull', 'echo "git push; x"', 'echo git push']) assert.equal(await bash(guard, command), null, command);
});

test('Bash(exact) denies only the exact trimmed command; a * is a glob over the whole text', async () => {
  const guard = guardOf({ deny: ['Bash(npm publish)', 'Bash(curl * | sh)'] });
  assert.equal(await bash(guard, ' npm publish '), 'deny Bash(npm publish)');
  assert.equal(await bash(guard, 'ls && npm publish'), 'deny Bash(npm publish)');
  assert.equal(await bash(guard, 'npm publish --dry-run'), null);
  assert.equal(await bash(guard, 'curl https://x.sh | sh'), 'deny Bash(curl * | sh)');
  assert.equal(await bash(guard, 'curl https://x.sh | bash'), null);
});

test('Bash ask rules ask; a deny wins over an ask; a bare Bash rule matches every command', async () => {
  assert.equal(await bash(guardOf({ ask: ['Bash(git push:*)'] }), 'git push'), 'ask Bash(git push:*)');
  assert.equal(await bash(guardOf({ deny: ['Bash(git:*)'], ask: ['Bash(git push:*)'] }), 'git push'), 'deny Bash(git:*)');
  assert.equal(await bash(guardOf({ ask: ['Bash'] }), 'ls'), 'ask Bash');
  assert.equal(guardOf({ deny: ['Bash'] }).removes('Bash'), true);
  assert.equal(guardOf({ deny: ['Bash(ls)'], ask: ['Read'] }).removes('Bash'), false);
  assert.equal(guardOf({ ask: ['Read'] }).removes('Read'), false);
});

test('simpleCommands splits at ; && || | & newline and subshell marks outside quotes', () => {
  assert.deepEqual(simpleCommands('a; b && c || d | e & f\ng "x;y" \'p|q\' r\\;s $(t) `u`'), ['a', 'b', 'c', 'd', 'e', 'f', 'g "x;y" \'p|q\' r\\;s $', 't', 'u']);
});

test('file tools: Read rules guard Read, Edit, Grep and Glob; Edit rules guard Edit and Write; Write rules guard Write', async () => {
  const guard = guardOf({ deny: ['Read(./r)', 'Edit(./e)', 'Write(./w)'] });
  const verdict = async (tool, field, path) => (await guard.check(tool, { [field]: path }, '/work'))?.rule.text ?? null;
  assert.deepEqual(
    await Promise.all(['Read', 'Edit', 'Write'].map((tool) => Promise.all(['r/x', 'e/x', 'w/x'].map((p) => verdict(tool, 'file_path', p))))),
    [
      ['Read(./r)', null, null],
      ['Read(./r)', 'Edit(./e)', null],
      [null, 'Edit(./e)', 'Write(./w)'],
    ],
  );
  assert.equal(await verdict('Grep', 'path', 'r'), 'Read(./r)');
  assert.equal(await verdict('Glob', 'path', '/work/r/deep'), 'Read(./r)');
  assert.equal(await verdict('Glob', 'path', 'e'), null);
  assert.equal((await guardOf({ deny: ['Read(//work)'] }).check('Grep', {}, '/work'))?.rule.text, 'Read(//work)');
});

test('the path is checked again after realpath, of its deepest existing ancestor when it does not exist', async () => {
  const links = { '/work/link': '/Users/u/.ssh' };
  const realpath = async (path) => {
    if (Object.hasOwn(links, path)) return links[path];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const guard = guardOf({ deny: ['Read(~/.ssh)'] }, { realpath });
  assert.equal((await guard.check('Read', { file_path: 'link/new/id_rsa' }, '/work'))?.rule.text, 'Read(~/.ssh)');
  assert.equal(await guard.check('Read', { file_path: 'other/id_rsa' }, '/work'), null);
});

test('the listing filter hides files a deny path rule for that tool matches, and an ask rule unless the mode is yolo', async () => {
  const guard = guardOf({ deny: ['Read(./r)', 'Edit(./e)', 'Grep(./g)'], ask: ['Read(./a)'] });
  const files = ['/work/r/x', '/work/e/x', '/work/g/x', '/work/a/x'];
  for (const [mode, expected] of [
    ['yolo', [true, false, true, false]],
    ['ask', [true, false, true, true]],
    ['read-only', [true, false, true, true]],
  ]) {
    assert.deepEqual(await (await hiddenOf(guard, {}, mode))(files), expected, mode);
  }
  assert.deepEqual(await (await hiddenOf(guard, {}, 'yolo', 'Glob'))(['/work/r/x', '/work/g/x']), [true, false]);
  assert.equal(await hiddenOf(guard, { file_path: 'r/x' }, 'ask', 'Read'), null);
  assert.equal(await hiddenOf(guardOf({}), {}, 'ask'), null);
  assert.equal(await hiddenOf(guardOf({ ask: ['Read(./a)'] }), {}, 'yolo'), null);
});

test('screen returns an approved filter without the ask rules that match the root, for use after the user allows the ask', async () => {
  const guard = guardOf({ deny: ['Read(./s/d)'], ask: ['Read(./s)', 'Read(./s/inner)'] });
  const files = ['/work/s/b', '/work/s/inner/c', '/work/s/d/e'];
  const asked = await guard.screen('Grep', { path: 's' }, '/work', 'ask');
  assert.equal(`${asked.ruled.decision} ${asked.ruled.rule.text}`, 'ask Read(./s)');
  assert.deepEqual(await Promise.all(files.map(asked.hidden)), [true, true, true]);
  assert.deepEqual(await Promise.all(files.map(asked.approved)), [false, true, true]);
  const plain = await guard.screen('Glob', {}, '/work', 'ask');
  assert.equal(plain.ruled, null);
  assert.equal(plain.approved, plain.hidden);
  assert.equal((await guard.screen('Read', { file_path: 's/b' }, '/work', 'ask')).approved, null);
});

test('the listing filter also tests each listed file under the realpath of a symlinked root', async () => {
  const realpath = async (path) => {
    if (path === '/work/h') return HOME;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const grep = await hiddenOf(guardOf({ deny: ['Read(~/.ssh)'] }, { realpath }), { path: 'h' }, 'yolo');
  assert.deepEqual(await grep(['/work/h/.ssh/id_rsa', '/work/h/notes.txt', `${HOME}/.ssh/x`]), [true, false, true]);
});

test('the listing filter resolves a symlink entry with realpath and hides it when the target matches; other entries stay lexical', async () => {
  const links = { '/work/k': `${HOME}/.ssh/id_rsa`, '/work/ok': '/work/notes.txt' };
  const asked = [];
  const realpath = async (path) => {
    asked.push(path);
    if (Object.hasOwn(links, path)) return links[path];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const lstat = async (path) => ({ isSymbolicLink: () => Object.hasOwn(links, path) });
  const guard = guardOf({ deny: ['Read(~/.ssh)'] }, { realpath, lstat });
  for (const tool of ['Grep', 'Glob']) {
    const hide = await hiddenOf(guard, {}, 'yolo', tool);
    asked.length = 0;
    assert.deepEqual(await hide(['/work/k', '/work/ok', '/work/notes.txt']), [true, false, false], tool);
    assert.deepEqual(asked, ['/work/k', '/work/ok'], tool);
  }
});

test('screen resolves a listing root with realpath once and returns the verdict with the listing filter', async () => {
  const asked = [];
  const realpath = async (path) => {
    asked.push(path);
    if (path === '/work/h') return HOME;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const guard = guardOf({ deny: ['Read(~/.ssh)'] }, { realpath });
  await guard.check('Bash', { command: 'true' }, '/work');
  asked.length = 0;
  const { ruled, hidden } = await guard.screen('Grep', { path: 'h' }, '/work', 'ask');
  assert.deepEqual(asked, ['/work/h']);
  assert.equal(ruled, null);
  assert.equal(await hidden('/work/h/.ssh/id_rsa'), true);
  assert.equal((await guard.screen('Glob', { path: 'h/.ssh' }, '/work', 'ask')).ruled?.rule.text, 'Read(~/.ssh)');
});

test('rule prefixes are resolved with realpath once, on the first check, and a rule matches its real form too', async () => {
  const asked = [];
  const realpath = async (path) => {
    asked.push(path);
    if (path === `${HOME}/.ssh`) return '/vault/ssh';
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const guard = guardOf({ deny: ['Read(~/.ssh)'], ask: ['Edit(~/.ssh/**/*.pub)'] }, { realpath });
  assert.deepEqual(asked, []);
  const rule = async (tool, input) => {
    const ruled = await guard.check(tool, input, '/work');
    return ruled && `${ruled.decision} ${ruled.rule.text}`;
  };
  assert.equal(await rule('Read', { file_path: '/vault/ssh/id_rsa' }), 'deny Read(~/.ssh)');
  assert.equal(await rule('Bash', { command: 'cat /vault/ssh/id_rsa' }), 'deny Read(~/.ssh)');
  assert.equal(await rule('Bash', { command: 'cat ~/.ssh/id_rsa' }), 'deny Read(~/.ssh)');
  assert.equal(await rule('Write', { file_path: '/vault/ssh/k/a.pub' }), 'ask Edit(~/.ssh/**/*.pub)');
  assert.equal(await rule('Write', { file_path: '/vault/ssh/k/a.txt' }), null);
  assert.deepEqual(await (await hiddenOf(guard, { path: '/vault' }, 'yolo'))(['/vault/ssh/id_rsa', '/vault/x']), [true, false]);
  assert.equal(asked.filter((path) => path === `${HOME}/.ssh`).length, 1);
});

test('a rule on <tmp>/link/secret, where link -> real, denies Read of <tmp>/real/secret on the real filesystem', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'clodent-guard-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, 'real'));
  writeFileSync(join(tmp, 'real/secret'), 'x');
  symlinkSync(join(tmp, 'real'), join(tmp, 'link'));
  const text = `Read(/${tmp}/link/secret)`;
  const guard = createGuard({ deny: parseRules([text], 'permissions.deny', WHERE) });
  assert.equal((await guard.check('Read', { file_path: join(tmp, 'real/secret') }, '/work'))?.rule.text, text);
  assert.equal(await guard.check('Read', { file_path: join(tmp, 'real/other') }, '/work'), null);
  assert.equal((await guard.check('Bash', { command: `cat ${realpathSync(tmp)}/real/secret` }, '/work'))?.rule.text, text);
  const { hidden } = await guard.screen('Grep', { path: join(tmp, 'real') }, '/work', 'yolo');
  assert.equal(await hidden(join(tmp, 'real/secret')), true);
});

test('darwin: a path under /System/Volumes/Data is also checked without that prefix, lexically, after realpath and in listings', async () => {
  const realpath = async (path) => {
    if (path === '/work/x') return `/System/Volumes/Data${HOME}/.ssh`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const rules = { deny: ['Read(~/.ssh)'] };
  const darwin = guardOf(rules, { realpath, platform: 'darwin' });
  const linux = guardOf(rules, { realpath, platform: 'linux' });
  const read = async (guard, file_path) => (await guard.check('Read', { file_path }, '/work'))?.rule.text ?? null;
  assert.equal(await read(darwin, `/System/Volumes/Data${HOME}/.ssh/id_rsa`), 'Read(~/.ssh)');
  assert.equal(await read(darwin, 'x/id_rsa'), 'Read(~/.ssh)');
  assert.equal(await read(linux, `/System/Volumes/Data${HOME}/.ssh/id_rsa`), null);
  assert.equal(await read(linux, 'x/id_rsa'), null);
  assert.equal(await read(darwin, `/System/Volumes/Datax${HOME}/.ssh/id_rsa`), null);
  assert.deepEqual(await (await hiddenOf(darwin, { path: '/System/Volumes/Data' }, 'yolo'))([`/System/Volumes/Data${HOME}/.ssh/id_rsa`]), [true]);
  assert.deepEqual(await (await hiddenOf(darwin, { path: 'x' }, 'yolo'))(['/work/x/id_rsa']), [true]);
  const spelled = { deny: [`Read(//System/Volumes/Data${HOME}/.ssh)`] };
  assert.equal(await read(guardOf(spelled, { platform: 'darwin' }), `${HOME}/.ssh/id_rsa`), spelled.deny[0]);
  assert.equal(await bash(guardOf(spelled, { platform: 'darwin' }), 'cat ~/.ssh/id_rsa'), `deny ${spelled.deny[0]}`);
  assert.equal(await read(guardOf(spelled, { platform: 'linux' }), `${HOME}/.ssh/id_rsa`), null);
});

test('Bash: a mention matches in any letter case and after a /System/Volumes/Data prefix, on every platform', async () => {
  const guard = guardOf({ deny: ['Read(~/.ssh)', 'Edit(//etc/hosts)'] });
  for (const command of ['cat ~/.SSH/id_rsa', `cat /USERS/U/.ssh/x`, 'cat $HOME/.Ssh', 'echo x > /ETC/Hosts', `cat /System/Volumes/Data${HOME}/.ssh/id_rsa`]) {
    assert.match(await bash(guard, command), /^deny /, command);
  }
  for (const command of ['cat ~/.SSHX', 'cat /etc/hostsx']) assert.equal(await bash(guard, command), null, command);
});

test('Bash: each word is also matched dequoted, with ~ and $HOME expanded and resolved, so //, /./ and x/.. spellings are denied', async () => {
  const guard = guardOf({ deny: ['Read(~/.ssh)', 'Edit(~/.bashrc)', 'Read(./secret)'] });
  const denied = [
    'cat ~//.ssh/id_rsa',
    'cat ~/./.ssh/id_rsa',
    `cat ${HOME}//.ssh/id_rsa`,
    'cat /Users//u/.ssh/id_rsa',
    'cat ~/x/../.ssh/id_rsa',
    "cat ~/'.ssh'/id_rsa",
    'cat ~/".s"sh/id_rsa',
    'tail -n+1 ~//.ssh/*',
    'head $HOME//.ssh/id_rsa',
    'cat "${HOME}"/./.ssh/id_rsa',
    'grep x ~//.ssh/config',
    'sed -n 1p ~/./.ssh/id_rsa',
    'cat ~//.SSH/id_rsa',
    'ssh -i ~//.ssh/id_rsa host',
    'dd if=~//.ssh/id_rsa',
    'wc <~/./.ssh/id_rsa',
    'echo "$(cat ~//.ssh/id_rsa)"',
    'echo `cat ~//.ssh/id_rsa`',
    'cat secret/a.txt',
    'cat ./x/../secret',
  ];
  for (const command of denied) assert.match(await bash(guard, command), /^deny Read\(/, command);
  assert.equal(await bash(guard, 'echo x >> ~/./.bashrc'), 'deny Edit(~/.bashrc)');
  assert.equal(await bash(guard, 'echo x >~//.bashrc'), 'deny Edit(~/.bashrc)');
  for (const command of ['cat ~/./.bashrc', 'cat ~//.sshx', 'cat ~/x/.ssh/id_rsa', 'echo HEAD~1', 'cat secrets', "echo '~x/.ssh'"]) {
    assert.equal(await bash(guard, command), null, command);
  }
});

test(`Bash: $'…' and $"…" quoting is decoded and ~<user> is a sibling of the home directory, so neither hides a Read rule path`, async () => {
  const guard = guardOf({ deny: ['Read(~/.ssh)'] });
  const denied = [
    "cat ~/$'.ssh'/id_rsa",
    "cat ~/$'\\x2essh'/id_rsa",
    'cat ~/$".ssh"/id_rsa',
    "cat ~/$'\\056ssh'/id_rsa",
    "cat ~/$'.ssh\\0junk'/id_rsa",
    'cat ~u/.ssh/id_rsa',
    'cat ~u//.ssh/id_rsa',
  ];
  for (const command of denied) assert.equal(await bash(guard, command), 'deny Read(~/.ssh)', command);
  for (const command of ["cat ~/$'.sshx'/id_rsa", `echo "$'.ssh'"`, 'cat ~x/.ssh/id_rsa', 'cat ~uu/.ssh/id_rsa']) {
    assert.equal(await bash(guard, command), null, command);
  }
});

test('shellWords dequotes words and splits at blanks, operators, redirections and substitutions', () => {
  assert.deepEqual(shellWords(`a "b c" 'd e' f\\ g "x\\y\\$z" '' h;i&&j|k<l>>m`), ['a', 'b c', 'd e', 'f g', 'x\\y$z', 'h', 'i', 'j', 'k', 'l', 'm']);
  assert.deepEqual(shellWords('echo "a $(cat "b c") d" `e f` (g) $((1+2))'), ['echo', 'a ', 'cat', 'b c', ' d', 'e', 'f', 'g', '1+2']);
  assert.deepEqual(shellWords("echo '$(x)' \"it's\"\\\nz"), ['echo', '$(x)', "it'sz"]);
  assert.deepEqual(shellWords(`a $'b\\tc\\'d;e' $"f g" "$'h'" $'\\x41\\101\\u0042\\0z'i $'\\q\\cA'`), ['a', "b\tc'd;e", 'f g', "$'h'", 'AABi', '\\q\x01']);
});

test('built-in denies cover Read and Edit of each settings file and Read of /proc/*/environ, and the reason names the built-in rule', async () => {
  const files = [`${HOME}/.clodent/settings.json`, '/etc/seat/s.json', `${HOME}/.clodent/./settings.json`];
  const deny = builtinDenies(files, HOME);
  const [read, edit] = [`Read(/${HOME}/.clodent/settings.json)`, `Edit(/${HOME}/.clodent/settings.json)`];
  assert.deepEqual(
    deny.map((rule) => [rule.text, rule.builtin]),
    [read, edit, 'Read(//etc/seat/s.json)', 'Edit(//etc/seat/s.json)', 'Read(//proc/*/environ)', 'Read(//proc/*/task/*/environ)'].map((text) => [text, true]),
  );
  const guard = createGuard({ deny }, { realpath: noRealpath, lstat: noRealpath, platform: 'linux' });
  const rule = async (tool, input) => (await guard.check(tool, input, '/work'))?.rule.text ?? null;
  const file_path = `${HOME}/.clodent/settings.json`;
  assert.deepEqual(
    [await rule('Read', { file_path }), await rule('Edit', { file_path }), await rule('Write', { file_path }), await rule('Grep', { path: file_path })],
    [read, read, edit, read],
  );
  for (const command of ['cat ~//.clodent/settings.json', 'sed -n 1p ~/.clodent/./settings.json', 'grep KEY $HOME/.clodent/settings.json']) {
    assert.equal(await rule('Bash', { command }), read, command);
  }
  assert.equal(await rule('Bash', { command: 'jq . /etc//seat/s.json' }), 'Read(//etc/seat/s.json)');
  assert.equal(await rule('Bash', { command: 'cat /proc/$PPID/environ' }), 'Read(//proc/*/environ)');
  assert.equal(await rule('Read', { file_path: '/proc/self/environ' }), 'Read(//proc/*/environ)');
  assert.equal(await rule('Bash', { command: 'cat /proc/1/task/1/environ' }), 'Read(//proc/*/environ)');
  assert.equal(await rule('Read', { file_path: '/proc/1/task/1/environ' }), 'Read(//proc/*/task/*/environ)');
  for (const [tool, input] of [['Read', { file_path: `${HOME}/.clodent/other.json` }], ['Bash', { command: 'cat /proc/1/status' }], ['Write', { file_path: '/work/settings.json' }]]) {
    assert.equal(await rule(tool, input), null, JSON.stringify(input));
  }
  assert.equal(denialReason(deny[0]), `denied by built-in rule ${read}`);
  assert.equal(denialReason(parseRules(['Read(x)'], 'permissions.deny', WHERE)[0]), 'denied by settings rule Read(x)');
});
