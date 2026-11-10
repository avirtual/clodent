import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../scripts/check-release-tag.js';

const SCRIPT = fileURLToPath(new URL('../scripts/check-release-tag.js', import.meta.url));

const CHANGELOG = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  '## 0.7.0 — 2026-11-10',
  '',
  '- a bullet',
  '',
  '## 0.6.1 — 2026-11-06',
  '',
].join('\n');

async function check(argv, { version = '0.7.0', changelog = CHANGELOG } = {}) {
  const files = {
    'package.json': JSON.stringify({ name: 'clodent', version }),
    'CHANGELOG.md': changelog,
  };
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    readFile: async (name) => {
      if (!(name in files)) throw new Error(`ENOENT: ${name}`);
      return files[name];
    },
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
  });
  return { code, stdout, stderr };
}

test('a tag matching package.json version with a CHANGELOG heading passes', async () => {
  const r = await check(['v0.7.0']);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /v0\.7\.0/);
});

test('a heading that is exactly ## <version> passes', async () => {
  const r = await check(['v0.7.0'], { changelog: '## Unreleased\n\n## 0.7.0\n' });
  assert.equal(r.code, 0);
});

test('a tag that is not v + package.json version fails on one stderr line', async () => {
  for (const tag of ['v0.6.1', '0.7.0', 'v0.7.0-rc.1', 'v0.7.0 ']) {
    const r = await check([tag]);
    assert.equal(r.code, 1, tag);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^check-release-tag: tag .* does not match package\.json version 0\.7\.0/, tag);
    assert.equal(r.stderr.split('\n').length, 2, tag);
  }
});

test('a missing CHANGELOG heading fails', async () => {
  const r = await check(['v0.8.0'], { version: '0.8.0' });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'check-release-tag: CHANGELOG.md has no "## 0.8.0" heading\n');
});

test('a heading for a longer version with the same prefix does not match', async () => {
  const changelog = '## Unreleased\n\n## 0.7.01 — 2026-11-10\n\n## 0.7.0-rc.1\n\n- ## 0.7.0 — not a heading\n';
  const r = await check(['v0.7.0'], { changelog });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'check-release-tag: CHANGELOG.md has no "## 0.7.0" heading\n');
});

test('a missing tag argument fails', async () => {
  const r = await check([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^check-release-tag: missing tag; usage: node scripts\/check-release-tag\.js <tag>\n$/);
});

test('run as a command with no tag, it exits 1 with the usage line on stderr', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stderr, 'check-release-tag: missing tag; usage: node scripts/check-release-tag.js <tag>\n');
  assert.equal(run.stdout, '');
});
