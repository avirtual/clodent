import { readFileSync } from 'node:fs';
import { main } from '../../src/cli.js';
import { testEnv } from '../helpers/run-main.js';
import { sseEvents } from '../helpers/sse-builder.js';
import { fakeStdin, heldFetch } from '../repl/harness.js';

export const UUID = '11111111-2222-4333-8444-555555555555';
export const STREAM_ARGV = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
export const STDIO = ['--permission-prompt-tool', 'stdio'];

export function userLine(content) {
  return { type: 'user', message: { role: 'user', content } };
}

export function parseRecords(text) {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

export function kinds(records) {
  return records.map((record) => (record.type === 'system' ? `system/${record.subtype}` : record.type));
}

function jsonLines() {
  let text = '';
  const waiters = [];
  const records = () => parseRecords(text.slice(0, text.lastIndexOf('\n') + 1));
  return {
    write(chunk) {
      text += chunk;
      for (const waiter of [...waiters]) {
        if (!waiter.test(records())) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(records());
      }
      return true;
    },
    get text() {
      return text;
    },
    records,
    wait(test, label) {
      if (test(records())) return Promise.resolve(records());
      return new Promise((resolve, reject) => waiters.push({ test, resolve, reject, label }));
    },
    fail(reason) {
      for (const waiter of waiters.splice(0)) waiter.reject(new Error(`${reason} before ${waiter.label}:\n${text}`));
    },
  };
}

function collect() {
  let text = '';
  return {
    write(chunk) {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
}

export function stallingReply(blocks, at = 1) {
  const encoder = new TextEncoder();
  const events = sseEvents({ blocks }).filter((event) => !event.startsWith('event: message_delta') && !event.startsWith('event: message_stop'));
  let drained;
  const reply = { at, drained: new Promise((resolve) => (drained = resolve)) };
  reply.respond = (init) => {
    let i = 0;
    const body = new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
      },
      pull(controller) {
        if (i < events.length) controller.enqueue(encoder.encode(events[i++]));
        else drained();
      },
    });
    return new Response(body, { status: 200 });
  };
  return reply;
}

function streamFetch(replies) {
  const inner = heldFetch(replies.filter((reply) => !reply.respond));
  const stalls = replies.filter((reply) => reply.respond);
  async function fetch(url, init = {}) {
    if (stalls.length > 0 && inner.calls.length + 1 === stalls[0].at) {
      inner.calls.push({ url: String(url), body: JSON.parse(init.body) });
      return stalls.shift().respond(init);
    }
    return inner(url, init);
  }
  fetch.calls = inner.calls;
  fetch.push = inner.push;
  fetch.called = inner.called;
  return fetch;
}

export function startStream(argv, { home, cwd, replies = [], env = {}, clock = { t: 0 } }) {
  const stdin = fakeStdin({ isTTY: false });
  const out = jsonLines();
  const err = collect();
  const fetch = streamFetch(replies);
  const signals = {};
  const done = main(argv, {
    stdout: out,
    stderr: err,
    stdin,
    env: testEnv({ ANTHROPIC_API_KEY: 'sk-test', CLODENT_HOME: home, ...env }),
    cwd,
    platform: 'darwin',
    fetch,
    sleep: async () => {},
    random: () => 0.5,
    now: () => clock.t,
    clock: () => new Date(Date.UTC(2026, 10, 4)),
    onSignal: (name, handler) => {
      signals[name] = handler;
      return () => delete signals[name];
    },
  });
  done.then(
    () => out.fail('main resolved'),
    (error) => out.fail(`main threw ${error?.stack ?? error}`),
  );
  return {
    stdin,
    out,
    err,
    fetch,
    signals,
    done,
    clock,
    send: (record) => stdin.type(`${JSON.stringify(record)}\n`),
    close: () => stdin.close(),
    until: (type, n = 1) => out.wait((records) => kinds(records).filter((kind) => kind === type).length >= n, `${type} x${n}`),
  };
}

export function readSession(name) {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return text.split('\n').filter((line) => line !== '');
}

export function stdinOf(lines) {
  return lines.filter((line) => line.startsWith('# >> stdin')).map((line) => JSON.parse(line.slice(line.indexOf(': {') + 2)));
}
