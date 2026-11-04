import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadSettings } from '../../src/settings/load.js';

const HOME = '/home/u/.clodent';
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
  assert.deepEqual(await loadSettings({ clodentHome: HOME, files: [] }, fakeFs({})), {
    settings: { hooks: {}, statusLine: null, env: {}, extraDirs: [] },
    warnings: [],
  });
});

test('a missing home settings file is fine', async () => {
  const { settings, warnings } = await loadSettings({ clodentHome: HOME, files: ['/a.json'] }, fakeFs({ '/a.json': { model: 'm' } }));
  assert.equal(settings.model, 'm');
  assert.deepEqual(warnings, []);
});

test('a missing --settings file throws with its path', async () => {
  await assert.rejects(loadSettings({ clodentHome: HOME, files: ['/nope.json'] }, fakeFs({})), {
    message: 'settings file not found: /nope.json',
  });
});

test('invalid JSON throws naming the path', async () => {
  await assert.rejects(loadSettings({ clodentHome: HOME, files: [] }, fakeFs({ [HOME_FILE]: '{"hooks": ' })), (err) => {
    assert.match(err.message, /^invalid settings file \/home\/u\/\.clodent\/settings\.json: /);
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
  await assert.rejects(loadSettings({ clodentHome: HOME }, deps), {
    message: `cannot read settings file ${HOME_FILE}: EACCES: permission denied`,
  });
});

test('later files win for statusLine, model and effortLevel', async () => {
  const fs = fakeFs({
    [HOME_FILE]: { statusLine: cmd('/home-status'), model: 'home-model', effortLevel: 'low' },
    '/1.json': { statusLine: cmd('/one-status'), model: 'one-model' },
    '/2.json': { effortLevel: 'high' },
  });
  const { settings, warnings } = await loadSettings({ clodentHome: HOME, files: ['/1.json', '/2.json'] }, fs);
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
  const { settings, warnings } = await loadSettings({ clodentHome: HOME, files: ['/1.json'] }, fs);
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
  const { settings, warnings } = await loadSettings({ clodentHome: HOME, files: ['/1.json'] }, fs);
  assert.deepEqual(settings.extraDirs, ['/a', '/b', '/c', '/d', '/e']);
  assert.deepEqual(warnings, []);
});

test('effortLevel ultra warns and is not kept; xhigh and max are kept', async () => {
  const { settings, warnings } = await loadSettings({ files: ['/1.json'] }, fakeFs({ '/1.json': { effortLevel: 'ultra' } }));
  assert.equal(Object.hasOwn(settings, 'effortLevel'), false);
  assert.deepEqual(warnings, ['settings /1.json: effortLevel "ultra" is not low, medium, high, xhigh or max; ignored']);
  for (const effortLevel of ['xhigh', 'max']) {
    const loaded = await loadSettings({ files: ['/1.json'] }, fakeFs({ '/1.json': { effortLevel } }));
    assert.deepEqual([loaded.settings.effortLevel, loaded.warnings], [effortLevel, []]);
  }
});

test('cacheTtl: the last valid value wins, anything but 5m or 1h warns and is ignored, absent by default', async () => {
  const fs = fakeFs({
    [HOME_FILE]: { cacheTtl: '1h' },
    '/1.json': { cacheTtl: '5m' },
    '/2.json': { cacheTtl: '1h' },
    '/3.json': { cacheTtl: '2h' },
    '/4.json': { cacheTtl: 60 },
  });
  const { settings, warnings } = await loadSettings({ clodentHome: HOME, files: ['/1.json', '/2.json', '/3.json', '/4.json'] }, fs);
  assert.equal(settings.cacheTtl, '1h');
  assert.deepEqual(warnings, [
    'settings /3.json: cacheTtl "2h" is not 5m or 1h; ignored',
    'settings /4.json: cacheTtl 60 is not 5m or 1h; ignored',
  ]);
  assert.equal((await loadSettings({ clodentHome: HOME, files: ['/1.json'] }, fs)).settings.cacheTtl, '5m');
  assert.equal(Object.hasOwn((await loadSettings({ files: ['/3.json'] }, fs)).settings, 'cacheTtl'), false);
});

test('settings model drops one trailing [suffix]', async () => {
  const { settings } = await loadSettings({ files: ['/1.json'] }, fakeFs({ '/1.json': { model: 'claude-opus-5-5[1m]' } }));
  assert.equal(settings.model, 'claude-opus-5-5');
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

test('compactReloadFiles: an integer from 0 to 20, the last one wins, absent by default; any other value throws naming the path', async () => {
  const fs = fakeFs({ [HOME_FILE]: { compactReloadFiles: 20 }, '/1.json': { compactReloadFiles: 0 } });
  assert.equal((await loadSettings({ clodentHome: HOME }, fs)).settings.compactReloadFiles, 20);
  assert.equal((await loadSettings({ clodentHome: HOME, files: ['/1.json'] }, fs)).settings.compactReloadFiles, 0);
  assert.equal(Object.hasOwn((await loadSettings({ files: [] }, fs)).settings, 'compactReloadFiles'), false);
  for (const value of [-1, 21, 2.5, '5', null, true]) {
    const bad = fakeFs({ '/b.json': { compactReloadFiles: value } });
    const message = `settings /b.json: compactReloadFiles ${JSON.stringify(value)} is not an integer from 0 to 20`;
    await assert.rejects(loadSettings({ files: ['/b.json'] }, bad), { message });
  }
});

test('hookContextMaxBytes: perHook and perEvent merge per key with the defaults filled in, absent by default', async () => {
  const fs = fakeFs({ [HOME_FILE]: { hookContextMaxBytes: { perHook: 1024 } }, '/1.json': { hookContextMaxBytes: { perEvent: 16777216 } }, '/2.json': { hookContextMaxBytes: {} } });
  assert.deepEqual((await loadSettings({ clodentHome: HOME }, fs)).settings.hookContextMaxBytes, { perHook: 1024, perEvent: 262144 });
  assert.deepEqual((await loadSettings({ clodentHome: HOME, files: ['/1.json'] }, fs)).settings.hookContextMaxBytes, { perHook: 1024, perEvent: 16777216 });
  assert.deepEqual((await loadSettings({ files: ['/2.json'] }, fs)).settings.hookContextMaxBytes, { perHook: 65536, perEvent: 262144 });
  assert.equal(Object.hasOwn((await loadSettings({ files: [] }, fs)).settings, 'hookContextMaxBytes'), false);
});

test('a bad hookContextMaxBytes value or key throws naming the path', async () => {
  const cases = [
    [0, ' 0 is not an object {perHook, perEvent}'],
    ['64k', ' "64k" is not an object {perHook, perEvent}'],
    [null, ' null is not an object {perHook, perEvent}'],
    [{ perHook: 0 }, '.perHook 0 is not an integer from 1024 to 16777216'],
    [{ perHook: 1023 }, '.perHook 1023 is not an integer from 1024 to 16777216'],
    [{ perEvent: '64k' }, '.perEvent "64k" is not an integer from 1024 to 16777216'],
    [{ perHook: 1e9 }, '.perHook 1000000000 is not an integer from 1024 to 16777216'],
    [{ perEvent: 2048.5 }, '.perEvent 2048.5 is not an integer from 1024 to 16777216'],
    [{ perHook: 2048, perTool: 2048 }, '.perTool is not perHook or perEvent'],
  ];
  for (const [value, rest] of cases) {
    const bad = fakeFs({ '/b.json': { hookContextMaxBytes: value } });
    await assert.rejects(loadSettings({ files: ['/b.json'] }, bad), { message: `settings /b.json: hookContextMaxBytes${rest}` });
  }
});

test('an onFailure other than "block" or "warn" warns once and is treated as "warn"', async () => {
  const hooks = { PreToolUse: [{ hooks: [cmd('/a', { onFailure: 'Block' }), cmd('/b', { onFailure: 'warn' }), cmd('/c', { onFailure: 1 }), cmd('/d', { onFailure: 'block' })] }] };
  const { settings, warnings } = await loadSettings({ files: ['/1.json'] }, fakeFs({ '/1.json': { hooks } }));
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks.map((hook) => hook.onFailure), ['warn', 'warn', 'warn', 'block']);
  assert.deepEqual(warnings, [
    'settings /1.json: hooks.PreToolUse[0].hooks[0].onFailure "Block" is not "block" or "warn"; treated as "warn"',
    'settings /1.json: hooks.PreToolUse[0].hooks[2].onFailure 1 is not "block" or "warn"; treated as "warn"',
  ]);
});

test('an unknown hook event key warns once; Claude Code events clodent does not fire load silently', async () => {
  const group = { hooks: [cmd('/x')] };
  const hooks = { preToolUse: [group], SubagentStart: [group], SubagentStop: [group], SessionEnd: [group], PermissionRequest: [group], Stop: [group] };
  const { settings, warnings } = await loadSettings({ files: ['/1.json'] }, fakeFs({ '/1.json': { hooks } }));
  assert.deepEqual(warnings, ['settings /1.json: hooks.preToolUse is not a known event; it never fires']);
  assert.deepEqual(Object.keys(settings.hooks), Object.keys(hooks));
});
