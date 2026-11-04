import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { INTERRUPT_MARKER } from '../../src/agent/loop.js';
import { PASTE_END, PASTE_START } from '../../src/repl/keys.js';
import { ASK_LINE, EXIT_HINT, PASTE_OFF, PASTE_ON, QUEUED_NOTE } from '../../src/repl/repl.js';
import { HELP } from '../../src/repl/slash.js';
import { INTERRUPT_TEXT } from '../../src/session/transcript.js';
import { transcriptPath } from '../../src/session/paths.js';
import { hookGroup, readJsonl, textReply, toolsReply, writeSettings } from '../helpers/run-main.js';
import { hookOutput, script } from '../hooks/scripts.js';
import { useTempDir } from '../tools/tmp-dir.js';
import { count, startRepl, userTexts } from './harness.js';

const GUARD = { timeout: 5000 };
const TOTAL_LINE = /^\[clay:cost\] session total \$\d+\.\d{4} /m;

async function dirs(t) {
  return { home: await useTempDir(t), cwd: await useTempDir(t), dir: await useTempDir(t) };
}

function pasted(text) {
  return `${PASTE_START}${text.replaceAll('\n', '\r')}${PASTE_END}`;
}

async function exitWith(repl, bytes) {
  repl.stdin.type(bytes);
  return repl.done;
}

function assertCleanExit(repl, code) {
  assert.equal(code, 0);
  assert.match(repl.out.text, TOTAL_LINE);
  assert.ok(repl.out.text.endsWith(PASTE_OFF), JSON.stringify(repl.out.text.slice(-80)));
  assert.deepEqual(repl.stdin.rawModes, [true, false]);
  assert.equal(repl.stdin.listenerCount('data'), 0);
  assert.equal(repl.stdin.listenerCount('end'), 0);
  assert.equal(repl.stdin.listenerCount('error'), 0);
  assert.equal(repl.stdin.paused, true);
  assert.deepEqual(repl.signals, {});
}

test('boot prints the session line, runs SessionStart (startup), then shows the first prompt; its context reaches the first request', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const log = join(dir, 'start.jsonl');
  const hook = await script(dir, 'start.sh', `cat >> ${JSON.stringify(log)}\n${hookOutput({ hookEventName: 'SessionStart', additionalContext: 'boot context' })}`);
  const settings = writeSettings(dir, { effortLevel: 'xhigh', hooks: { SessionStart: [hookGroup('', hook)] } });
  const repl = startRepl(['--settings', settings], { home, cwd, replies: [textReply('hello')] });
  repl.stdin.type('early');
  await repl.prompts(1);
  const [id] = repl.sessionIds();
  const warning = `clay: settings ${settings}: effortLevel "xhigh" is not low, medium or high; ignored`;
  assert.ok(repl.out.text.startsWith(`[clay:session] ${id}\n${warning}\n${PASTE_ON}> early`), JSON.stringify(repl.out.text));
  assert.equal(repl.err.text, '');
  assert.deepEqual(readJsonl(log).map((input) => [input.hook_event_name, input.source]), [['SessionStart', 'startup']]);
  repl.stdin.type(' hi\r');
  await repl.prompts(2);
  assert.deepEqual(userTexts(repl.fetch.calls[0].body), ['<hook-context event="SessionStart">\nboot context\n</hook-context>', 'early hi']);
  assert.match(repl.out.text, /\nhello\n\[clay:cost\] \$/);
  assertCleanExit(repl, await exitWith(repl, '\x04'));
});

test('a 3-line paste then \\r is one request with the lines joined by \\n, echoed as a placeholder', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl([], { home, cwd, replies: [textReply('ok')] });
  await repl.prompts(1);
  repl.stdin.type(pasted('[agent:from x] one\ntwo\nthree'));
  repl.stdin.type('\r');
  await repl.prompts(2);
  assert.equal(repl.fetch.calls.length, 1);
  assert.deepEqual(userTexts(repl.fetch.calls[0].body), ['[agent:from x] one\ntwo\nthree']);
  assert.ok(repl.out.text.includes(`${PASTE_ON}> [pasted text, 3 lines]\n`));
  assert.equal(repl.out.text.includes('two'), false);
  assert.equal(repl.out.text.includes('[agent:from x]'), false);
  assertCleanExit(repl, await exitWith(repl, '\x04'));
});

test('^U clears the buffer, ^W drops a word, and backspace after a paste removes the whole paste', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl([], { home, cwd, replies: [textReply('a'), textReply('b'), textReply('c')] });
  await repl.prompts(1);
  repl.stdin.type('abc\x15def\r');
  await repl.prompts(2);
  repl.stdin.type(`keep ${pasted('p1\np2')}\x7fend\r`);
  await repl.prompts(3);
  repl.stdin.type('one two\x17three\x7f\x7fee\r');
  await repl.prompts(4);
  assert.deepEqual(repl.fetch.calls.map((call) => userTexts(call.body).at(-1)), ['def', 'keep end', 'one three']);
  assertCleanExit(repl, await exitWith(repl, '\x04'));
});

test('submissions entered during a running turn run as later turns, in FIFO order, after the first turn ends', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl([], { home, cwd });
  await repl.prompts(1);
  repl.stdin.type('first\r');
  await repl.fetch.called(1);
  repl.stdin.type('second\r');
  repl.stdin.type(pasted('third\nline'));
  repl.stdin.type('\r');
  for (const text of ['r1', 'r2', 'r3']) repl.fetch.push(textReply(text));
  await repl.prompts(4);
  const texts = repl.fetch.calls.map((call) => call.body.messages.flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text)));
  assert.deepEqual(texts, [['first'], ['first', 'r1', 'second'], ['first', 'r1', 'second', 'r2', 'third\nline']]);
  const screen = repl.out.text;
  assert.equal(screen.indexOf('second'), screen.indexOf(`${PASTE_ON}> second\n`) + PASTE_ON.length + 2);
  assert.ok(screen.indexOf('r1\n') < screen.indexOf('> second\n'));
  assert.ok(screen.indexOf('r2\n') < screen.indexOf('> third [+1 lines]\n'));
  assertCleanExit(repl, await exitWith(repl, '\x04'));
});

test('^C during a held request interrupts the turn; the next prompt shows and the next request starts with INTERRUPT_MARKER', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl([], { home, cwd });
  await repl.prompts(1);
  repl.stdin.type('go\r');
  await repl.fetch.called(1);
  repl.stdin.type('\x03');
  await repl.prompts(2);
  assert.match(repl.out.text, /^clay: interrupted$/m);
  const records = readJsonl(transcriptPath(home, cwd, repl.sessionIds()[0]));
  assert.ok(records.some((r) => r.type === 'user' && r.message.content[0]?.text === INTERRUPT_TEXT && r.isVisibleInTranscriptOnly === true));
  repl.fetch.push(textReply('ok'));
  repl.stdin.type('next\r');
  await repl.prompts(3);
  const last = repl.fetch.calls[1].body.messages.at(-1);
  assert.deepEqual(userTexts(repl.fetch.calls[1].body).slice(-2), [INTERRUPT_MARKER, 'next']);
  assert.equal(last.role, 'user');
  repl.stdin.type('more\r');
  await repl.fetch.called(3);
  repl.signals.SIGINT();
  await repl.prompts(4);
  assert.equal(repl.out.text.split('clay: interrupted').length - 1, 2);
  assertCleanExit(repl, await exitWith(repl, '\x04'));
});

test('^C ^C at an empty prompt, ^D, /quit, /exit and stdin end each exit 0 with the session total and restore the terminal', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const ways = [
    ['abc\x04\x03\x03', '\x03'],
    ['\x04'],
    ['/quit\r'],
    ['/exit\r'],
    [null],
  ];
  for (const steps of ways) {
    const repl = startRepl([], { home, cwd });
    await repl.prompts(1);
    for (const [i, bytes] of steps.entries()) {
      if (bytes === null) repl.stdin.close();
      else repl.stdin.type(bytes);
      if (i < steps.length - 1) await repl.prompts(i + 2);
    }
    assertCleanExit(repl, await repl.done);
    assert.equal(repl.fetch.calls.length, 0);
  }
  const repl = startRepl([], { home, cwd, isTTY: false });
  await repl.prompts(1);
  repl.stdin.type('\x03\x03');
  assert.equal(await repl.done, 0);
  assert.ok(repl.out.text.includes(`\n${EXIT_HINT}\n${PASTE_ON}> \n`));
  assert.deepEqual(repl.stdin.rawModes, []);
});

test('another key between two Ctrl-Cs cancels the pending exit: ^C x ^U ^C shows the hint twice and keeps running', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl([], { home, cwd });
  await repl.prompts(1);
  repl.stdin.type('\x03x\x15\x03');
  await repl.until(EXIT_HINT, 2);
  repl.stdin.type('/cost\r');
  await repl.prompts(4);
  assert.match(repl.out.text, /> \/cost\n\[clay:cost\] session total /);
  assert.equal(count(repl.out.text, EXIT_HINT), 2);
  assertCleanExit(repl, await exitWith(repl, '\x04'));
});

test('a stdin EIO error ends input as stdin closing does; any other error prints clay: <message> first', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  for (const code of ['EIO', 'EBADF']) {
    const repl = startRepl([], { home, cwd });
    await repl.prompts(1);
    repl.stdin.emit('error', Object.assign(new Error(`read ${code}`), { code }));
    assertCleanExit(repl, await repl.done);
    assert.equal(count(repl.out.text, `\nclay: read ${code}\n`), code === 'EIO' ? 0 : 1, code);
  }
});

test('a turn that throws still restores the terminal and drops the listeners before the error propagates', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl([], { home, cwd });
  await repl.prompts(1);
  rmSync(dirname(transcriptPath(home, cwd, repl.sessionIds()[0])), { recursive: true });
  repl.stdin.type('hi\r');
  await assert.rejects(repl.done, { code: 'ENOENT' });
  assert.ok(repl.out.text.endsWith(PASTE_OFF), JSON.stringify(repl.out.text.slice(-80)));
  assert.deepEqual(repl.stdin.rawModes, [true, false]);
  for (const event of ['data', 'end', 'error']) assert.equal(repl.stdin.listenerCount(event), 0, event);
  assert.equal(repl.stdin.paused, true);
  assert.deepEqual(repl.signals, {});
});

test('Ctrl-C with text clears it, and ^D with text is ignored', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const repl = startRepl([], { home, cwd, replies: [textReply('ok')] });
  await repl.prompts(1);
  repl.stdin.type('abc\x04\x03xyz\r');
  await repl.prompts(2);
  assert.deepEqual(userTexts(repl.fetch.calls[0].body), ['xyz']);
  assertCleanExit(repl, await exitWith(repl, '\x04'));
});

test('slash commands: /help, /cost, /model, unknown names, and slash text that is a prompt', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const promptFile = join(dir, 'base.md');
  writeFileSync(promptFile, 'base prompt');
  const repl = startRepl(['--system-prompt-file', promptFile], { home, cwd, replies: [textReply('a'), textReply('b'), textReply('c')] });
  await repl.prompts(1);
  const steps = ['/help', '/cost', '/model', '/model claude-haiku-5-5', '/foo', '/compact', 'hi', '/Users/x/y hi', pasted('/clear')];
  for (const [i, step] of steps.entries()) {
    repl.stdin.type(`${step}\r`);
    await repl.prompts(i + 2);
  }
  const out = repl.out.text;
  assert.ok(out.includes(`> /help\n${HELP.join('\n')}\n`));
  assert.match(out, /> \/cost\n\[clay:cost\] session total \$0\.0000 \(in 0, cache-read 0, cache-write 0, out 0, requests 0\)\n/);
  assert.ok(out.includes('> /model\nclay: model claude-opus-5-5\n'));
  assert.ok(out.includes('> /model claude-haiku-5-5\nclay: model claude-haiku-5-5\n'));
  assert.ok(out.includes('> /foo\nclay: unknown command /foo (try /help)\n'));
  assert.ok(out.includes('> /compact\nclay: nothing to compact\n'));
  const calls = repl.fetch.calls;
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => userTexts(call.body).at(-1)), ['hi', '/Users/x/y hi', '/clear']);
  for (const call of calls) {
    assert.equal(call.body.model, 'claude-haiku-5-5');
    const system = call.body.system.map((block) => block.text).join('\n');
    assert.match(system, /Model: claude-haiku-5-5/);
    assert.equal(system.includes('claude-opus-5-5'), false);
  }
  assert.equal(repl.sessionIds().length, 1);
  rmSync(promptFile);
  repl.stdin.type('/model claude-sonnet-5-5\r');
  await repl.prompts(steps.length + 2);
  assert.match(repl.out.text, /> \/model claude-sonnet-5-5\nclay: [^\n]*base\.md[^\n]*\nclay: model claude-haiku-5-5\n/);
  assertCleanExit(repl, await exitWith(repl, '\x04'));
});

test('/clear opens a new session and transcript, fires SessionStart (clear), and the next request holds only the new prompt', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const log = join(dir, 'start.jsonl');
  const hook = await script(dir, 'start.sh', `cat >> ${JSON.stringify(log)}`);
  const settings = writeSettings(dir, { hooks: { SessionStart: [hookGroup('', hook)] } });
  const given = '11111111-2222-4333-8444-555555555555';
  const repl = startRepl(['--settings', settings, '--session-id', given], { home, cwd, replies: [textReply('a'), textReply('b')] });
  await repl.prompts(1);
  for (const [i, step] of ['one', '/clear', 'two'].entries()) {
    repl.stdin.type(`${step}\r`);
    await repl.prompts(i + 2);
  }
  const ids = repl.sessionIds();
  assert.equal(ids.length, 2);
  assert.equal(ids[0], given);
  assert.notEqual(ids[1], given);
  const paths = ids.map((id) => transcriptPath(home, cwd, id));
  assert.ok(paths.every((path) => existsSync(path)));
  const starts = readJsonl(log);
  assert.deepEqual(starts.map((input) => [input.source, input.session_id, input.transcript_path]), [
    ['startup', ids[0], paths[0]],
    ['clear', ids[1], paths[1]],
  ]);
  assert.deepEqual(repl.fetch.calls[1].body.messages.length, 1);
  assert.deepEqual(userTexts(repl.fetch.calls[1].body), ['two']);
  const second = readJsonl(paths[1]).filter((r) => r.type === 'user');
  assert.deepEqual(second.map((r) => r.message.content.at(-1).text), ['two']);
  assertCleanExit(repl, await exitWith(repl, '\x04'));
  assert.match(repl.out.text, /requests 2\)/);
});

test('/clear pushes a statusLine update with zero usage and the new session id', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const status = join(dir, 'status.jsonl');
  const settings = writeSettings(dir, { statusLine: { type: 'command', command: `cat >> ${JSON.stringify(status)}` } });
  const repl = startRepl(['--settings', settings], { home, cwd, replies: [textReply('a')] });
  await repl.prompts(1);
  repl.stdin.type('one\r');
  await repl.prompts(2);
  repl.stdin.type('/clear\r');
  await repl.prompts(3);
  assertCleanExit(repl, await exitWith(repl, '\x04'));
  const last = readJsonl(status).at(-1);
  assert.equal(last.session_id, repl.sessionIds()[1]);
  assert.equal(last.context_window.used_tokens, 0);
  assert.ok(last.cost.total_cost_usd > 0);
});

test('permission ask: [clay:permit] line and Notification hook; y allows, n denies, pastes and other lines queue, ^C interrupts', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const log = join(dir, 'notify.jsonl');
  const hook = await script(dir, 'notify.sh', `cat >> ${JSON.stringify(log)}`);
  const settings = writeSettings(dir, { hooks: { Notification: [hookGroup('', hook)] } });
  const write = (name) => toolsReply([['Write', { file_path: name, content: name }]]);
  const replies = [write('a.txt'), textReply('done a'), write('b.txt'), textReply('done b'), write('c.txt'), textReply('done c'), textReply('p'), textReply('q'), write('d.txt')];
  const repl = startRepl(['--settings', settings], { home, cwd, replies });
  await repl.prompts(1);

  repl.stdin.type('write a\r');
  await repl.until(ASK_LINE, 1);
  assert.match(repl.out.text, /\n\[clay:permit Write toolu_1\] a\.txt\nAllow\? \[y\/n\] $/);
  repl.stdin.type('Y\r');
  await repl.prompts(2);
  const [notice] = readJsonl(log);
  assert.deepEqual(
    [notice.hook_event_name, notice.notification_type, notice.tool, notice.id, notice.message],
    ['Notification', 'permission', 'Write', 'toolu_1', 'clay needs permission to use Write'],
  );
  assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'a.txt');

  repl.stdin.type('write b\r');
  await repl.until(ASK_LINE, 2);
  repl.stdin.type('\r');
  await repl.until(ASK_LINE, 3);
  repl.stdin.type('no\r');
  await repl.prompts(3);
  assert.equal(existsSync(join(cwd, 'b.txt')), false);
  const denied = repl.fetch.calls[3].body.messages.at(-1).content[0];
  assert.deepEqual([denied.type, denied.content, denied.is_error], ['tool_result', 'denied by the user', true]);

  repl.stdin.type('write c\r');
  await repl.until(ASK_LINE, 4);
  repl.stdin.type(pasted('pasted\nprompt'));
  repl.stdin.type('\r');
  await repl.until(QUEUED_NOTE, 1);
  repl.stdin.type('yes please\r');
  await repl.until(QUEUED_NOTE, 2);
  assert.equal(existsSync(join(cwd, 'c.txt')), false);
  repl.stdin.type('y\r');
  await repl.prompts(6);
  assert.equal(readFileSync(join(cwd, 'c.txt'), 'utf8'), 'c.txt');
  assert.deepEqual(repl.fetch.calls.slice(6, 8).map((call) => userTexts(call.body).at(-1)), ['pasted\nprompt', 'yes please']);
  assert.ok(repl.out.text.includes(`${PASTE_ON}> pasted [+1 lines]\n`));
  assert.equal(readJsonl(log).length, 3);

  repl.stdin.type('write d\r');
  await repl.until(ASK_LINE, 7);
  repl.stdin.type('\x03');
  await repl.prompts(7);
  assert.equal(existsSync(join(cwd, 'd.txt')), false);
  assert.match(repl.out.text, /^clay: interrupted$/m);
  assert.equal(repl.fetch.calls.length, 9);
  assertCleanExit(repl, await exitWith(repl, '\x04'));
});

test('permission ask: a y typed while the Notification hook still runs answers the ask and never reaches the model', GUARD, async (t) => {
  const { home, cwd, dir } = await dirs(t);
  const release = join(dir, 'release');
  const hook = await script(dir, 'notify.sh', `cat > /dev/null; for i in $(seq 500); do [ -e ${JSON.stringify(release)} ] && exit 0; sleep 0.01; done`);
  const settings = writeSettings(dir, { hooks: { Notification: [hookGroup('', hook)] } });
  const replies = [toolsReply([['Write', { file_path: 'a.txt', content: 'a' }]]), textReply('done')];
  const repl = startRepl(['--settings', settings], { home, cwd, replies });
  await repl.prompts(1);

  repl.stdin.type('write a\r');
  await repl.until('[clay:permit Write toolu_1]');
  assert.match(repl.out.text, /\n\[clay:permit Write toolu_1\] a\.txt\nAllow\? \[y\/n\] $/);
  repl.stdin.type('y\r');
  writeFileSync(release, '');
  await repl.prompts(2);
  assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'a');
  assertCleanExit(repl, await exitWith(repl, '\x04'));
  assert.equal(repl.fetch.calls.length, 2);
});

test('--yolo and --read-only never ask; stdin end during an ask denies with "denied: input closed"', GUARD, async (t) => {
  const { home, cwd } = await dirs(t);
  const write = toolsReply([['Write', { file_path: 'x.txt', content: 'x' }]]);
  for (const flag of ['--yolo', '--read-only']) {
    const repl = startRepl([flag], { home, cwd, replies: [write, textReply('ok')] });
    await repl.prompts(1);
    repl.stdin.type('go\r');
    await repl.prompts(2);
    assert.equal(repl.out.text.includes('[clay:permit'), false, flag);
    assertCleanExit(repl, await exitWith(repl, '\x04'));
  }
  rmSync(join(cwd, 'x.txt'));
  const repl = startRepl([], { home, cwd, replies: [write, textReply('ok')] });
  await repl.prompts(1);
  repl.stdin.type('go\r');
  await repl.until(ASK_LINE);
  repl.stdin.close();
  assertCleanExit(repl, await repl.done);
  assert.equal(existsSync(join(cwd, 'x.txt')), false);
  assert.equal(repl.fetch.calls[1].body.messages.at(-1).content[0].content, 'denied: input closed');
});
