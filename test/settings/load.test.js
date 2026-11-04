import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadSettings } from '../../src/settings/load.js';

const HOME = '/home/u/.clay';
const HOME_FILE = `${HOME}/settings.json`;
const CLODEX_FIXTURE = fileURLToPath(new URL('./fixtures/clodex-settings.json', import.meta.url));

function fakeFs(files) {
  return {
    readFile: async (path) => {
      if (!Object.hasOwn(files, path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      const content = files[path];
      return typeof content === 'string' ? content : JSON.stringify(content);
    },
  };
}

const cmd = (command, extra = {}) => ({ type: 'command', command, ...extra });
const norm = (command, extra = {}) => ({ type: 'command', command, timeout: null, onFailure: null, ...extra });

test('no sources gives empty settings and no warnings', async () => {
  assert.deepEqual(await loadSettings({ clayHome: HOME, files: [] }, fakeFs({})), {
    settings: { hooks: {}, statusLine: null, env: {}, extraDirs: [] },
    warnings: [],
  });
});

test('a missing home settings file is fine', async () => {
  const { settings, warnings } = await loadSettings({ clayHome: HOME, files: ['/a.json'] }, fakeFs({ '/a.json': { model: 'm' } }));
  assert.equal(settings.model, 'm');
  assert.deepEqual(warnings, []);
});

test('a missing --settings file throws with its path', async () => {
  await assert.rejects(loadSettings({ clayHome: HOME, files: ['/nope.json'] }, fakeFs({})), {
    message: 'settings file not found: /nope.json',
  });
});

test('invalid JSON throws naming the path', async () => {
  await assert.rejects(loadSettings({ clayHome: HOME, files: [] }, fakeFs({ [HOME_FILE]: '{"hooks": ' })), (err) => {
    assert.match(err.message, /^invalid settings file \/home\/u\/\.clay\/settings\.json: /);
    return true;
  });
  await assert.rejects(loadSettings({ files: ['/b.json'] }, fakeFs({ '/b.json': 'not json' })), /^Error: invalid settings file \/b\.json: /);
});

test('a top level that is not an object throws naming the path', async () => {
  for (const content of ['[]', 'null', '42', '"x"']) {
    await assert.rejects(loadSettings({ files: ['/c.json'] }, fakeFs({ '/c.json': content })), {
      message: 'invalid settings file /c.json: top level is not an object',
    });
  }
});

test('a read error other than ENOENT throws naming the path', async () => {
  const deps = { readFile: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
  await assert.rejects(loadSettings({ clayHome: HOME }, deps), {
    message: `cannot read settings file ${HOME_FILE}: EACCES: permission denied`,
  });
});

test('later files win for statusLine, model and effortLevel', async () => {
  const fs = fakeFs({
    [HOME_FILE]: { statusLine: cmd('/home-status'), model: 'home-model', effortLevel: 'low' },
    '/1.json': { statusLine: cmd('/one-status'), model: 'one-model' },
    '/2.json': { effortLevel: 'high' },
  });
  const { settings, warnings } = await loadSettings({ clayHome: HOME, files: ['/1.json', '/2.json'] }, fs);
  assert.deepEqual(settings.statusLine, { type: 'command', command: '/one-status' });
  assert.equal(settings.model, 'one-model');
  assert.equal(settings.effortLevel, 'high');
  assert.deepEqual(warnings, []);
});

test('hooks concatenate per event in source order', async () => {
  const fs = fakeFs({
    '/1.json': {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [cmd('/one-pre', { timeout: 15, onFailure: 'block' })] }],
        Stop: [{ hooks: [cmd('/one-stop')] }],
      },
    },
    '/2.json': {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [cmd('/two-pre')] }],
        UserPromptSubmit: [{ matcher: '', hooks: [cmd('/two-ups')] }],
      },
    },
  });
  const { settings, warnings } = await loadSettings({ files: ['/1.json', '/2.json'] }, fs);
  assert.deepEqual(settings.hooks, {
    PreToolUse: [
      { matcher: 'Bash', hooks: [norm('/one-pre', { timeout: 15, onFailure: 'block' })] },
      { matcher: '', hooks: [norm('/two-pre')] },
    ],
    Stop: [{ matcher: '', hooks: [norm('/one-stop')] }],
    UserPromptSubmit: [{ matcher: '', hooks: [norm('/two-ups')] }],
  });
  assert.deepEqual(warnings, []);
});

test('hook entries whose type is not command are dropped with a warning', async () => {
  const fs = fakeFs({ '/1.json': { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'prompt', prompt: 'x' }, cmd('/ok')] }] } } });
  const { settings, warnings } = await loadSettings({ files: ['/1.json'] }, fs);
  assert.deepEqual(settings.hooks.Stop, [{ matcher: '', hooks: [norm('/ok')] }]);
  assert.deepEqual(warnings, ['settings /1.json: hooks.Stop[0].hooks[0] has type "prompt"; only "command" hooks run; dropped']);
});

test('env merges shallowly and drops non-string values with a warning', async () => {
  const fs = fakeFs({
    [HOME_FILE]: { env: { A: 'home', B: 'home' } },
    '/1.json': { env: { B: 'one', C: 3, D: null, E: 'e' } },
  });
  const { settings, warnings } = await loadSettings({ clayHome: HOME, files: ['/1.json'] }, fs);
  assert.deepEqual(settings.env, { A: 'home', B: 'one', E: 'e' });
  assert.deepEqual(warnings, [
    'settings /1.json: env.C is not a string; dropped',
    'settings /1.json: env.D is not a string; dropped',
  ]);
});

test('trustedDirectories and permissions.additionalDirectories union into extraDirs', async () => {
  const fs = fakeFs({
    [HOME_FILE]: { trustedDirectories: ['/a', '/b'], permissions: { additionalDirectories: ['/c', '/a'] } },
    '/1.json': { trustedDirectories: ['/b', '/d'], permissions: { additionalDirectories: ['/e'], deny: ['Bash(rm:*)'] } },
  });
  const { settings, warnings } = await loadSettings({ clayHome: HOME, files: ['/1.json'] }, fs);
  assert.deepEqual(settings.extraDirs, ['/a', '/b', '/c', '/d', '/e']);
  assert.deepEqual(warnings, []);
});

test('effortLevel xhigh warns and is not kept', async () => {
  const { settings, warnings } = await loadSettings({ files: ['/1.json'] }, fakeFs({ '/1.json': { effortLevel: 'xhigh' } }));
  assert.equal(Object.hasOwn(settings, 'effortLevel'), false);
  assert.deepEqual(warnings, ['settings /1.json: effortLevel "xhigh" is not low, medium or high; ignored']);
});

test('unknown keys are ignored silently', async () => {
  const fs = fakeFs({ '/1.json': { voice: { enabled: false }, voiceEnabled: false, includeCoAuthoredBy: true, model: 'm' } });
  assert.deepEqual(await loadSettings({ files: ['/1.json'] }, fs), {
    settings: { hooks: {}, statusLine: null, env: {}, extraDirs: [], model: 'm' },
    warnings: [],
  });
});

test('a settings file shaped like the Clodex-written one loads with no warnings', async () => {
  const { settings, warnings } = await loadSettings({ files: [CLODEX_FIXTURE] });
  assert.deepEqual(warnings, []);
  assert.deepEqual(settings.statusLine, { type: 'command', command: '/Users/u/.clodex/run/seat/statusline' });
  assert.deepEqual(settings.env, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8899' });
  assert.deepEqual(settings.extraDirs, ['/Users/u/.clodex/messages', '/Users/u/.clodex/sessions/seat/messages']);
  assert.equal(settings.effortLevel, 'high');
  assert.deepEqual(settings.hooks.PreToolUse.map((group) => group.matcher), [
    'Bash',
    'mcp__clodex__term_exec|mcp__clodex__term_read|mcp__clodex__dm|mcp__clodex__exec',
    '',
  ]);
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks[1], norm('/Users/u/.clodex/run/seat/guard', { timeout: 15, onFailure: 'block' }));
  assert.deepEqual(settings.hooks.PostToolUse.at(-1).matcher, 'Agent|Task');
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks.length, 7);
});
