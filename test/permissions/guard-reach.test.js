import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, uncertainDecision } from '../../src/permissions/guard.js';
import { builtinDenies, parseRules } from '../../src/permissions/rules.js';

const HOME = '/h';
const SETTINGS = '/h/.clodent/settings.json';
const WHERE = { file: '/etc/clodent/settings.json', cwd: '/work', home: HOME };
const ENV = { HOME, USER: 'h', LOGNAME: 'h', TMPDIR: '/tmp', SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' };
const TREE = {
  '/': ['h', 'work', 'tmp'],
  '/h': ['.ssh', '.clodent', 'notes'],
  '/h/.ssh': ['id_rsa'],
  '/h/.clodent': ['settings.json'],
  '/h/notes': ['a.txt', 'b.txt'],
  '/work': ['src'],
  '/work/src': ['a.js', 'b.js'],
  '/tmp': [],
};
const missing = async () => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

function fakeReaddir(tree = TREE, calls = []) {
  return async (dir) => {
    calls.push(dir);
    if (!Object.hasOwn(tree, dir)) return missing();
    return tree[dir];
  };
}

function guardOf({ deny = ['Read(~/.ssh)'], ask = [], env = ENV, tree = TREE, calls, settings = [SETTINGS] } = {}) {
  const lists = {
    deny: [...parseRules(deny, 'permissions.deny', WHERE), ...builtinDenies(settings, HOME)],
    ask: parseRules(ask, 'permissions.ask', WHERE),
  };
  return createGuard(lists, { realpath: missing, lstat: missing, readdir: fakeReaddir(tree, calls), platform: 'linux', env });
}

async function ruling(guard, command, cwd = '/work', mode = 'ask') {
  const { ruled } = await guard.screen('Bash', { command }, cwd, mode);
  return ruled && `${ruled.decision} ${ruled.rule.text}`;
}

const SSH = 'deny Read(~/.ssh)';
const BUILTIN = `deny Read(/${SETTINGS})`;

test('braces expand as bash does, comma lists and sequences, so a brace spelling of a denied path is denied', async () => {
  const guard = guardOf();
  assert.equal(await ruling(guard, 'cat ~/.{clodent,x}/settings.json'), BUILTIN);
  assert.equal(await ruling(guard, 'cat ~/.ss{g..i}/id_rsa'), SSH);
  assert.equal(await ruling(guard, 'cat ~/.s{x,s{h,y}}/id_rsa'), SSH);
  assert.equal(await ruling(guard, 'cat ~/notes/{a,b}.txt'), null);
  assert.equal(await ruling(guard, "cat ~/.'{clodent,x}'/settings.json"), null);
  assert.equal(await ruling(guard, 'cat ~/.{ssh}/id_rsa'), null);
});

test('a word with over 1024 brace expansions is uncertain: it asks where its literal part could still reach a rule', async () => {
  const guard = guardOf();
  const groups = '{a,b}'.repeat(11);
  const { ruled } = await guard.screen('Bash', { command: `cat ~/${groups}/id_rsa` }, '/work', 'ask');
  assert.equal(`${ruled.decision} ${ruled.rule.text}`, 'ask Read(~/.ssh)');
  assert.equal(ruled.reason, '/h/…/id_rsa may name a path Read(~/.ssh) guards');
  assert.equal(await ruling(guard, `cat ~/notes/${groups}`), null);
  assert.equal(await ruling(guard, 'cat ~/.ss{1..2000}/id_rsa'), 'ask Read(~/.ssh)');
});

test('globs match on disk segment by segment through readdir; a leading dot must be matched explicitly; no match stays literal', async () => {
  const guard = guardOf();
  for (const command of ['cat ~/.ss[h]/id_rsa', 'cat ~/.ss?/id_rsa', 'cat ~/.*/id_rsa', 'cat ~/notes/.*/.ssh/id_rsa', 'cat /?/.ssh/*']) {
    assert.equal(await ruling(guard, command), SSH, command);
  }
  for (const command of ['cat ~/.clo?ent/settings.json', 'cat ~/.clodent/*.json', 'cat ~/.clodent/settings.jso[n]', 'head -c 999 ~/.clodent/s*']) {
    assert.equal(await ruling(guard, command), BUILTIN, command);
  }
  for (const command of ['cat src/*.js', 'cat ~/*/id_rsa', 'cat ~/.ss[!h]/id_rsa', 'cat ~/.ss[x]/id_rsa', "cat \"$HOME\"/'.ss?'/id_rsa", 'cat ~/.ss\\?/id_rsa']) {
    assert.equal(await ruling(guard, command), null, command);
  }
});

test('a glob that visits over 10000 entries is uncertain and asks where it could match a rule; readdir is memoised per screen', async () => {
  const names = Array.from({ length: 10_001 }, (_, i) => `d${i}`);
  const big = guardOf({ tree: { ...TREE, '/h': [...TREE['/h'], ...names] } });
  assert.equal(await ruling(big, 'cat ~/*/id_rsa'), 'ask Read(~/.ssh)');
  assert.equal(await ruling(big, 'cat ~/notes/*'), null);
  const calls = [];
  const guard = guardOf({ calls });
  assert.equal(await ruling(guard, 'cat ~/notes/a* ~/notes/b* ~/notes/c*'), null);
  assert.deepEqual(calls, ['/h/notes']);
});

test('$PWD, $USER, $LOGNAME and $TMPDIR expand; $OLDPWD and any other variable is uncertain; a quoted $ is literal', async () => {
  const guard = guardOf();
  for (const command of ['cat $PWD/../.ssh/id_rsa', 'cat ${PWD}/../.ssh/id_rsa', 'cat "$PWD"/../.ssh/id_rsa', 'cat "${PWD}"/../.ssh/id_rsa']) {
    assert.equal(await ruling(guard, command, '/h/notes'), SSH, command);
  }
  for (const command of ['cat /$USER/.ssh/id_rsa', 'cat /${LOGNAME}/.ssh/id_rsa']) assert.equal(await ruling(guard, command), SSH, command);
  assert.equal(await ruling(guardOf({ env: { ...ENV, TMPDIR: '/h/notes' } }), 'cat $TMPDIR/../.ssh/id_rsa'), SSH);
  assert.equal(await ruling(guard, 'cat $OLDPWD/id_rsa'), 'ask Read(~/.ssh)');
  assert.equal(await ruling(guard, 'cat ~-/id_rsa'), 'ask Read(~/.ssh)');
  assert.equal(await ruling(guard, 'cat ~/$X'), 'ask Read(~/.ssh)');
  for (const command of ["sed -n '$p' a.txt", 'cat ~/notes/$X', 'cat /work/$1', "cat '$OLDPWD'/id_rsa", 'cat $PWD/a.txt']) {
    assert.equal(await ruling(guard, command), null, command);
  }
  const bare = guardOf({ env: { HOME } });
  assert.equal(await ruling(bare, 'cat /$USER/.ssh/id_rsa'), null);
  const shell = guardOf({ env: { ...ENV, SHELL: '/h/.ssh/id_rsa', PATH: '/h/.ssh' } });
  assert.equal(await ruling(shell, 'cat $SHELL'), SSH);
  assert.equal(await ruling(shell, 'ls ${PATH}'), SSH);
  assert.equal(await ruling(guard, 'echo $PATH $SHELL'), null);
});

test('cd and pushd change the directory later relative words resolve against, keeping the earlier ones; cd - is uncertain', async () => {
  const guard = guardOf();
  assert.equal(await ruling(guard, 'cd ~/.ss? && cat id_rsa'), SSH);
  assert.equal(await ruling(guard, 'cd ~ && cat .clodent/settings.json'), BUILTIN);
  assert.equal(await ruling(guard, 'cd && cat .ssh/id_rsa'), SSH);
  assert.equal(await ruling(guard, 'pushd ~; cat .ssh/id_rsa'), SSH);
  assert.equal(await ruling(guard, 'cd /nowhere; cat .ssh/id_rsa', HOME), SSH);
  assert.equal(await ruling(guard, 'cd $PWD/.. && cat h/.ssh/id_rsa'), SSH);
  assert.equal(await ruling(guard, 'echo "$(cd ~; cat .ssh/id_rsa)"'), SSH);
  assert.equal(await ruling(guard, 'cd - && cat id_rsa'), 'ask Read(~/.ssh)');
  assert.equal(await ruling(guard, 'cd src && cat a.js'), null);
  assert.equal(await ruling(guard, 'cd .ssh && cat id_rsa', '/work'), null);
  const cdpath = guardOf({ env: { ...ENV, CDPATH: '/h' } });
  assert.equal(await ruling(cdpath, 'cd .ssh && cat id_rsa'), SSH);
  assert.equal(await ruling(cdpath, 'cd notes/../.ssh && cat id_rsa'), SSH);
  assert.equal(await ruling(cdpath, 'cd ./.ssh && cat id_rsa'), null);
});

test('an uncertain word asks for a deny rule and for an ask rule only where the rule prefix could still match; a certain match keeps its deny', async () => {
  const asks = guardOf({ deny: [], ask: ['Read(~/.ssh)'] });
  assert.equal(await ruling(asks, 'cat ~/.s$X/id_rsa'), 'ask Read(~/.ssh)');
  assert.equal(await ruling(asks, 'cat ~/.ss?/id_rsa'), 'ask Read(~/.ssh)');
  const guard = guardOf({ deny: ['Read(~/.ssh)', 'Edit(~/.bashrc)'] });
  assert.equal(await ruling(guard, 'cat ~/.s$X/id_rsa'), 'ask Read(~/.ssh)');
  assert.equal(await ruling(guard, 'cat ~/x$X/../id_rsa'), 'ask Read(~/.ssh)');
  assert.equal(await ruling(guard, 'cat ~/x$X/../.ssh/id_rsa'), SSH);
  assert.equal(await ruling(guard, 'cat ~/.ssh/$X'), SSH);
  assert.equal(await ruling(guard, 'cat ~/.x$X/id_rsa'), null);
  assert.equal(await ruling(guard, 'cat /work/$X'), null);
  assert.equal(await ruling(guard, 'cat ~/.bash$SHELL'), null);
  assert.equal(await ruling(guard, 'rm ~/.bash$X'), 'ask Edit(~/.bashrc)');
  assert.equal(await ruling(guard, 'rm ~/.bash?c'), null);
  assert.equal(await ruling(guardOf({ deny: ['Edit(~/.bashrc)'], tree: { ...TREE, '/h': ['.bashrc'] } }), 'rm ~/.bash?c'), 'deny Edit(~/.bashrc)');
});

test('a recursive content search rooted at a rule prefix or an ancestor asks, naming the rule and the Grep tool', async () => {
  const guard = guardOf();
  const asked = [
    ['grep -r ANTHROPIC ~', '/work', 'Read(~/.ssh)'],
    ['grep -rh sk-ant ~/.clodent', '/work', `Read(/${SETTINGS})`],
    ['rg -uu sk-ant ~', '/work', 'Read(~/.ssh)'],
    ['diff -r ~/.clodent /tmp', '/work', `Read(/${SETTINGS})`],
    ['egrep --recursive x /', '/work', 'Read(~/.ssh)'],
    ['grep -d recurse x ~', '/work', 'Read(~/.ssh)'],
    ['cd ~ && rg foo', '/work', 'Read(~/.ssh)'],
    ['grep -r -A 2 sk-ant', HOME, 'Read(~/.ssh)'],
    ['rg foo', HOME, 'Read(~/.ssh)'],
    ['rg --hidden -e x src', HOME, 'Read(~/.ssh)'],
  ];
  for (const [command, cwd, rule] of asked) assert.equal(await ruling(guard, command, cwd), `ask ${rule}`, command);
  const { ruled } = await guard.screen('Bash', { command: 'grep -r ANTHROPIC ~' }, '/work', 'ask');
  assert.equal(ruled.reason, 'grep searches /h recursively, which may read files Read(~/.ssh) guards; the Grep tool skips denied files');
  for (const command of ['grep -r foo src', 'rg foo', 'grep -r -e foo src ~/notes', 'grep x ~/*', 'find ~ -name id_rsa', 'ls -R ~', 'tree ~', 'du ~', 'diff ~/notes/a.txt ~/notes/b.txt']) {
    assert.equal(await ruling(guard, command), null, command);
  }
  assert.equal(await ruling(guard, 'cd ~/.ssh && grep -r x'), SSH);
  assert.equal(await ruling(guardOf({ deny: ['Edit(~/.ssh)'], settings: [] }), 'grep -r x ~'), null);
  assert.equal(await ruling(guard, 'grep -r -m 1 x src', HOME), null);
});

test('an uncertain part that may be .., or follow a word part that may hold one, makes the whole word uncertain', async () => {
  const guard = guardOf();
  const names = Array.from({ length: 10_001 }, (_, i) => `d${i}`);
  const big = guardOf({ tree: { ...TREE, '/h/notes': names } });
  const climbs = [
    [guard, 'cat ~/notes/.$OLDPWD./.ssh/id_rsa'],
    [guard, `cat ~/notes/{.,a}${'{,}'.repeat(10)}/.ssh/id_rsa`],
    [guard, `cat ~/notes/.${'{,}'.repeat(11)}./.ssh/id_rsa`],
    [big, 'cat ~/notes/*/.?/.?/.ssh/id_rsa'],
  ];
  for (const [one, command] of climbs) assert.equal(await ruling(one, command), 'ask Read(~/.ssh)', command);
  assert.equal(await ruling(guard, `cat ~/notes/${'{a,b}'.repeat(11)}/.ssh/id_rsa`), null);
  assert.equal(await ruling(big, 'cat ~/notes/*/x/.ssh/id_rsa'), null);
});

test('under --yolo an uncertain or recursive reach of a deny rule denies, since an ask would run unasked; an ask rule still asks', async () => {
  const guard = guardOf();
  assert.equal(uncertainDecision('deny', 'yolo'), 'deny');
  assert.equal(uncertainDecision('deny', 'ask'), 'ask');
  assert.equal(uncertainDecision('ask', 'yolo'), 'ask');
  assert.equal(uncertainDecision('deny', 'yolo', 'weak'), 'ask');
  assert.equal(await ruling(guard, 'cd - && cat id_rsa', '/work', 'yolo'), SSH);
  assert.equal(await ruling(guard, `cat ~/${'{a,b}'.repeat(11)}/id_rsa`, '/work', 'yolo'), SSH);
  assert.equal(await ruling(guard, 'cat $OLDPWD/id_rsa', '/work', 'yolo'), SSH);
  assert.equal(await ruling(guard, 'grep -r ANTHROPIC ~', '/work', 'yolo'), SSH);
  for (const mode of ['ask', 'accept-edits', 'read-only']) assert.equal(await ruling(guard, 'grep -r ANTHROPIC ~', '/work', mode), 'ask Read(~/.ssh)', mode);
  const asks = guardOf({ deny: [], ask: ['Read(~/notes)'], settings: [] });
  assert.equal(await ruling(asks, 'grep -r x ~', '/work', 'yolo'), 'ask Read(~/notes)');
  assert.equal(await ruling(asks, 'cat ~/no$X/a.txt', '/work', 'yolo'), 'ask Read(~/notes)');
});

test('any other variable, and a relative word after cd $X, is weakly uncertain: it asks in every mode, so --yolo runs it, and a literal assignment of a denied path is a mention', async () => {
  const guard = guardOf();
  const weak = ['echo "k=$X"', 'cd "$DIR" && make', 'for f in *; do cat "$f"; done', 'grep -r foo "$DIR"', 'cat ~/.s$X/id_rsa'];
  for (const command of weak) {
    assert.equal(await ruling(guard, command, '/work', 'yolo'), 'ask Read(~/.ssh)', command);
    assert.equal(await ruling(guard, command, '/work', 'ask'), 'ask Read(~/.ssh)', command);
  }
  assert.equal(await ruling(guard, 'echo $PATH', '/work', 'yolo'), null);
  assert.equal(await ruling(guard, 'X=~/.ssh; cat $X/id_rsa', '/work', 'yolo'), SSH);
  assert.equal(await ruling(guard, 'cat "$OLDPWD$X"/id_rsa', '/work', 'yolo'), SSH);
});

test('an uncertain directory from cd - holds only for the commands after it, or for every word of a loop; a certain one holds for every word', async () => {
  const guard = guardOf();
  for (const command of ['cd src && make; cd -', 'cd -', 'cat id_rsa; cd -', 'grep -r foo src; cd -']) {
    assert.equal(await ruling(guard, command, '/work', 'yolo'), null, command);
  }
  assert.equal(await ruling(guard, 'cd - && cat id_rsa', '/work', 'yolo'), SSH);
  assert.equal(await ruling(guard, 'cd -; grep -r foo src', '/work', 'yolo'), SSH);
  assert.equal(await ruling(guard, 'cd $X; cd -; cat a.txt', '/work', 'yolo'), SSH);
  for (const command of ['for i in 1 2; do cat id_rsa; cd -; done', 'while true; do cat id_rsa; cd -; done', 'until false; do cat id_rsa; cd -; done']) {
    assert.equal(await ruling(guard, command, '/work', 'yolo'), SSH, command);
  }
  assert.equal(await ruling(guard, 'cat .ssh/id_rsa; cd ~'), SSH);
});

test('${NAME<op>…} takes its name from the leading identifier, and the word after :-, := or :+ is also a candidate', async () => {
  const guard = guardOf();
  for (const command of ['cat ${OLDPWD%/}/id_rsa', 'cat ${OLDPWD:-x}/id_rsa']) assert.equal(await ruling(guard, command, '/work', 'yolo'), SSH, command);
  for (const command of ['cat ${X:-~/.ssh}/id_rsa', 'cat ${X:=~/.ssh}/id_rsa', 'cat ${X:+~/.ssh}/id_rsa', 'cat ${X-~/.ssh}/id_rsa']) {
    assert.equal(await ruling(guard, command), SSH, command);
    assert.equal(await ruling(guard, command, '/work', 'yolo'), SSH, command);
  }
  assert.equal(await ruling(guard, 'cat ${HOME%/}/notes/a.txt', '/work', 'yolo'), 'ask Read(~/.ssh)');
});
