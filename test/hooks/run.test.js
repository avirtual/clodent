import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { commandLabel, runCommand } from '../../src/hooks/command.js';
import { buildHookInput, runHooks, HOOK_EVENTS } from '../../src/hooks/run.js';
import { cleanEnv, useTempDir } from '../tools/tmp-dir.js';
import { entry, group, hookOutput, isGone, script, settingsWith } from './scripts.js';

const GUARD = { timeout: 10000 };
const deps = { spawn };
const label = (command) => command.slice(0, 60);
const ctxFor = (cwd, settings, extra = {}) => ({ settings, cwd, env: cleanEnv(), ...extra });
const UNCAPPED = { hookContextMaxBytes: { perHook: 16777216, perEvent: 16777216 } };

test('the event list is the eight Claude-host events', () => {
  assert.deepEqual(HOOK_EVENTS, ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'PreCompact', 'Stop']);
});

test('an unknown event name throws', async () => {
  await assert.rejects(runHooks('SubagentStart', {}, { settings: settingsWith({}), cwd: '/', env: {} }, deps), {
    message: 'unknown hook event: SubagentStart',
  });
});

test('buildHookInput names the fields Claude-host scripts read', () => {
  const base = { sessionId: 'sid', transcriptPath: '/t.jsonl', cwd: '/w', permissionMode: 'default' };
  const input = buildHookInput('PreToolUse', base, { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu1' });
  assert.deepEqual(input, {
    session_id: 'sid',
    transcript_path: '/t.jsonl',
    cwd: '/w',
    hook_event_name: 'PreToolUse',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'tu1',
  });
  assert.equal(Object.hasOwn(input, 'agent_id'), false);
});

test('no matching hooks gives an empty outcome', async (t) => {
  const dir = await useTempDir(t);
  assert.deepEqual(await runHooks('Stop', {}, ctxFor(dir, settingsWith({})), deps), {
    additionalContext: [],
    decision: null,
    reason: null,
    updatedInput: null,
    warnings: [],
    truncations: [],
  });
});

test('additionalContext comes back in config order even when the first command finishes last', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const fifo = join(dir, 'gate');
  execFileSync('mkfifo', [fifo]);
  const first = await script(dir, 'first.sh', `read -r line < "$GATE"\n${hookOutput({ hookEventName: 'UserPromptSubmit', additionalContext: 'first' })}`);
  const second = await script(dir, 'second.sh', `${hookOutput({ hookEventName: 'UserPromptSubmit', additionalContext: 'second' })}\necho go > "$GATE"`);
  const empty = await script(dir, 'empty.sh', hookOutput({ hookEventName: 'UserPromptSubmit', additionalContext: '' }));
  const settings = settingsWith({ UserPromptSubmit: [group('', first, empty), group('', second)] }, { env: { GATE: fifo } });
  const outcome = await runHooks('UserPromptSubmit', { prompt: 'hi' }, ctxFor(dir, settings), deps);
  assert.deepEqual(outcome.additionalContext, ['first', 'second']);
  assert.deepEqual(outcome.warnings, []);
});

test('plain stdout counts as context on UserPromptSubmit and SessionStart, and is ignored with a warning on PostToolUse', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const plain = await script(dir, 'plain.sh', 'echo "hello there"');
  const ups = await runHooks('UserPromptSubmit', {}, ctxFor(dir, settingsWith({ UserPromptSubmit: [group('', plain)] })), deps);
  assert.deepEqual(ups.additionalContext, ['hello there']);
  assert.deepEqual(ups.warnings, []);
  const start = await runHooks('SessionStart', { source: 'startup' }, ctxFor(dir, settingsWith({ SessionStart: [group('', plain)] })), deps);
  assert.deepEqual(start.additionalContext, ['hello there']);
  const post = await runHooks('PostToolUse', { tool_name: 'Bash' }, ctxFor(dir, settingsWith({ PostToolUse: [group('', plain)] })), deps);
  assert.deepEqual(post.additionalContext, []);
  assert.deepEqual(post.warnings, [`hook PostToolUse "${label(plain)}": invalid JSON ignored`]);
});

test('stdout is capped at 1 MiB with a truncation warning, and stderr at 64 KiB', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const big = await script(dir, 'big.sh', "head -c 1100000 /dev/zero | tr '\\0' a; head -c 100000 /dev/zero | tr '\\0' b >&2");
  const outcome = await runHooks('UserPromptSubmit', {}, ctxFor(dir, settingsWith({ UserPromptSubmit: [group('', big)] }, UNCAPPED)), deps);
  assert.equal(outcome.additionalContext[0], 'a'.repeat(1048576));
  assert.deepEqual(outcome.warnings, [`hook UserPromptSubmit "${label(big)}": stdout over 1 MiB truncated`]);
  const res = await runCommand(big, { cwd: dir, env: cleanEnv(), stdin: '', timeoutMs: 5000 }, deps);
  assert.deepEqual([res.stdout.length, res.stderr, res.truncated], [1048576, 'b'.repeat(65536), true]);
});

test('stdout at exactly 1 MiB is not truncated', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const exact = await script(dir, 'exact.sh', "head -c 1048576 /dev/zero | tr '\\0' a");
  const outcome = await runHooks('UserPromptSubmit', {}, ctxFor(dir, settingsWith({ UserPromptSubmit: [group('', exact)] }, UNCAPPED)), deps);
  assert.equal(outcome.additionalContext[0].length, 1048576);
  assert.deepEqual(outcome.warnings, []);
});

test('identical commands in one firing run once, their result at the first config position', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const log = join(dir, 'runs.log');
  const counted = await script(dir, 'counted.sh', `echo run >> ${JSON.stringify(log)}\n${hookOutput({ hookEventName: 'PostToolUse', additionalContext: 'counted' })}`);
  const other = await script(dir, 'other.sh', hookOutput({ hookEventName: 'PostToolUse', additionalContext: 'other' }));
  const settings = settingsWith({ PostToolUse: [group('', counted, other), group('Bash', counted)] });
  const outcome = await runHooks('PostToolUse', { tool_name: 'Bash' }, ctxFor(dir, settings), deps);
  assert.deepEqual(outcome.additionalContext, ['counted', 'other']);
  assert.equal(readFileSync(log, 'utf8'), 'run\n');
});

test('a duplicate that sets onFailure block keeps the block on the merged entry', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const log = join(dir, 'runs.log');
  const fail = await script(dir, 'fail.sh', `echo run >> ${JSON.stringify(log)}\nexit 1`);
  const settings = settingsWith({ PreToolUse: [group('', entry(fail)), group('Bash', entry(fail, { onFailure: 'block' }))] });
  const outcome = await runHooks('PreToolUse', { tool_name: 'Bash' }, ctxFor(dir, settings), deps);
  assert.deepEqual([outcome.decision, outcome.reason, outcome.warnings], ['deny', 'hook failed: exit 1', []]);
  assert.equal(readFileSync(log, 'utf8'), 'run\n');
});

test('identical commands run under the longest of their timeouts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const kills = [];
  const fake = { spawn: () => child, kill: (pid, signal) => kills.push([pid, signal]) };
  const settings = settingsWith({ Stop: [group('', entry('hook', { timeout: 1 }), entry('hook'), entry('hook', { timeout: 3 }))] });
  const pending = runHooks('Stop', {}, ctxFor('/w', settings), fake);
  t.mock.timers.tick(59999);
  assert.deepEqual(kills, []);
  t.mock.timers.tick(1);
  assert.deepEqual(kills, [[-4242, 'SIGTERM']]);
  child.emit('exit', null, 'SIGTERM');
  child.emit('close', null, 'SIGTERM');
  assert.deepEqual((await pending).warnings, ['hook Stop "hook": timeout']);
});

test('a hook that ignores SIGTERM is SIGKILLed after the grace period, with its children', GUARD, async (t) => {
  const dir = await useTempDir(t);
  let sleepPid = null;
  const tap = (...args) => {
    const child = spawn(...args);
    child.stdout.once('data', (chunk) => {
      sleepPid = Number(String(chunk).trim());
    });
    return child;
  };
  const command = "trap '' TERM; sleep 5 & echo $!; wait";
  const settings = settingsWith({ Stop: [group('', entry(command, { timeout: 1 }))] });
  const started = Date.now();
  const outcome = await runHooks('Stop', {}, ctxFor(dir, settings), { spawn: tap, killGraceMs: 200 });
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.ok(sleepPid > 0, String(sleepPid));
  assert.equal(isGone(sleepPid), true);
  assert.deepEqual(outcome.warnings, [`hook Stop "${label(command)}": timeout`]);
});

test('permissionDecision deny carries its reason', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const deny = await script(dir, 'deny.sh', hookOutput({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no rm here' }));
  const outcome = await runHooks('PreToolUse', { tool_name: 'Bash' }, ctxFor(dir, settingsWith({ PreToolUse: [group('Bash', deny)] })), deps);
  assert.equal(outcome.decision, 'deny');
  assert.equal(outcome.reason, 'no rm here');
  assert.deepEqual(outcome.warnings, []);
});

test('permissionDecision and updatedInput count only on PreToolUse', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const deny = await script(dir, 'deny.sh', hookOutput({ hookEventName: 'PostToolUse', permissionDecision: 'deny', updatedInput: { x: 1 }, additionalContext: 'ctx' }));
  const outcome = await runHooks('PostToolUse', { tool_name: 'Bash' }, ctxFor(dir, settingsWith({ PostToolUse: [group('', deny)] })), deps);
  assert.deepEqual(outcome, { additionalContext: ['ctx'], decision: null, reason: null, updatedInput: null, warnings: [], truncations: [] });
});

test('exit 2 denies on PreToolUse with stderr as the reason, and warns on UserPromptSubmit', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const block = await script(dir, 'block.sh', 'echo "  stop that  " >&2; exit 2');
  const quiet = await script(dir, 'quiet.sh', 'exit 2');
  const pre = await runHooks('PreToolUse', { tool_name: 'Bash' }, ctxFor(dir, settingsWith({ PreToolUse: [group('', block)] })), deps);
  assert.deepEqual([pre.decision, pre.reason, pre.warnings], ['deny', 'stop that', []]);
  const bare = await runHooks('PreToolUse', { tool_name: 'Bash' }, ctxFor(dir, settingsWith({ PreToolUse: [group('', quiet)] })), deps);
  assert.deepEqual([bare.decision, bare.reason], ['deny', 'blocked by hook']);
  const ups = await runHooks('UserPromptSubmit', {}, ctxFor(dir, settingsWith({ UserPromptSubmit: [group('', block)] })), deps);
  assert.deepEqual([ups.decision, ups.warnings], [null, [`hook UserPromptSubmit "${label(block)}": exit 2`]]);
});

test('exit 1 warns and the outcome carries no decision', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const fail = await script(dir, 'fail.sh', 'echo oops; exit 1');
  const outcome = await runHooks('PreToolUse', { tool_name: 'Bash' }, ctxFor(dir, settingsWith({ PreToolUse: [group('', fail)] })), deps);
  assert.deepEqual(outcome, {
    additionalContext: [],
    decision: null,
    reason: null,
    updatedInput: null,
    warnings: [`hook PreToolUse "${label(fail)}": exit 1`],
    truncations: [],
  });
});

test('exit 1 with onFailure block denies on PreToolUse and only warns elsewhere', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const fail = await script(dir, 'fail.sh', 'exit 1');
  const blocking = entry(fail, { onFailure: 'block' });
  const pre = await runHooks('PreToolUse', { tool_name: 'Bash' }, ctxFor(dir, settingsWith({ PreToolUse: [group('Bash', blocking)] })), deps);
  assert.deepEqual([pre.decision, pre.reason, pre.warnings], ['deny', 'hook failed: exit 1', []]);
  const post = await runHooks('PostToolUse', { tool_name: 'Bash' }, ctxFor(dir, settingsWith({ PostToolUse: [group('Bash', blocking)] })), deps);
  assert.deepEqual([post.decision, post.warnings], [null, [`hook PostToolUse "${label(fail)}": exit 1`]]);
});

test('a spawn error is a failure that onFailure block turns into a deny', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const settings = settingsWith({ PreToolUse: [group('', entry('true', { onFailure: 'block' }))] });
  const outcome = await runHooks('PreToolUse', { tool_name: 'Bash' }, ctxFor(join(dir, 'missing'), settings), deps);
  assert.equal(outcome.decision, 'deny');
  assert.match(outcome.reason, /^hook failed: .*ENOENT/);
});

test('on PreToolUse, stdout cut at 1 MiB or not a JSON object is a failure: onFailure block denies, otherwise it only warns', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const big = await script(dir, 'big.sh', `printf '{"hookSpecificOutput":{"permissionDecision":"deny","additionalContext":"'; head -c 1100000 /dev/zero | tr '\\0' a; printf '"}}\\n'`);
  const plain = await script(dir, 'plain.sh', 'echo "not json"');
  const array = await script(dir, 'array.sh', "echo '[1]'");
  const quiet = await script(dir, 'quiet.sh', 'true');
  const fire = async (command, onFailure) => {
    const settings = settingsWith({ PreToolUse: [group('', entry(command, { onFailure }))] });
    const outcome = await runHooks('PreToolUse', { tool_name: 'Bash' }, ctxFor(dir, settings), deps);
    return [outcome.decision, outcome.reason, outcome.warnings];
  };
  const truncated = `hook PreToolUse "${label(big)}": stdout over 1 MiB truncated`;
  assert.deepEqual(await fire(big, 'block'), ['deny', 'hook failed: stdout over 1 MiB truncated', [truncated]]);
  assert.deepEqual(await fire(plain, 'block'), ['deny', 'hook failed: invalid JSON', []]);
  assert.deepEqual(await fire(array, 'block'), ['deny', 'hook failed: invalid JSON', []]);
  assert.deepEqual(await fire(quiet, 'block'), [null, null, []]);
  assert.deepEqual(await fire(big, null), [null, null, [truncated, `hook PreToolUse "${label(big)}": invalid JSON ignored`]]);
  assert.deepEqual(await fire(plain, null), [null, null, [`hook PreToolUse "${label(plain)}": invalid JSON ignored`]]);
});

test('a top-level decision "block" on PreToolUse denies with its reason, or blocked by hook, even over a hookSpecificOutput allow; "approve" decides nothing', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const print = (name, value) => script(dir, name, `printf '%s\\n' '${JSON.stringify(value)}'`);
  const legacy = await print('legacy.sh', { decision: 'block', reason: 'legacy no' });
  const bare = await print('bare.sh', { decision: 'block' });
  const mixed = await print('mixed.sh', { decision: 'block', reason: 'mixed no', hookSpecificOutput: { permissionDecision: 'allow' } });
  const approve = await print('approve.sh', { decision: 'approve', reason: 'fine' });
  const fire = async (event, command) => {
    const outcome = await runHooks(event, { tool_name: 'Bash' }, ctxFor(dir, settingsWith({ [event]: [group('', command)] })), deps);
    return [outcome.decision, outcome.reason, outcome.warnings];
  };
  assert.deepEqual(await fire('PreToolUse', legacy), ['deny', 'legacy no', []]);
  assert.deepEqual(await fire('PreToolUse', bare), ['deny', 'blocked by hook', []]);
  assert.deepEqual(await fire('PreToolUse', mixed), ['deny', 'mixed no', []]);
  assert.deepEqual(await fire('PreToolUse', approve), [null, null, []]);
  assert.deepEqual(await fire('PostToolUse', legacy), [null, null, []]);
});

test('a timeout kills the hook within the timeout plus grace', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const slow = await script(dir, 'slow.sh', 'sleep 5');
  const blocking = await script(dir, 'blocking.sh', 'sleep 5');
  const settings = settingsWith({ PreToolUse: [group('', entry(slow, { timeout: 1 }), entry(blocking, { timeout: 1, onFailure: 'block' }))] });
  const started = Date.now();
  const outcome = await runHooks('PreToolUse', { tool_name: 'Bash' }, ctxFor(dir, settings), deps);
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
  assert.deepEqual([outcome.decision, outcome.reason], ['deny', 'hook failed: timeout']);
  assert.deepEqual(outcome.warnings, [`hook PreToolUse "${label(slow)}": timeout`]);
});

test('deny beats ask and allow, the first deny gives the reason, and the last updatedInput wins', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const allow = await script(dir, 'allow.sh', hookOutput({ permissionDecision: 'allow', updatedInput: { command: 'ls -a' } }));
  const deny1 = await script(dir, 'deny1.sh', hookOutput({ permissionDecision: 'deny', permissionDecisionReason: 'first' }));
  const ask = await script(dir, 'ask.sh', hookOutput({ permissionDecision: 'ask', permissionDecisionReason: 'asking' }));
  const deny2 = await script(dir, 'deny2.sh', hookOutput({ permissionDecision: 'deny', permissionDecisionReason: 'second' }));
  const rewrite = await script(dir, 'rewrite.sh', hookOutput({ updatedInput: { command: 'ls -l' } }));
  const none = await script(dir, 'none.sh', 'true');
  const settings = settingsWith({ PreToolUse: [group('', allow, deny1, ask, deny2, rewrite, none)] });
  const outcome = await runHooks('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }, ctxFor(dir, settings), deps);
  assert.deepEqual(outcome, {
    additionalContext: [],
    decision: 'deny',
    reason: 'first',
    updatedInput: { command: 'ls -l' },
    warnings: [],
    truncations: [],
  });
  const askOnly = await runHooks('PreToolUse', { tool_name: 'Bash' }, ctxFor(dir, settingsWith({ PreToolUse: [group('', allow, ask)] })), deps);
  assert.deepEqual([askOnly.decision, askOnly.reason, askOnly.updatedInput], ['ask', 'asking', { command: 'ls -a' }]);
});

test('tool matchers are anchored regexes on tool_name, and an invalid one never matches', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const say = async (name) => script(dir, `${name}.sh`, hookOutput({ additionalContext: name }));
  const settings = settingsWith({
    PreToolUse: [group('Bash', await say('bash')), group('Agent|Task', await say('agent-task')), group('*', await say('star')), group('(', await say('broken'))],
  });
  const run = (tool) => runHooks('PreToolUse', { tool_name: tool }, ctxFor(dir, settings), deps);
  const bashOutput = await run('BashOutput');
  assert.deepEqual(bashOutput.additionalContext, ['star']);
  assert.deepEqual(bashOutput.warnings, ['hook PreToolUse matcher "(": invalid regex; never matches']);
  assert.deepEqual((await run('Task')).additionalContext, ['agent-task', 'star']);
  assert.deepEqual((await run('Bash')).additionalContext, ['bash', 'star']);
});

test('the SessionStart matcher tests against source, and other events ignore the matcher', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const compact = await script(dir, 'compact.sh', hookOutput({ additionalContext: 'compact' }));
  const startup = await script(dir, 'startup.sh', hookOutput({ additionalContext: 'startup' }));
  const settings = settingsWith({
    SessionStart: [group('compact', compact), group('startup|resume', startup)],
    Notification: [group('nothing-matches-this', compact)],
  });
  assert.deepEqual((await runHooks('SessionStart', { source: 'compact' }, ctxFor(dir, settings), deps)).additionalContext, ['compact']);
  assert.deepEqual((await runHooks('SessionStart', { source: 'resume' }, ctxFor(dir, settings), deps)).additionalContext, ['startup']);
  assert.deepEqual((await runHooks('SessionStart', { source: 'clear' }, ctxFor(dir, settings), deps)).additionalContext, []);
  assert.deepEqual((await runHooks('Notification', { notification_type: 'permission' }, ctxFor(dir, settings), deps)).additionalContext, ['compact']);
});

test('the PreCompact matcher tests against trigger: manual matches and auto does not', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const manual = await script(dir, 'manual.sh', hookOutput({ additionalContext: 'manual' }));
  const any = await script(dir, 'any.sh', hookOutput({ additionalContext: 'any' }));
  const settings = settingsWith({ PreCompact: [group('manual', manual), group('', any)] });
  const fire = (trigger) => runHooks('PreCompact', { trigger, custom_instructions: '' }, ctxFor(dir, settings), deps);
  assert.deepEqual((await fire('manual')).additionalContext, ['manual', 'any']);
  assert.deepEqual((await fire('auto')).additionalContext, ['any']);
});

test('the stdin JSON reaches the script intact, followed by a newline', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const echo = join(dir, 'echo.mjs');
  await writeFile(
    echo,
    "let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: s } })));\n",
  );
  const hook = await script(dir, 'echo.sh', `exec "${process.execPath}" "${echo}"`);
  const input = buildHookInput(
    'PreToolUse',
    { sessionId: 's-1', transcriptPath: '/t/s-1.jsonl', cwd: dir, permissionMode: 'default' },
    { tool_name: 'Bash', tool_input: { command: "echo 'quoted' \"double\" $HOME ü\n" }, tool_use_id: 'toolu_1' },
  );
  const outcome = await runHooks('PreToolUse', input, ctxFor(dir, settingsWith({ PreToolUse: [group('Bash', hook)] })), deps);
  assert.deepEqual(outcome.additionalContext, [`${JSON.stringify(input)}\n`]);
});

test('the hook env carries ctx.env, settings.env and CLODENT_PROJECT_DIR, and runs in cwd', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const show = await script(dir, 'env.sh', 'printf \'{"hookSpecificOutput":{"additionalContext":"%s|%s|%s|%s"}}\' "$FROM_CTX" "$FROM_SETTINGS" "$CLODENT_PROJECT_DIR" "$PWD"');
  const settings = settingsWith({ Stop: [group('', show)] }, { env: { FROM_SETTINGS: 'settings', FROM_CTX: 'overridden' } });
  const ctx = { settings, cwd: dir, env: cleanEnv({ FROM_CTX: 'ctx', CLODENT_PROJECT_DIR: '/wrong' }) };
  const outcome = await runHooks('Stop', {}, ctx, deps);
  assert.deepEqual(outcome.additionalContext, [`overridden|settings|${dir}|${dir}`]);
  const plain = await runHooks('Stop', {}, { ...ctx, settings: settingsWith({ Stop: [group('', show)] }) }, deps);
  assert.deepEqual(plain.additionalContext, [`ctx||${dir}|${dir}`]);
});

test('aborting the signal kills running hooks and their children', GUARD, async (t) => {
  const dir = await useTempDir(t);
  const hang = await script(dir, 'hang.sh', 'sleep 30 &\necho $!\nwait');
  const controller = new AbortController();
  let childPid = null;
  const tap = (...args) => {
    const child = spawn(...args);
    child.stdout.once('data', (chunk) => {
      childPid = Number(String(chunk).trim());
      controller.abort();
    });
    return child;
  };
  const started = Date.now();
  const settings = settingsWith({ PreToolUse: [group('', hang)] });
  const outcome = await runHooks('PreToolUse', { tool_name: 'Bash' }, ctxFor(dir, settings, { signal: controller.signal }), { spawn: tap });
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
  assert.ok(childPid > 0);
  assert.equal(isGone(childPid), true);
  assert.deepEqual(outcome.warnings, [`hook PreToolUse "${label(hang)}": aborted`]);
});

test('an already aborted signal runs nothing', GUARD, async (t) => {
  const dir = await useTempDir(t);
  let spawned = 0;
  const count = (...args) => {
    spawned += 1;
    return spawn(...args);
  };
  const settings = settingsWith({ Stop: [group('', 'true')] });
  const outcome = await runHooks('Stop', {}, ctxFor(dir, settings, { signal: AbortSignal.abort() }), { spawn: count });
  assert.equal(spawned, 0);
  assert.deepEqual(outcome.warnings, ['hook Stop "true": aborted']);
});

test('the command label in hook and statusLine warnings is cut to 60 code points, so an emoji at the cut stays whole', () => {
  assert.equal(commandLabel(`${'a'.repeat(59)}\u{1F600}b`), `${'a'.repeat(59)}\u{1F600}`);
  assert.equal(commandLabel('short'), 'short');
});
