import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { clodentHome, findTranscript, projectSlug, transcriptPath } from '../../src/session/paths.js';
import { plant, useTempDir } from '../tools/tmp-dir.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';

test('clodentHome is CLODENT_HOME when set, else ~/.clodent', () => {
  assert.equal(clodentHome({ CLODENT_HOME: '/tmp/ch' }, '/Users/a'), '/tmp/ch');
  assert.equal(clodentHome({}, '/Users/a'), '/Users/a/.clodent');
  assert.equal(clodentHome({ CLODENT_HOME: '' }, '/Users/a'), '/Users/a/.clodent');
});

test('projectSlug replaces only / and .', () => {
  assert.equal(projectSlug('/Users/a/my.proj/x_y'), '-Users-a-my-proj-x_y');
  assert.equal(projectSlug('/a/b c/d-e+f@g'), '-a-b c-d-e+f@g');
  assert.equal(projectSlug('/x/.hidden/..'), '-x--hidden---');
});

test('transcriptPath is <home>/projects/<slug>/<id>.jsonl', () => {
  assert.equal(transcriptPath('/h', '/Users/a/my.proj', ID), `/h/projects/-Users-a-my-proj/${ID}.jsonl`);
});

test('findTranscript prefers the cwd project, then scans every project, else null', async (t) => {
  const home = await useTempDir(t);
  const fs = { existsSync, readdirSync };
  assert.equal(findTranscript(home, '/w', ID, fs), null);
  await plant(home, { [`projects/-other/${ID}.jsonl`]: '' });
  assert.equal(findTranscript(home, '/w', ID, fs), `${home}/projects/-other/${ID}.jsonl`);
  await plant(home, { [`projects/-w/${ID}.jsonl`]: '' });
  assert.equal(findTranscript(home, '/w', ID, fs), `${home}/projects/-w/${ID}.jsonl`);
  assert.equal(findTranscript(home, '/w', 'f00', fs), null);
});

test('findTranscript refuses an id that is not a plain name', async (t) => {
  const home = await useTempDir(t);
  await plant(home, { 'projects/x.jsonl': '', 'projects/-w/x.jsonl': '' });
  const fs = { existsSync, readdirSync };
  assert.equal(findTranscript(home, '/w', '../x', fs), null);
  assert.equal(findTranscript(home, '/w', 'a/b', fs), null);
  assert.equal(findTranscript(home, '/w', 'x', fs), `${home}/projects/-w/x.jsonl`);
});
