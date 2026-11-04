import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_URL, API_VERSION } from '../../src/api/request.js';
import { hookGroup, runMain, strip, textReply, toolsReply, writeSettings } from '../helpers/run-main.js';
import { script } from '../hooks/scripts.js';
import { useTempDir } from '../tools/tmp-dir.js';

const GUARD = { timeout: 10000 };
const HEADERS = { 'x-api-key': 'sk-test', 'anthropic-version': API_VERSION, 'content-type': 'application/json', 'user-agent': 'clay/0.0.1' };

async function setup(t) {
  return { home: await useTempDir(t), cwd: await useTempDir(t), dir: await useTempDir(t) };
}

test('ANTHROPIC_BASE_URL from the process env replaces the origin and keeps the headers', async (t) => {
  const { home, cwd } = await setup(t);
  const res = await runMain(['-p', 'hi'], { home, cwd, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787/seat/x/' }, responses: [textReply('ok')] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.calls[0].url, 'http://127.0.0.1:8787/seat/x/v1/messages');
  assert.deepEqual(res.calls[0].headers, HEADERS);
});

test('ANTHROPIC_BASE_URL in settings env wins over the process env; without either the API origin is used', async (t) => {
  const { home, cwd, dir } = await setup(t);
  const settings = writeSettings(dir, { env: { ANTHROPIC_BASE_URL: 'https://proxy.example' } });
  const res = await runMain(['-p', 'hi', '--settings', settings], { home, cwd, env: { ANTHROPIC_BASE_URL: 'http://ignored.example' }, responses: [textReply('ok')] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.calls[0].url, 'https://proxy.example/v1/messages');
  assert.deepEqual(res.calls[0].headers, HEADERS);
  const plain = await runMain(['-p', 'hi'], { home, cwd, env: { ANTHROPIC_BASE_URL: '' }, responses: [textReply('ok')] });
  assert.equal(plain.calls[0].url, API_URL);
});

test('an ANTHROPIC_BASE_URL that is not an http or https URL exits 2 before any request', async (t) => {
  const { home, cwd, dir } = await setup(t);
  for (const bad of ['ftp://proxy.example', 'not a url', 'file:///tmp/x']) {
    const res = await runMain(['-p', 'hi'], { home, cwd, env: { ANTHROPIC_BASE_URL: bad } });
    assert.deepEqual([res.code, res.stdout, res.stderr, res.calls.length], [2, '', 'clay: invalid ANTHROPIC_BASE_URL\n', 0], bad);
  }
  const settings = writeSettings(dir, { env: { ANTHROPIC_BASE_URL: 'ws://proxy.example' } });
  const viaSettings = await runMain(['-p', 'hi', '--settings', settings], { home, cwd });
  assert.deepEqual([viaSettings.code, viaSettings.stderr], [2, 'clay: invalid ANTHROPIC_BASE_URL\n']);
});

test('settings env reaches the API key lookup, the Bash tool and hooks', GUARD, async (t) => {
  const { home, cwd, dir } = await setup(t);
  const log = join(dir, 'hook-env');
  const hook = await script(dir, 'env.sh', `cat > /dev/null\necho "$FROM_SETTINGS" > ${JSON.stringify(log)}`);
  const settings = writeSettings(dir, { env: { ANTHROPIC_API_KEY: 'sk-settings', FROM_SETTINGS: 'seat-value' }, hooks: { Stop: [hookGroup('', hook)] } });
  const res = await runMain(['-p', 'env', '--yolo', '--settings', settings], {
    home,
    cwd,
    key: null,
    responses: [toolsReply([['Bash', { command: 'echo "$FROM_SETTINGS"' }]]), textReply('done')],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.calls[0].headers['x-api-key'], 'sk-settings');
  assert.equal(strip(res.calls[1].body.messages)[2].content[0].content, 'seat-value\n[exit 0]');
  assert.equal(readFileSync(log, 'utf8'), 'seat-value\n');
});

test('settings model, effortLevel and extra directories apply when the flags are absent, and the flags win', async (t) => {
  const { home, cwd, dir } = await setup(t);
  const settings = writeSettings(dir, { model: 'claude-haiku-5-5', effortLevel: 'medium', trustedDirectories: ['/shared', '/msgs'], permissions: { additionalDirectories: ['rel'] } });
  const res = await runMain(['-p', 'hi', '--settings', settings, '--add-dir', '/shared'], { home, cwd, responses: [textReply('ok')] });
  assert.equal(res.code, 0, res.stderr);
  const { body } = res.calls[0];
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.deepEqual(body.output_config, { effort: 'medium' });
  assert.match(body.system[0].text, new RegExp(`\\nAdditional directories:\\n/shared\\n/msgs\\n${join(cwd, 'rel')}$`, 'm'));
  const flags = await runMain(['-p', 'hi', '--settings', settings, '--model', 'claude-opus-5-5', '--effort', 'low'], { home, cwd, responses: [textReply('ok')] });
  assert.equal(flags.calls[0].body.model, 'claude-opus-5-5');
  assert.deepEqual(flags.calls[0].body.output_config, { effort: 'low' });
});

test('$CLAY_HOME/settings.json loads first, --settings paths resolve against cwd, and warnings follow the session line', async (t) => {
  const { home, cwd } = await setup(t);
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'claude-haiku-5-5', effortLevel: 'xhigh' }));
  writeFileSync(join(cwd, 'local.json'), JSON.stringify({ model: 'claude-sonnet-5-5' }));
  const res = await runMain(['-p', 'hi', '--settings', 'local.json'], { home, cwd, responses: [textReply('ok')] });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.calls[0].body.model, 'claude-sonnet-5-5');
  const lines = res.stderr.split('\n');
  assert.match(lines[0], /^\[clay:session\] /);
  assert.equal(lines[1], `clay: settings ${join(home, 'settings.json')}: effortLevel "xhigh" is not low, medium or high; ignored`);
});

test('an invalid settings file exits 2 with the loader error before any request', async (t) => {
  const { home, cwd } = await setup(t);
  writeFileSync(join(cwd, 'bad.json'), '{');
  const res = await runMain(['-p', 'hi', '--settings', 'bad.json'], { home, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /^clay: invalid settings file .*bad\.json: [^\n]+\n$/);
  assert.equal(res.calls.length, 0);
});
