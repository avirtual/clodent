import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSettings } from '../../src/settings/load.js';
import { SANDBOX_NOTICE } from '../../src/settings/sandbox.js';

const WHERE = { files: ['/s/1.json'], cwd: '/w', home: '/Users/u' };

function fakeFs(source) {
  return { readFile: async () => JSON.stringify(source) };
}

function load(source) {
  return loadSettings(WHERE, fakeFs(source));
}

test('a sandbox block without enabled: true is ignored silently, malformed or not', async () => {
  for (const sandbox of [{ enabled: false, filesystem: { denyRead: 'x' } }, { filesystem: { denyRead: ['/a'] } }, true, 'on', { enabled: 'true', credentials: [] }]) {
    const { settings, warnings } = await load({ sandbox });
    assert.deepEqual([settings.permissions, settings.envDeny, warnings], [undefined, undefined, []], JSON.stringify(sandbox));
  }
});

test('enabled: true turns denyRead into Read rules, denyWrite into Edit rules and each deny credentials file into both, after permissions.deny', async () => {
  const { settings, warnings } = await load({
    permissions: { deny: ['Bash(git push:*)'] },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: ['x'] },
      filesystem: { allowWrite: ['/'], denyRead: ['/abs/secret', '~/.ssh', '~', 'rel/*.key'], denyWrite: ['~/.zshrc'] },
      credentials: { files: [{ path: '/Users/u/.aws', mode: 'deny' }] },
    },
  });
  assert.deepEqual(settings.permissions.deny.map((r) => r.text), [
    'Bash(git push:*)',
    'Read(//abs/secret)',
    'Read(~/.ssh)',
    'Read(~)',
    'Read(rel/*.key)',
    'Edit(~/.zshrc)',
    'Read(//Users/u/.aws)',
    'Edit(//Users/u/.aws)',
  ]);
  assert.deepEqual(settings.permissions.deny.slice(1).map((r) => r.pattern), ['/abs/secret', '/Users/u/.ssh', '/Users/u', '/w/rel/*.key', '/Users/u/.zshrc', '/Users/u/.aws', '/Users/u/.aws']);
  assert.deepEqual(settings.permissions.ask, []);
  assert.deepEqual(warnings, [`settings /s/1.json: ${SANDBOX_NOTICE}`]);
  assert.equal(SANDBOX_NOTICE, 'sandbox: clodent does not sandbox Bash; filesystem and credentials entries are enforced as permission rules, other keys ignored');
});

test('deny credentials envVars become envDeny, deduplicated across sources; an entry whose mode is not deny warns and is ignored', async () => {
  const sources = {
    '/s/1.json': { sandbox: { enabled: true, credentials: { envVars: [{ name: 'GITHUB_TOKEN', mode: 'deny' }, { name: 'PATH', mode: 'allow' }], files: [{ path: '/x' }] } } },
    '/s/2.json': { sandbox: { enabled: true, credentials: { envVars: [{ name: 'GITHUB_TOKEN', mode: 'deny' }, { name: 'AWS_SECRET_ACCESS_KEY', mode: 'deny' }] } } },
  };
  const { settings, warnings } = await loadSettings({ ...WHERE, files: ['/s/1.json', '/s/2.json'] }, { readFile: async (path) => JSON.stringify(sources[path]) });
  assert.deepEqual(settings.envDeny, ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY']);
  assert.equal(settings.permissions, undefined);
  assert.deepEqual(warnings, [
    'settings /s/1.json: sandbox: ignored entry {"path":"/x"}',
    'settings /s/1.json: sandbox: ignored entry {"name":"PATH","mode":"allow"}',
    `settings /s/1.json: ${SANDBOX_NOTICE}`,
    `settings /s/2.json: ${SANDBOX_NOTICE}`,
  ]);
});

test('a malformed sandbox shape under enabled: true is fatal, as settings <path>: <message>', async () => {
  const fatal = [
    [{ filesystem: [] }, 'sandbox.filesystem is not an object'],
    [{ credentials: 'x' }, 'sandbox.credentials is not an object'],
    [{ filesystem: { denyRead: '~/.ssh' } }, 'sandbox.filesystem.denyRead is not an array'],
    [{ filesystem: { denyWrite: [3] } }, 'sandbox.filesystem.denyWrite[0] is not a string'],
    [{ filesystem: { denyRead: ['/a(b'] } }, 'sandbox.filesystem.denyRead[0] "/a(b": unbalanced parenthesis'],
    [{ filesystem: { denyRead: [''] } }, 'sandbox.filesystem.denyRead[0] "": empty () on Read'],
    [{ credentials: { files: {} } }, 'sandbox.credentials.files is not an array'],
    [{ credentials: { files: ['/x'] } }, 'sandbox.credentials.files[0] is not an object'],
    [{ credentials: { files: [{ path: 1, mode: 'deny' }] } }, 'sandbox.credentials.files[0].path is not a string'],
    [{ credentials: { files: [{ path: 1, mode: 'allow' }] } }, 'sandbox.credentials.files[0].path is not a string'],
    [{ credentials: { envVars: [null] } }, 'sandbox.credentials.envVars[0] is not an object'],
    [{ credentials: { envVars: [{ mode: 'deny' }] } }, 'sandbox.credentials.envVars[0].name is not a string'],
  ];
  for (const [block, message] of fatal) {
    await assert.rejects(load({ sandbox: { enabled: true, ...block } }), { message: `settings /s/1.json: ${message}` }, message);
  }
});
