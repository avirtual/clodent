import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPACT_PROMPT, compactPrompt, RELOAD_BUDGET_BYTES, reloadPaths, SUMMARY_PREFIX } from '../../src/agent/compact.js';
import { createAgent } from '../../src/agent/loop.js';
import { createLedger } from '../../src/cost/ledger.js';
import { emptyOutcome } from '../../src/hooks/fire.js';
import { createGuard } from '../../src/permissions/guard.js';
import { loadSettings } from '../../src/settings/load.js';
import { createRead } from '../../src/tools/read.js';
import { writeSettings } from '../helpers/run-main.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';
import { sse } from '../helpers/sse-builder.js';
import { plant, useTempDir } from '../tools/tmp-dir.js';

const RELOAD_ASK =
  'End the summary with a line `Files to reload:` followed by up to 5 file paths, one per line, most important first: the files the next context needs in full to continue. Write `Files to reload: none` if there are none.';
const MANUAL = { instructions: '', trigger: 'manual' };
const HISTORY = [
  { role: 'user', content: [{ type: 'text', text: 'go' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
];
const text = (value) => ({ type: 'text', text: value });
const reply = (value, usage) => ({ body: sse({ blocks: [{ type: 'text', text: value }], usage }) });
const use = (name, input, id) => ({ type: 'tool_use', id, name, input });
const fileBlock = (path, output) => text(`Contents of ${path} at compact time (Read tool output):\n\n${output}`);
const pick = (summary, { history = [], count = 5, cwd = '/w' } = {}) => reloadPaths(summary, history, { cwd, count });

function harness(responses, { cwd, permissions, compactReloadFiles = 5, permission = 'yolo', history = HISTORY, tools = [createRead()], context = {}, ask, pre = () => ({}) } = {}) {
  const events = [];
  const fired = [];
  const preInputs = [];
  const raw = [];
  const asked = [];
  const inner = createFakeFetch(responses);
  const fetch = (url, init) => {
    raw.push(init.body);
    return inner(url, init);
  };
  const hooks = {
    async fire(event, extra) {
      fired.push(event);
      if (event !== 'PreToolUse') return { ...emptyOutcome(), additionalContext: context[event] ?? [] };
      preInputs.push(extra);
      return { ...emptyOutcome(), ...pre(extra) };
    },
  };
  const agent = createAgent(
    {
      model: 'claude-opus-5-5',
      system: 'sys',
      tools,
      permission,
      history,
      compactReloadFiles,
      ask: ask && ((request) => (asked.push(request), { allow: true })),
    },
    {
      fetch,
      env: { ANTHROPIC_API_KEY: 'k' },
      cwd,
      sleep: async () => {},
      random: () => 0.5,
      now: () => 0,
      ledger: createLedger({}, {}),
      hooks,
      guard: permissions ? createGuard(permissions) : undefined,
      emit: (event) => events.push(event),
    },
  );
  const compacted = () => events.find((event) => event.type === 'compacted');
  return { agent, events, fired, preInputs, raw, asked, compacted };
}

async function guardFrom(settings, cwd, home = cwd) {
  const { settings: loaded } = await loadSettings({ files: [settings], cwd, home });
  return loaded.permissions;
}

test('the compact prompt is COMPACT_PROMPT at 0 files and gains the reload request at 5, before any instructions', () => {
  assert.equal(compactPrompt('', 0), COMPACT_PROMPT);
  assert.equal(compactPrompt('keep', 0), `${COMPACT_PROMPT}\n\nAdditional instructions: keep`);
  assert.equal(compactPrompt('', 5), `${COMPACT_PROMPT}\n${RELOAD_ASK}`);
  assert.equal(compactPrompt('keep', 5), `${COMPACT_PROMPT}\n${RELOAD_ASK}\n\nAdditional instructions: keep`);
});

test('at compactReloadFiles 0 the summary request is the 5-file request less the reload sentence, byte for byte, and nothing is reloaded', async (t) => {
  const cwd = await useTempDir(t);
  await plant(cwd, { 'a.js': 'alpha' });
  const summary = 'S\nFiles to reload:\na.js';
  const off = harness([reply(summary)], { cwd, compactReloadFiles: 0 });
  const on = harness([reply(summary)], { cwd, compactReloadFiles: 5 });
  assert.equal((await off.agent.compact(MANUAL)).ok, true);
  assert.equal((await on.agent.compact(MANUAL)).ok, true);
  assert.equal(off.raw[0], on.raw[0].replace(JSON.stringify(`\n${RELOAD_ASK}`).slice(1, -1), ''));
  assert.equal(JSON.parse(off.raw[0]).messages.at(-1).content.at(-1).text, COMPACT_PROMPT);
  assert.deepEqual([off.compacted().reloaded, off.compacted().skipped], [[], []]);
  assert.deepEqual(off.agent.messages(), [{ role: 'user', content: [text(`${SUMMARY_PREFIX}${summary}`)] }]);
});

test('the paths under "Files to reload:" are picked in order, up to the first blank line', () => {
  const summary = 'Work so far.\n\nFiles to reload:\n/w/src/a.js\n/w/src/b.js\n\n/w/after-blank.js';
  assert.deepEqual(pick(summary), ['/w/src/a.js', '/w/src/b.js']);
});

test('"Files to reload: none", in any case, picks nothing and skips the fallback', () => {
  const history = [{ role: 'assistant', content: [use('Read', { file_path: 'x.js' }, 't1')] }];
  for (const line of ['Files to reload: none', '  Files to reload:   NONE  ']) {
    assert.deepEqual(pick(`S\n${line}\n/w/listed.js`, { history }), [], line);
  }
});

test('"`Files to reload: none`", copied with the request\'s backticks, picks nothing and skips the fallback', () => {
  const history = [{ role: 'assistant', content: [use('Read', { file_path: 'x.js' }, 't1')] }];
  for (const line of ['`Files to reload: none`', '**Files to reload:** none']) {
    assert.deepEqual(pick(`S\n${line}`, { history }), [], line);
  }
});

test('a heading wrapped in ** or led by # still heads the list below it', () => {
  assert.deepEqual(pick('S\n**Files to reload:**\nsrc/a.js\nsrc/b.js'), ['/w/src/a.js', '/w/src/b.js']);
  assert.deepEqual(pick('S\n## Files to reload:\nsrc/a.js'), ['/w/src/a.js']);
});

test('"none" is matched after the inline text is cleaned', () => {
  const history = [{ role: 'assistant', content: [use('Read', { file_path: 'x.js' }, 't1')] }];
  for (const line of ['Files to reload: `none`', 'Files to reload: - none']) {
    assert.deepEqual(pick(`S\n${line}`, { history }), [], line);
  }
});

test('one leading "- " or "* " and surrounding backticks are stripped, and entries left empty are dropped', () => {
  const summary = 'Files to reload:\n- `src/a.js`\n  * src/b.js\n`src/c.js`\n- ``\n-   src/d.js  ';
  assert.deepEqual(pick(summary), ['/w/src/a.js', '/w/src/b.js', '/w/src/c.js', '/w/src/d.js']);
});

test('blank lines right after a bare heading are skipped, and a section left empty that is not "none" falls back to the history', () => {
  const history = [{ role: 'assistant', content: [use('Read', { file_path: 'x.js' }, 't1')] }];
  assert.deepEqual(pick('S\n**Files to reload:**\n\n  \nsrc/a.js\nsrc/b.js\n\nlater.js', { history }), ['/w/src/a.js', '/w/src/b.js']);
  for (const summary of ['S\nFiles to reload:', 'S\n## Files to reload:\n\n\n', 'S\nFiles to reload:\n- ``\n']) {
    assert.deepEqual(pick(summary, { history }), ['/w/x.js'], JSON.stringify(summary));
  }
});

test('a backtick or * run right after the colon of a wrapped heading is its closing mark, so the path or "none" after it is kept whole', () => {
  const history = [{ role: 'assistant', content: [use('Read', { file_path: 'x.js' }, 't1')] }];
  assert.deepEqual(pick('S\n`Files to reload:` `src/a.js`', { history }), ['/w/src/a.js']);
  assert.deepEqual(pick('S\n`**Files to reload:**` none', { history }), []);
});

test('runs of 40k backticks or asterisks in the list or on the heading line parse in linear time', () => {
  const ticks = '`'.repeat(40000);
  const stars = '*'.repeat(40000);
  for (const summary of [`S\nFiles to reload:\n${ticks}x`, `S\n\`Files to reload: x${ticks}y`, `S\n**Files to reload:** x${stars}y`]) {
    let best = Infinity;
    for (let attempt = 0; attempt < 3 && best >= 50; attempt++) {
      const started = performance.now();
      pick(summary);
      best = Math.min(best, performance.now() - started);
    }
    assert.ok(best < 50, `${best.toFixed(1)} ms for ${summary.slice(0, 24)}`);
  }
});

test('a relative path resolves against the working directory', () => {
  assert.deepEqual(pick('Files to reload:\nsrc/a.js\n../up.txt\n/abs/b.js', { cwd: '/w/proj' }), ['/w/proj/src/a.js', '/w/up.txt', '/abs/b.js']);
});

test('paths naming one file are deduplicated after resolving', () => {
  assert.deepEqual(pick('Files to reload:\nsrc/a.js\n./src/a.js\n/w/src/a.js\nsrc/b.js'), ['/w/src/a.js', '/w/src/b.js']);
});

test('at most compactReloadFiles paths are kept, counted after deduplication', () => {
  const summary = 'Files to reload:\n1.js\n1.js\n2.js\n3.js\n4.js';
  assert.deepEqual(pick(summary, { count: 3 }), ['/w/1.js', '/w/2.js', '/w/3.js']);
  assert.deepEqual(pick(summary, { count: 0 }), []);
});

test('the last of two "Files to reload:" sections wins', () => {
  assert.deepEqual(pick('Files to reload:\n/w/old.js\n\nMore notes.\nFiles to reload:\n/w/new.js'), ['/w/new.js']);
});

test('a path written inline after "Files to reload:" is the first one, cleaned like the lines below it, and both are reloaded in order', async (t) => {
  assert.deepEqual(pick('Files to reload: - `src/a.js`  \nsrc/b.js'), ['/w/src/a.js', '/w/src/b.js']);
  const cwd = await useTempDir(t);
  await plant(cwd, { 'src/a.js': 'alpha', 'src/b.js': 'beta' });
  const h = harness([reply('S\nFiles to reload: src/a.js\nsrc/b.js')], { cwd, compactReloadFiles: 5 });
  assert.equal((await h.agent.compact(MANUAL)).ok, true);
  assert.deepEqual(h.compacted().reloaded.map((file) => file.path), [join(cwd, 'src/a.js'), join(cwd, 'src/b.js')]);
  assert.deepEqual(h.compacted().skipped, []);
});

test('with no section, the Read, Edit and Write file_path of the history are picked, most recent first', () => {
  const history = [
    { role: 'user', content: [text('go')] },
    { role: 'assistant', content: [use('Read', { file_path: 'a.js' }, 't1'), use('Edit', { file_path: 'b.js' }, 't2')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
    {
      role: 'assistant',
      content: [use('Grep', { file_path: 'grep.js' }, 't3'), use('Bash', { command: 'cat z.js' }, 't4'), use('Write', { file_path: 'c.js' }, 't5'), use('Read', { file_path: 'a.js' }, 't6')],
    },
  ];
  const summary = 'A summary that names no list. See the Files to reload: section below.';
  assert.deepEqual(pick(summary, { history }), ['/w/a.js', '/w/c.js', '/w/b.js']);
  assert.deepEqual(pick(summary, { history, count: 2 }), ['/w/a.js', '/w/c.js']);
});

test('the named files are re-read into text blocks after the unchanged summary block; only PreToolUse fires for them, as for a model Read, and no tool or permission event', async (t) => {
  const cwd = await useTempDir(t);
  await plant(cwd, { 'src/a.js': 'alpha\n', 'notes.md': 'beta\ngamma\n' });
  const summary = 'Did things.\nFiles to reload:\n- src/a.js\n- notes.md';
  const usage = { input_tokens: 100, output_tokens: 9 };
  const h = harness([reply(summary, usage), reply('next')], { cwd, context: { SessionStart: ['briefing'] } });
  const outcome = await h.agent.compact(MANUAL);
  assert.deepEqual([outcome.ok, outcome.postTokens], [true, 9]);
  const a = join(cwd, 'src/a.js');
  const notes = join(cwd, 'notes.md');
  const message = { role: 'user', content: [text(`${SUMMARY_PREFIX}${summary}`), fileBlock(a, '     1\talpha'), fileBlock(notes, '     1\tbeta\n     2\tgamma')] };
  assert.deepEqual(h.agent.messages(), [message]);
  const { reloaded, skipped, message: recorded } = h.compacted();
  assert.deepEqual(reloaded, [
    { path: a, bytes: Buffer.byteLength('     1\talpha') },
    { path: notes, bytes: Buffer.byteLength('     1\tbeta\n     2\tgamma') },
  ]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(recorded, message);
  assert.deepEqual(h.fired, ['PreCompact', 'PreToolUse', 'PreToolUse', 'SessionStart']);
  assert.deepEqual(h.preInputs, [
    { tool_name: 'Read', tool_input: { file_path: a }, tool_use_id: 'compact-reload-1' },
    { tool_name: 'Read', tool_input: { file_path: notes }, tool_use_id: 'compact-reload-2' },
  ]);
  assert.deepEqual(h.events.map((event) => event.type), ['session_start', 'request_start', 'compacted']);
  await h.agent.runTurn('next');
  const sent = JSON.parse(h.raw[1]).messages;
  assert.deepEqual(sent.length, 1);
  assert.deepEqual(sent[0].content.map((block) => block.text), [...message.content.map((block) => block.text), '<hook-context event="SessionStart">\nbriefing\n</hook-context>', 'next']);
});

test('a Read a PreToolUse hook denied is left out of the fallback, and a summary naming it gets it skipped as hook, so its content goes nowhere', async (t) => {
  const cwd = await useTempDir(t);
  await plant(cwd, { '.env': 'MARKER-HOOK-DENIED', 'ok.txt': 'fine' });
  const reads = { body: sse({ blocks: [use('Read', { file_path: '.env' }, 'toolu_1'), use('Read', { file_path: 'ok.txt' }, 'toolu_2')], stopReason: 'tool_use' }) };
  const pre = (extra) => (extra.tool_input.file_path.endsWith('.env') ? { decision: 'deny', reason: 'no .env' } : {});
  const h = harness([reads, reply('done'), reply('S'), reply('S2\nFiles to reload:\n.env\nok.txt'), reply('next')], { cwd, permission: 'ask', ask: true, pre });
  await h.agent.runTurn('read both');
  assert.deepEqual(h.agent.messages().at(-2).content.map((block) => [block.tool_use_id, block.is_error]), [['toolu_1', true], ['toolu_2', false]]);
  assert.equal((await h.agent.compact(MANUAL)).ok, true);
  assert.equal((await h.agent.compact(MANUAL)).ok, true);
  await h.agent.runTurn('next');
  const [fallback, named] = h.events.filter((event) => event.type === 'compacted');
  assert.deepEqual([fallback.reloaded.map((file) => file.path), fallback.skipped], [[join(cwd, 'ok.txt')], []]);
  assert.deepEqual([named.reloaded.map((file) => file.path), named.skipped], [[join(cwd, 'ok.txt')], [{ path: join(cwd, '.env'), reason: 'hook' }]]);
  assert.deepEqual(h.asked, []);
  for (const where of [h.raw.join(''), JSON.stringify(h.events), JSON.stringify(h.agent.messages())]) {
    assert.equal(where.includes('MARKER-HOOK-DENIED'), false);
  }
});

test('a PreToolUse ask skips the file as hook without asking, in the ask mode and under yolo, and fires no Notification', async (t) => {
  const cwd = await useTempDir(t);
  await plant(cwd, { 'asked.txt': 'ASKED', 'ok.txt': 'fine' });
  const pre = (extra) => (extra.tool_input.file_path.endsWith('asked.txt') ? { decision: 'ask' } : {});
  for (const permission of ['ask', 'yolo']) {
    const h = harness([reply('S\nFiles to reload:\nasked.txt\nok.txt')], { cwd, permission, ask: true, pre });
    assert.equal((await h.agent.compact(MANUAL)).ok, true, permission);
    assert.deepEqual(h.compacted().skipped, [{ path: join(cwd, 'asked.txt'), reason: 'hook' }], permission);
    assert.deepEqual(h.compacted().reloaded.map((file) => file.path), [join(cwd, 'ok.txt')], permission);
    assert.deepEqual([h.asked, h.fired], [[], ['PreCompact', 'PreToolUse', 'PreToolUse', 'SessionStart']], permission);
  }
});

test('a PreToolUse updatedInput replaces the reload Read input, and the settings rules screen the input that would run', async (t) => {
  const cwd = await useTempDir(t);
  await plant(cwd, { 'a.txt': 'ORIGINAL', 'redacted.txt': 'REDACTED', 'secret.txt': 'MARKER-REWRITTEN-DENY' });
  const permissions = await guardFrom(writeSettings(cwd, { permissions: { deny: ['Read(./secret.txt)'] } }), cwd);
  const targets = { 'a.txt': 'redacted.txt', 'b.txt': 'secret.txt' };
  const pre = (extra) => {
    const name = Object.keys(targets).find((key) => extra.tool_input.file_path.endsWith(key));
    return name ? { updatedInput: { file_path: join(cwd, targets[name]) } } : {};
  };
  const h = harness([reply('S\nFiles to reload:\na.txt\nb.txt')], { cwd, permissions, pre });
  assert.equal((await h.agent.compact(MANUAL)).ok, true);
  assert.deepEqual(h.agent.messages()[0].content.slice(1), [fileBlock(join(cwd, 'a.txt'), '     1\tREDACTED')]);
  assert.deepEqual(h.compacted().skipped, [{ path: join(cwd, 'b.txt'), reason: 'denied' }]);
});

test('an interrupt during a reload PreToolUse hook skips that file and the rest as interrupted', async (t) => {
  const cwd = await useTempDir(t);
  await plant(cwd, { 'a.txt': 'a', 'b.txt': 'b' });
  const controller = new AbortController();
  const h = harness([reply('S\nFiles to reload:\na.txt\nb.txt')], { cwd, pre: () => (controller.abort(), {}) });
  assert.equal((await h.agent.compact(MANUAL, { signal: controller.signal })).ok, true);
  assert.deepEqual(h.compacted().reloaded, []);
  assert.deepEqual(h.compacted().skipped, [
    { path: join(cwd, 'a.txt'), reason: 'interrupted' },
    { path: join(cwd, 'b.txt'), reason: 'interrupted' },
  ]);
});

test('a path a settings permissions.deny rule matches is skipped as denied, and its content goes nowhere', async (t) => {
  const cwd = await useTempDir(t);
  await plant(cwd, { 'secret/key.txt': 'MARKER-PERMISSIONS-DENY', 'ok.txt': 'fine' });
  const permissions = await guardFrom(writeSettings(cwd, { permissions: { deny: ['Read(./secret)'] } }), cwd);
  const h = harness([reply('S\nFiles to reload:\nsecret/key.txt\nok.txt'), reply('next')], { cwd, permissions });
  assert.equal((await h.agent.compact(MANUAL)).ok, true);
  await h.agent.runTurn('next');
  assert.deepEqual(h.compacted().skipped, [{ path: join(cwd, 'secret/key.txt'), reason: 'denied' }]);
  assert.deepEqual(h.compacted().reloaded.map((file) => file.path), [join(cwd, 'ok.txt')]);
  assert.equal(h.agent.messages()[0].content.length, 3);
  for (const where of [h.raw.join(''), JSON.stringify(h.events), JSON.stringify(h.agent.messages())]) {
    assert.equal(where.includes('MARKER-PERMISSIONS-DENY'), false);
  }
});

test('with a settings deny of bare Read, which removes the Read tool, the summary request asks for no list and nothing is reloaded', async (t) => {
  const cwd = await useTempDir(t);
  await plant(cwd, { 'a.js': 'alpha' });
  const permissions = await guardFrom(writeSettings(cwd, { permissions: { deny: ['Read'] } }), cwd);
  const tools = [createRead()].filter((tool) => !createGuard(permissions).removes(tool.name));
  assert.deepEqual(tools, []);
  const summary = 'S\nFiles to reload:\na.js';
  const h = harness([reply(summary)], { cwd, permissions, tools, compactReloadFiles: 5 });
  assert.equal((await h.agent.compact(MANUAL)).ok, true);
  const asked = JSON.parse(h.raw[0]).messages.at(-1).content.at(-1).text;
  assert.equal(asked.includes('Files to reload'), false);
  assert.equal(asked, COMPACT_PROMPT);
  assert.deepEqual([h.compacted().reloaded, h.compacted().skipped], [[], []]);
  assert.deepEqual(h.agent.messages(), [{ role: 'user', content: [text(`${SUMMARY_PREFIX}${summary}`)] }]);
});

test('paths only the settings sandbox block denies (denyRead, credentials.files) are skipped as denied, under yolo, and their content goes nowhere', async (t) => {
  const cwd = await useTempDir(t);
  const user = await useTempDir(t);
  const fixture = readFileSync(new URL('../permissions/fixtures/clodex-guarded-settings.json', import.meta.url), 'utf8').replaceAll('/Users/<user>', user);
  const guarded = JSON.parse(fixture);
  assert.equal(guarded.sandbox.enabled, true);
  guarded.sandbox.filesystem.denyRead.push(join(user, 'vault'));
  guarded.sandbox.credentials.files.push({ path: join(user, 'creds/token'), mode: 'deny' });
  await plant(user, { 'vault/k.txt': 'MARKER-SANDBOX-READ', 'creds/token': 'MARKER-SANDBOX-CRED', 'open/o.txt': 'OPEN-CONTENT' });
  const permissions = await guardFrom(writeSettings(cwd, guarded), cwd, user);
  const listed = [join(user, 'vault/k.txt'), join(user, 'creds/token'), join(user, 'open/o.txt')];
  const h = harness([reply(`S\nFiles to reload:\n${listed.join('\n')}`), reply('next')], { cwd, permissions });
  assert.equal((await h.agent.compact(MANUAL)).ok, true);
  await h.agent.runTurn('next');
  assert.deepEqual(h.compacted().skipped, [
    { path: listed[0], reason: 'denied' },
    { path: listed[1], reason: 'denied' },
  ]);
  assert.deepEqual(h.compacted().reloaded.map((file) => file.path), [listed[2]]);
  const everywhere = [h.raw.join(''), JSON.stringify(h.events), JSON.stringify(h.agent.messages())].join('\n');
  assert.equal(everywhere.includes('OPEN-CONTENT'), true);
  for (const marker of ['MARKER-SANDBOX-READ', 'MARKER-SANDBOX-CRED']) assert.equal(everywhere.includes(marker), false, marker);
});

test('a path an ask rule matches is skipped as ask without asking in the ask mode; under yolo, which never asks, it is reloaded', async (t) => {
  const cwd = await useTempDir(t);
  await plant(cwd, { 'asked.txt': 'ASKED' });
  const permissions = await guardFrom(writeSettings(cwd, { permissions: { ask: ['Read(./asked.txt)'] } }), cwd);
  const asking = harness([reply('S\nFiles to reload:\nasked.txt')], { cwd, permissions, permission: 'ask', ask: true });
  assert.equal((await asking.agent.compact(MANUAL)).ok, true);
  assert.deepEqual(asking.compacted().skipped, [{ path: join(cwd, 'asked.txt'), reason: 'ask' }]);
  assert.deepEqual(asking.asked, []);
  assert.deepEqual(asking.fired, ['PreCompact', 'PreToolUse', 'SessionStart']);
  assert.equal(asking.events.some((event) => event.type === 'permission_request'), false);
  const yolo = harness([reply('S\nFiles to reload:\nasked.txt')], { cwd, permissions });
  assert.equal((await yolo.agent.compact(MANUAL)).ok, true);
  assert.deepEqual(yolo.compacted().reloaded.map((file) => file.path), [join(cwd, 'asked.txt')]);
});

test('a missing file and a directory are skipped with the Read error text', async (t) => {
  const cwd = await useTempDir(t);
  await plant(cwd, { 'src/a.js': 'a' });
  const h = harness([reply('S\nFiles to reload:\ngone.txt\nsrc')], { cwd });
  assert.equal((await h.agent.compact(MANUAL)).ok, true);
  const gone = join(cwd, 'gone.txt');
  const dir = join(cwd, 'src');
  assert.deepEqual(h.compacted().skipped, [
    { path: gone, reason: `File does not exist: ${gone}` },
    { path: dir, reason: `${dir} is a directory, not a file` },
  ]);
  assert.deepEqual(h.agent.messages()[0].content.length, 1);
});

test('a file that would push the Read output past 64 KiB is skipped as budget, a later smaller one still fits, and hook context is not counted', async (t) => {
  const cwd = await useTempDir(t);
  const big = `${'x'.repeat(99)}\n`.repeat(400);
  await plant(cwd, { 'big1.txt': big, 'big2.txt': big, 'small.txt': 'small' });
  const context = { SessionStart: ['y'.repeat(RELOAD_BUDGET_BYTES)] };
  const h = harness([reply('S\nFiles to reload:\nbig1.txt\nbig2.txt\nsmall.txt')], { cwd, context });
  assert.equal((await h.agent.compact(MANUAL)).ok, true);
  const { reloaded, skipped } = h.compacted();
  assert.deepEqual(reloaded.map((file) => file.path), [join(cwd, 'big1.txt'), join(cwd, 'small.txt')]);
  assert.deepEqual(skipped, [{ path: join(cwd, 'big2.txt'), reason: 'budget' }]);
  assert.ok(reloaded[0].bytes > 32768 && reloaded[0].bytes * 2 > RELOAD_BUDGET_BYTES, String(reloaded[0].bytes));
  assert.ok(reloaded[0].bytes + reloaded[1].bytes <= RELOAD_BUDGET_BYTES);
});

test('an interrupt while files are read stops the remaining reads, and the compact still succeeds with the files read', async (t) => {
  const cwd = await useTempDir(t);
  await plant(cwd, { 'a.txt': 'a', 'b.txt': 'b' });
  const controller = new AbortController();
  const read = createRead();
  const tools = [{ ...read, run: async (input, ctx) => (controller.abort(), read.run(input, ctx)) }];
  const h = harness([reply('S\nFiles to reload:\na.txt\nb.txt')], { cwd, tools });
  assert.equal((await h.agent.compact(MANUAL, { signal: controller.signal })).ok, true);
  assert.deepEqual(h.compacted().reloaded.map((file) => file.path), [join(cwd, 'a.txt')]);
  assert.deepEqual(h.compacted().skipped, [{ path: join(cwd, 'b.txt'), reason: 'interrupted' }]);
  assert.equal(h.agent.messages()[0].content.length, 2);
});
