import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from '../../src/agent/permission.js';
import { createBash } from '../../src/tools/bash.js';
import { cleanEnv, useTempDir } from './tmp-dir.js';

const GUARD = { timeout: 20000 };
const bash = createBash();

const STILL_READ_ONLY = [
  'git rev-parse HEAD',
  'git rev-parse --show-toplevel',
  'git -C . --no-pager ls-tree -r HEAD',
  'git merge-base HEAD v1',
  'git describe --tags',
  'git describe --all --long --always',
  'git branch -a -vv',
  'git branch --show-current',
  'git tag -l',
  'git remote -v',
  'git config --list',
  'git config --get core.fsmonitor',
];

const NOW_ASK = [
  ['git status', 'fsmonitor'],
  ['git diff', 'external'],
  ['git log', 'gpg'],
  ['git log -p', 'textconv'],
  ['git show', 'gpg'],
  ['git blame a.txt', 'textconv'],
  ['git grep one', 'fsmonitor'],
  ['git ls-files', 'fsmonitor'],
  ['git cat-file --textconv HEAD:a.txt', 'textconv'],
  ['git cat-file --filters HEAD:a.txt', 'filter'],
  ["git rev-list '--format=%G?' HEAD", 'gpg'],
  ["git shortlog '--group=format:%G?' HEAD", 'gpg'],
  ['git describe --dirty', 'fsmonitor'],
  ['git describe --broken', 'filter'],
];

async function poisonedRepo(t) {
  const root = await useTempDir(t);
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const marks = join(root, 'marks');
  for (const dir of [repo, bin, marks]) mkdirSync(dir);
  const env = cleanEnv({ HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const git = (args, input) => execFileSync('git', args, { cwd: repo, env, input, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'T']);
  git(['config', 'user.email', 't@example.com']);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  writeFileSync(join(repo, '.gitattributes'), '*.txt diff=conv filter=f\n');
  git(['add', 'a.txt', '.gitattributes']);
  git(['commit', '-qm', 'init']);
  git(['tag', 'v1']);
  const signed = git(['hash-object', '-t', 'commit', '-w', '--stdin'], [
    `tree ${git(['rev-parse', 'HEAD^{tree}'])}`,
    `parent ${git(['rev-parse', 'HEAD'])}`,
    'author T <t@example.com> 1700000000 +0000',
    'committer T <t@example.com> 1700000000 +0000',
    'gpgsig -----BEGIN PGP SIGNATURE-----',
    ' ',
    ' iQEzBAABCAAdFiEE',
    ' -----END PGP SIGNATURE-----',
    '',
    'signed',
    '',
  ].join('\n'));
  git(['update-ref', 'HEAD', signed]);
  const program = (name) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\ntouch '${join(marks, name)}'\n${name === 'external' ? '' : 'cat\n'}`);
    chmodSync(path, 0o755);
    return path;
  };
  git(['config', 'core.fsmonitor', program('fsmonitor')]);
  git(['config', 'diff.external', program('external')]);
  git(['config', 'diff.conv.textconv', program('textconv')]);
  git(['config', 'filter.f.clean', program('filter')]);
  git(['config', 'filter.f.smudge', join(bin, 'filter')]);
  git(['config', 'log.showSignature', 'true']);
  git(['config', 'gpg.program', program('gpg')]);
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  utimesSync(join(repo, 'a.txt'), 1600000000, 1600000000);
  const run = async (command, mode) => {
    for (const name of readdirSync(marks)) rmSync(join(marks, name));
    const verdict = decide(bash, { command }, mode);
    if (verdict.allow) await bash.run({ command }, { cwd: repo, env });
    return { verdict, marks: readdirSync(marks) };
  };
  return { run };
}

test('in a repo whose config names programs, every git command still read-only runs in the default mode and starts none', GUARD, async (t) => {
  const { run } = await poisonedRepo(t);
  for (const command of [...STILL_READ_ONLY, ...NOW_ASK.map(([c]) => c)]) {
    const { verdict, marks } = await run(command, 'ask');
    assert.deepEqual(marks, [], command);
    assert.equal(verdict.allow, STILL_READ_ONLY.includes(command), command);
  }
});

test('every git command a poisoned config makes run a program asks in the default mode, and does run it once allowed', GUARD, async (t) => {
  const { run } = await poisonedRepo(t);
  for (const [command, mark] of NOW_ASK) {
    assert.equal((await run(command, 'ask')).verdict.ask, true, command);
    const { marks } = await run(command, 'yolo');
    assert.ok(marks.includes(mark), `${command} ran ${mark}: ${marks}`);
  }
});
