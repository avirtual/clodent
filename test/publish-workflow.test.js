import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
const steps = workflow.split(/\n\s*- (?=uses:|name:)/).slice(1);
const stepRunning = (pattern) => steps.filter((step) => pattern.test(step));

test('publish.yml grants the OIDC token trusted publishing needs', () => {
  assert.match(workflow, /^\s*id-token: write\s*$/m);
});

test('publish.yml runs on v* tag pushes and on workflow_dispatch', () => {
  assert.match(workflow, /^\s*tags: \['v\*'\]\s*$/m);
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
});

test('publish.yml checks the release tag on a tag push, runs the suite and publishes', () => {
  const [tagCheck] = stepRunning(/node scripts\/check-release-tag\.js "\$GITHUB_REF_NAME"/);
  assert.ok(tagCheck, 'check-release-tag step');
  assert.match(tagCheck, /if: github\.event_name == 'push'/);
  assert.equal(stepRunning(/node scripts\/run-tests\.js/).length, 1);
  assert.match(workflow, /npm publish/);
});

test('publish.yml publishes for real only on a tag push; workflow_dispatch is a dry run', () => {
  const publishes = stepRunning(/npm publish/);
  const real = publishes.filter((step) => !/--dry-run/.test(step));
  const dry = publishes.filter((step) => /--dry-run/.test(step));
  assert.equal(real.length, 1);
  assert.match(real[0], /if: github\.event_name == 'push'/);
  assert.equal(dry.length, 1);
  assert.match(dry[0], /if: github\.event_name == 'workflow_dispatch'/);
});

test('publish.yml uses no npm token or secret', () => {
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(workflow, /NPM_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\./);
});
