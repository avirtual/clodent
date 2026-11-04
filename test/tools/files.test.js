import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTools } from '../../src/tools/index.js';
import { cleanEnv, ctxFor, gitAdd, gitInit, plant, useTempDir } from './tmp-dir.js';

const listingTools = (deps) => createTools(deps).filter((tool) => tool.name === 'Grep' || tool.name === 'Glob');

test('Grep and Glob list a work tree whose .git/config sets core.fsmonitor to a program without running it', async (t) => {
  const dir = await useTempDir(t);
  const repo = join(dir, 'repo');
  const marker = join(dir, 'marker');
  const hook = join(dir, 'fsmonitor.sh');
  await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  await plant(repo, { 'a.txt': 'needle\n', 'b.txt': 'hay\n' });
  gitInit(repo);
  gitAdd(repo, 'a.txt');
  execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: repo, env: cleanEnv(), stdio: 'ignore' });
  const [grep, glob] = listingTools();
  const ctx = ctxFor(repo);
  assert.deepEqual(await grep.run({ pattern: 'needle' }, ctx), { content: join(repo, 'a.txt'), isError: false });
  const listed = await glob.run({ pattern: '*.txt' }, ctx);
  assert.deepEqual(listed.content.split('\n').sort(), [join(repo, 'a.txt'), join(repo, 'b.txt')]);
  assert.equal(existsSync(marker), false);
  execFileSync('git', ['ls-files'], { cwd: repo, env: cleanEnv(), stdio: 'ignore' });
  assert.equal(existsSync(marker), true);
});

test('the git calls run with core.fsmonitor=false, without ANTHROPIC_API_KEY and the credentials.envVars names in their env', async (t) => {
  const dir = await useTempDir(t);
  await plant(dir, { 'a.txt': 'x\n' });
  const calls = [];
  const execFile = (file, args, options, done) => {
    calls.push({ file, args, env: options.env });
    if (args.includes('check-ignore')) done(new Error('not ignored'), '');
    else done(null, 'a.txt\0');
  };
  const ctx = ctxFor(dir, { env: cleanEnv({ ANTHROPIC_API_KEY: 'sk-test-fake', CLODENT_PROBE: 'hidden', CLODENT_KEPT: 'kept' }) });
  const [grep, glob] = listingTools({ execFile, envDeny: ['CLODENT_PROBE'] });
  assert.equal((await grep.run({ pattern: 'x' }, ctx)).content, join(dir, 'a.txt'));
  assert.equal((await glob.run({ pattern: '*.txt' }, ctx)).content, join(dir, 'a.txt'));
  assert.deepEqual(
    calls.map(({ file, args }) => [file, ...args.slice(0, 3)]),
    [
      ['git', '-c', 'core.fsmonitor=false', 'check-ignore'],
      ['git', '-c', 'core.fsmonitor=false', 'ls-files'],
      ['git', '-c', 'core.fsmonitor=false', 'check-ignore'],
      ['git', '-c', 'core.fsmonitor=false', 'ls-files'],
    ],
  );
  for (const { env } of calls) {
    assert.equal(Object.hasOwn(env, 'ANTHROPIC_API_KEY'), false);
    assert.equal(Object.hasOwn(env, 'CLODENT_PROBE'), false);
    assert.equal(env.CLODENT_KEPT, 'kept');
  }
  assert.equal(ctx.env.ANTHROPIC_API_KEY, 'sk-test-fake');
});
