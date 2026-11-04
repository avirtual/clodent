import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, constants, createReadStream, existsSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERRUPT_MARKER } from '../src/agent/loop.js';
import { SIGNAL_EXIT } from '../src/cli.js';
import { hookGroup, runMain, strip, textReply, toolsReply, writeSettings } from './helpers/run-main.js';
import { sse } from './helpers/sse-builder.js';
import { assertValidHistory } from './helpers/valid-history.js';
import { isGone, script } from './hooks/scripts.js';
import { testEnv } from './helpers/run-main.js';
import { useTempDir } from './tools/tmp-dir.js';

const BIN = fileURLToPath(new URL('../bin/clay.js', import.meta.url));
const GUARD = { timeout: 10000 };

function fakeApi(t, body) {
  const requests = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(data) });
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      res.end(body);
    });
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ requests, port: server.address().port })));
}

function readFifoLine(path, t) {
  const stream = createReadStream(path, 'utf8');
  t.after(() => {
    try {
      closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {}
    stream.destroy();
  });
  return new Promise((resolve, reject) => {
    let text = '';
    stream.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) resolve(text.trim());
    });
    stream.on('error', reject);
  });
}

test('the exit codes are 130 for SIGINT, 143 for SIGTERM and 129 for SIGHUP', () => {
  assert.deepEqual(SIGNAL_EXIT, { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 });
});

test('SIGTERM to a child clay -p kills its running Bash, exits 143, and leaves a transcript that resumes cleanly', GUARD, async (t) => {
  const home = await useTempDir(t);
  const cwd = await useTempDir(t);
  const fifo = join(cwd, 'pid.fifo');
  execFileSync('mkfifo', [fifo]);
  const command = 'sleep 30 & echo $! > pid.fifo; wait';
  const api = await fakeApi(t, sse({ blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command } }], stopReason: 'tool_use' }));
  const pid = readFifoLine(fifo, t);
  const child = spawn(process.execPath, [BIN, '-p', 'run it', '--yolo'], {
    cwd,
    env: testEnv({ ANTHROPIC_API_KEY: 'sk-test', CLAY_HOME: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}` }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const sleepPid = Number(await pid);
  assert.ok(sleepPid > 0);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 143, signal: null }, stderr);
  assert.equal(isGone(sleepPid), true, `sleep ${sleepPid} still running`);
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].url, '/v1/messages');
  assert.match(stderr, /^clay: interrupted$/m);
  const id = stderr.match(/^\[clay:session\] (\S+)$/m)?.[1];
  assert.ok(id, stderr);
  const res = await runMain(['-p', 'next', '--resume', id], { home, cwd, responses: [textReply('ok')] });
  assert.equal(res.code, 0, res.stderr);
  const sent = strip(res.calls[0].body.messages);
  assertValidHistory(sent);
  assert.equal(sent[2].content[0].type, 'tool_result');
  assert.equal(sent[2].content[0].is_error, true);
  assert.deepEqual(sent[2].content.slice(1), [{ type: 'text', text: INTERRUPT_MARKER }, { type: 'text', text: 'next' }]);
});

test('SIGTERM and SIGHUP abort the turn, then Stop fires and the statusLine flushes before the exit code', GUARD, async (t) => {
  const home = await useTempDir(t);
  const cwd = await useTempDir(t);
  const dir = await useTempDir(t);
  const stops = join(dir, 'stops.jsonl');
  const status = join(dir, 'status.jsonl');
  const stop = await script(dir, 'stop.sh', `cat >> ${JSON.stringify(stops)}`);
  const settings = writeSettings(dir, { hooks: { Stop: [hookGroup('', stop)] }, statusLine: { type: 'command', command: `cat >> ${JSON.stringify(status)}` } });
  for (const [name, expected] of [['SIGTERM', 143], ['SIGHUP', 129]]) {
    const res = await runMain(['-p', 'go', '--settings', settings], {
      home,
      cwd,
      responses: [toolsReply([['Glob', { pattern: '*' }]]), textReply('never')],
      onFetch: ({ signals, calls }) => {
        if (calls === 1) signals[name]();
      },
    });
    assert.equal(res.code, expected, `${name}: ${res.stderr}`);
    assert.deepEqual(res.signals, {});
  }
  assert.deepEqual(readFileSync(stops, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line).hook_event_name), ['Stop', 'Stop']);
  assert.ok(existsSync(status));
  assert.equal(readFileSync(status, 'utf8').trimEnd().split('\n').length, 2);
});
