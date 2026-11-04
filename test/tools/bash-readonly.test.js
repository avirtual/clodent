import { test } from 'node:test';
import assert from 'node:assert/strict';
import { READ_ONLY_COMMANDS, classifyBash } from '../../src/tools/bash-readonly.js';

const READ_ONLY = [
  'ls',
  'ls -la src',
  'pwd',
  'cat README.md',
  'head -n 20 src/cli.js',
  'tail -5 CHANGELOG.md',
  'wc -l src/*.js',
  'grep -rn "decide(" src',
  "egrep 'a|b' file",
  'fgrep -x word file',
  "rg -n 'TODO' --glob '*.js'",
  'rg --pre-glob "*.gz" foo',
  "echo '$(x)'",
  'echo "$HOME" ${USER} $PATH ${TMPDIR} $PWD $OLDPWD $LOGNAME $SHELL',
  'echo $HOME',
  'ls "$PWD"',
  'cat "$HOME/.zshrc" src/proc/x.js',
  'cd src && ls *',
  'grep -rn x ../other src',
  "jq -r '.dependencies | keys[]' package.json",
  'printf "%s\\n" a b',
  'true && false || echo fallback',
  'cat x 2>/dev/null',
  'ls >/dev/null 2>&1',
  'ls &>/dev/null',
  'ls >&2',
  'ls "{a}">/dev/null',
  "echo 'a\\\nb'",
  'echo a\\\\\nls',
  'grep x <input.txt',
  'cat file | sort | uniq -c | sort -rn | head',
  'sort -k2,2 -t: data',
  'uniq -c sorted.txt',
  'xxd -g1 bin.dat',
  'tree -L 2 src',
  'date +%Y-%m-%d',
  'date -u',
  'file -b README.md',
  'stat -f %z file',
  'du -sh .',
  'df -h',
  'which node && type git',
  'whoami; id; uname -a',
  'basename /a/b.js .js; dirname /a/b.js',
  'realpath .; readlink -f link',
  'cut -d, -f1 data.csv | tr a-z A-Z',
  'diff -u a b; cmp a b; comm -12 a b',
  "jq '.name' package.json",
  'od -c f; hexdump -C f; strings bin',
  'column -t f; nl f; fold -w 80 f; paste a b; seq 1 5',
  '[ -f x ] && test -d y',
  'cd src && ls',
  'sha256sum f; sha1sum f; shasum f; md5 f; md5sum f; cksum f',
  "find . -name '*.js' -type f",
  'find src -newer package.json -print',
  'sed -n 1,20p file',
  "sed -n '/start/,/end/p' file",
  "sed 's/a\\/b/c/g; 10q' file",
  "sed -E -e 's/x/y/2' -e '$d' file",
  'sed = file',
  'git rev-parse --show-toplevel',
  'git describe --tags --always',
  'git merge-base HEAD @{u}',
  'git ls-tree -r HEAD src',
  'git -C ../other --no-pager rev-parse HEAD',
  'git branch',
  'git branch -a -vv',
  'git tag -l',
  'git remote -v',
  'git config --get user.name',
  'git config --list',
  'ls # rm -rf x',
  'ls;',
  'ls |\ncat',
  'l\\s',
  '"ls" -a',
];

const NOT_READ_ONLY = [
  ['echo "$(rm x)"', 'command substitution'],
  ['echo `rm x`', 'command substitution'],
  ['echo "`rm x`"', 'command substitution'],
  ['echo \\`x\\`', 'command substitution'],
  ['diff <(ls a) <(ls b)', 'process substitution'],
  ['ls >(cat)', 'process substitution'],
  ['ls; rm -rf x', 'rm is not a read-only command'],
  ['ls && rm x', 'rm is not a read-only command'],
  ['ls | xargs rm', 'xargs is not a read-only command'],
  ['ls\nrm -rf x', 'rm is not a read-only command'],
  ["ls # it's\nrm -rf x\necho 'done", 'rm is not a read-only command'],
  ['cat x > y', 'output redirection'],
  ['cat x >> y', 'output redirection'],
  ['cat x >| y', 'output redirection'],
  ['cat x &> y', 'output redirection'],
  ['cat x &>> y', 'output redirection'],
  ['cat x 2> err', 'output redirection'],
  ['cat x 2>> err', 'output redirection'],
  ['cat x >& y', 'output redirection'],
  ['cat x > $TMPDIR', 'output redirection'],
  ['cat <> f', 'output redirection'],
  ['cat <<EOF\nx\nEOF', 'here-document'],
  ['cat <<< x', 'here-document'],
  ['ls &', 'background job &'],
  ['ls & rm x', 'background job &'],
  ['(ls)', 'subshell'],
  ['{ ls; }', 'command group'],
  ['FOO=1 ls', 'variable assignment'],
  ['>/dev/null FOO=1 ls', 'variable assignment'],
  ['/bin/ls', '/bin/ls is not a read-only command'],
  ['./ls', './ls is not a read-only command'],
  ['$SHELL -la', 'command name $SHELL is an expansion'],
  ['"${SHELL}"', 'command name "${SHELL}" is an expansion'],
  ["echo 'unterminated", 'unterminated quote'],
  ['echo "unterminated', 'unterminated quote'],
  ['ls\u0001', 'control character'],
  ['ls\r\nrm x', 'control character'],
  ['ls;;', 'empty command'],
  [';ls', 'empty command'],
  ['ls |', 'empty command'],
  ['ls && || cat', 'empty command'],
  ['', 'empty command'],
  ['> /dev/null', 'redirection without a command'],
  ['echo ${x:-y}', 'parameter expansion'],
  ['echo $((1+1))', 'command substitution'],
  ["echo $'\\'' ; rm -rf x #'", "$' quoting"],
  ['echo x\\', 'trailing backslash'],
  ['git -c core.pager=sh log', 'git -c'],
  ['git --git-dir=.git rev-parse HEAD', 'git --git-dir=.git'],
  ['git branch newname', 'git branch newname'],
  ['git tag v1', 'git tag v1'],
  ['git remote add o url', 'git remote add'],
  ['git config user.name x', 'git config without --get or --list'],
  ['git config --unset user.name', 'git config --unset'],
  ['git push', 'git push is not read-only'],
  ['git checkout .', 'git checkout is not read-only'],
  ['git log --output=out', 'git log --output=out'],
  ['git diff --ext-diff', 'git diff --ext-diff'],
  ['git grep -O x', 'git grep -O'],
  ['git grep --open-files-in-pager=vim x', 'git grep --open-files-in-pager=vim'],
  ['git', 'git without a subcommand'],
  ['git describe $HOME', 'git argument $HOME is an expansion or glob'],
  ['sed -i s/a/b/ f', 'sed -i'],
  ['sed -I .bak s/a/b/ f', 'sed -I'],
  ['sed --in-place s/a/b/ f', 'sed --in-place'],
  ["sed 's/a/b/w out' f", 'sed script s/a/b/w out'],
  ["sed 'w out' f", 'sed script w out'],
  ["sed '1e date' f", 'sed script 1e date'],
  ["sed 'r /etc/passwd' f", 'sed script r /etc/passwd'],
  ["sed 's/a/b/e' f", 'sed script s/a/b/e'],
  ['sed -f script.sed f', 'sed -f'],
  ['sed p f -i', 'sed -i after an operand'],
  ["sed 's/[/]/g;s/gw src/lib/p' f", 'sed script s/[/]/g;s/gw src/lib/p'],
  ['find . -delete', 'find -delete'],
  ['find . -exec rm {} ;', 'find -exec'],
  ['find . -fprint out', 'find -fprint'],
  ['find . -name *', 'find argument * is an expansion or glob'],
  ['find {-delete,x}', 'find argument {-delete,x} is an expansion or glob'],
  ['sort -o out in', 'sort -o'],
  ['sort -rout in', 'sort -rout'],
  ['sort --outp=out in', 'sort --outp=out'],
  ['sort --compress-program=sh in', 'sort --compress-program=sh'],
  ['tree -o out', 'tree -o'],
  ['tree -R -H . -L 1', 'tree -R'],
  ['rg --pre sh x', 'rg --pre'],
  ['rg --pre=sh x', 'rg --pre=sh'],
  ['rg --hostname-bin=sh x', 'rg --hostname-bin=sh'],
  ['date -s 12:00', 'date -s'],
  ['date --set=12:00', 'date --set=12:00'],
  ['date 0101000026', 'date 0101000026'],
  ['file -C -m magic', 'file -C'],
  ['uniq in out', 'uniq with an output file'],
  ['xxd in out', 'xxd with an output file'],
  ['xxd in -c', 'xxd with an output file'],
  ["printf -v 'a[$(touch pwned)]' x", 'printf -v'],
  ['printf -v PATH %s bin; ls', 'printf -v'],
  ['printf -vPATH %s bin', 'printf -vPATH'],
  ["test -v 'a[$(touch pwned)]'", 'test -v'],
  ["[ -v 'a[$(touch pwned)]' ]", '[ -v'],
  ['test -R ref', 'test -R'],
  ['echo -v; test $USER x', 'test argument $USER is an expansion or glob'],
  ['[ -n "$USER" ]', '[ argument "$USER" is an expansion or glob'],
  ["ls {a['$(touch pwned)']}>/dev/null", 'variable redirection'],
  ['ls {PATH}</dev/null; cat x', 'variable redirection'],
  ["ls {a['$(touch pwned)']}\\\n>/dev/null", 'line continuation'],
  ['echo {PATH}\\\n</dev/null; cat x', 'line continuation'],
  ['ls \\\n-la', 'line continuation'],
  ['echo "a\\\nb"', 'line continuation'],
  ['echo "$\\\n(touch pwned)"', 'line continuation'],
  ['echo $\\\n{PATH}', 'line continuation'],
  ['rm -rf x', 'rm is not a read-only command'],
  ['env ls', 'env is not a read-only command'],
  ['bash -c ls', 'bash is not a read-only command'],
];

test('the allowlist is the one the spec names', () => {
  assert.equal(READ_ONLY_COMMANDS.length, 58);
  assert.ok(READ_ONLY_COMMANDS.includes('['));
  assert.ok(!READ_ONLY_COMMANDS.includes('rm'));
});

test('read-only commands classify as read-only', () => {
  assert.ok(READ_ONLY.length >= 40);
  for (const command of READ_ONLY) assert.deepEqual(classifyBash(command), { readOnly: true }, command);
});

test('anything else is not read-only and names the first offending part', () => {
  assert.ok(NOT_READ_ONLY.length >= 40);
  for (const [command, reason] of NOT_READ_ONLY) assert.deepEqual(classifyBash(command), { readOnly: false, reason }, command);
});

test('a newline-separated script is read-only only when every line is', () => {
  const script = 'cd src\n\ngit rev-parse HEAD\nls -la | head -3\n';
  assert.deepEqual(classifyBash(script), { readOnly: true });
  assert.deepEqual(classifyBash(`${script}touch x\n`), { readOnly: false, reason: 'touch is not a read-only command' });
});

test('the first offending segment wins over a later construct', () => {
  assert.deepEqual(classifyBash('rm x; echo $(y)'), { readOnly: false, reason: 'rm is not a read-only command' });
});

test('in a session whose working directory is /, a relative word and a recursive search with no path may reach /proc', () => {
  assert.deepEqual(classifyBash('grep -r KEY', '/'), { readOnly: false, reason: 'grep may search /proc' });
  assert.deepEqual(classifyBash('cat proc/1/environ', '/'), { readOnly: false, reason: 'proc/1/environ may reach /proc' });
  for (const command of ['grep -r KEY', 'cat proc/1/environ']) assert.deepEqual(classifyBash(command, '/work'), { readOnly: true }, command);
});

test('a command that is not a string is not read-only', () => {
  assert.deepEqual(classifyBash(undefined), { readOnly: false, reason: 'command is not a string' });
  assert.deepEqual(classifyBash(['ls']), { readOnly: false, reason: 'command is not a string' });
});

const notReadOnly = (cases) => {
  for (const [command, reason] of cases) assert.deepEqual(classifyBash(command), { readOnly: false, reason }, command);
};

test('only HOME, PWD, OLDPWD, USER, LOGNAME, SHELL, PATH and TMPDIR expand; any other name or special parameter is not read-only', () => {
  for (const name of ['HOME', 'PWD', 'OLDPWD', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR']) {
    assert.deepEqual(classifyBash(`echo $${name} "\${${name}}"`), { readOnly: true }, name);
  }
  notReadOnly([
    ['echo $ANTHROPIC_API_KEY', '$ANTHROPIC_API_KEY expansion'],
    ['echo "${GITHUB_TOKEN}"', '$GITHUB_TOKEN expansion'],
    ['cat /proc/$PPID/environ', '$PPID expansion'],
    ['ls; echo "a$home"', '$home expansion'],
    ...['$', '?', '!', '0', '9', '@', '*', '#', '-', '_'].map((c) => [`echo "$${c}"`, `$${c} expansion`]),
  ]);
  assert.deepEqual(classifyBash("echo '$ANTHROPIC_API_KEY' \\$GITHUB_TOKEN \"\\$X\""), { readOnly: true });
});

test('env readers are not read-only: the dump commands, and jq env, $ENV, modules and program files', () => {
  notReadOnly([
    ...['env', 'printenv', 'set', 'export', 'declare', 'typeset', 'compgen', 'awk', 'perl', 'python', 'python3'].map((cmd) => [`${cmd} x`, `${cmd} is not a read-only command`]),
    ['jq -n env', 'jq env'],
    ["jq -n '$ENV'", 'jq $ENV'],
    ["jq '.a, env.PATH' f", 'jq .a, env.PATH'],
    ["jq -n '$ENV.HOME'", 'jq $ENV.HOME'],
    ['jq -f prog.jq data', 'jq -f'],
    ['jq -nf prog.jq', 'jq -nf'],
    ['jq --from-file prog.jq', 'jq --from-file'],
    ['jq -L lib .', 'jq -L'],
    ['jq --library-path=lib .', 'jq --library-path=lib'],
    ['jq -n \'import "m" as m; m::f\'', 'jq import "m" as m; m::f'],
    ['jq -n \'include "m"; f\'', 'jq include "m"; f'],
    ['jq -n e?v', 'jq argument e?v is an expansion or glob'],
  ]);
});

test('a word that may name a path under /proc is not read-only, redirections, globs and climbs included', () => {
  notReadOnly([
    ['cat /proc/self/environ', '/proc/self/environ may reach /proc'],
    ['ls "/proc"', '"/proc" may reach /proc'],
    ['cat < /proc/1/environ', '/proc/1/environ may reach /proc'],
    ['cat //proc/1/environ', '//proc/1/environ may reach /proc'],
    ['cat /./tmp/../proc/1/environ', '/./tmp/../proc/1/environ may reach /proc'],
    ['cat /p*/self/environ', '/p*/self/environ may reach /proc'],
    ['cat /*/self/environ', '/*/self/environ may reach /proc'],
    ['cat /[!x]roc/1/environ', '/[!x]roc/1/environ may reach /proc'],
    ['cat {,/proc/self/environ}', '{,/proc/self/environ} may reach /proc'],
    ['cat {/,}proc/self/environ', '{/,}proc/self/environ may reach /proc'],
    ['cat ../../../proc/1/environ', '../../../proc/1/environ may reach /proc'],
    ['cat .*/.*/proc/1/environ', '.*/.*/proc/1/environ may reach /proc'],
    ['cat ~/../proc/1/environ', '~/../proc/1/environ may reach /proc'],
    ['cat ~root/proc/1/environ', '~root/proc/1/environ may reach /proc'],
    ['cat "$OLDPWD"/proc/1/environ', '"$OLDPWD"/proc/1/environ may reach /proc'],
    ['cat /dev/fd/../environ', '/dev/fd/../environ may reach /proc'],
    ['grep --file=/proc/self/environ x', '--file=/proc/self/environ may reach /proc'],
    ['grep -rf/proc/self/environ x', '-rf/proc/self/environ may reach /proc'],
    ['cd / && cat proc/self/environ', 'proc/self/environ may reach /proc'],
    ['cd /usr; cat ../proc/1/environ', '../proc/1/environ may reach /proc'],
    ['cd - && cat proc/1/environ', 'proc/1/environ may reach /proc'],
    ['cd proc && cat self/environ', 'cd proc may reach /proc'],
  ]);
  for (const command of ['cat /procx /usr/proc src/proc/x', 'ls /tmp/*', 'cd /tmp && ls *', 'cat ../a/proc']) {
    assert.deepEqual(classifyBash(command), { readOnly: true }, command);
  }
});

test('a recursive search that may start at / is not read-only', () => {
  notReadOnly([
    ['grep -r KEY /', 'grep may search /proc'],
    ['egrep -R KEY ../..', 'egrep may search /proc'],
    ['grep --directories=recurse KEY ~/..', 'grep may search /proc'],
    ['rg KEY ..', 'rg may search /proc'],
    ['cd / && rg KEY', 'rg may search /proc'],
    ['cd .. && grep -r KEY', 'grep may search /proc'],
    ['diff -r / /tmp/root', 'diff may search /proc'],
  ]);
  for (const command of ['grep -r KEY .', 'rg KEY ../other', 'grep KEY /etc/hosts', 'diff / /tmp']) {
    assert.deepEqual(classifyBash(command), { readOnly: true }, command);
  }
});

test('git subcommands a repo config can make run a program are not read-only', () => {
  notReadOnly([
    ...['status', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'cat-file', 'shortlog', 'rev-list'].map((sub) => [`git ${sub}`, `git ${sub} is not read-only`]),
    ['git describe --dirty', 'git describe --dirty'],
    ['git describe --broken=x', 'git describe --broken=x'],
    ['git -C .. describe --dir', 'git describe --dir'],
  ]);
});
