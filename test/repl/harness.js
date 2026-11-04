import { EventEmitter } from 'node:events';
import { main } from '../../src/cli.js';
import { PASTE_ON, PROMPT } from '../../src/repl/repl.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';
import { testEnv } from '../helpers/run-main.js';

export const PROMPT_MARK = `${PASTE_ON}${PROMPT}`;

export function fakeStdin({ isTTY = true } = {}) {
  const stdin = new EventEmitter();
  stdin.isTTY = isTTY;
  stdin.rawModes = [];
  stdin.paused = false;
  if (isTTY) {
    stdin.setRawMode = (on) => {
      stdin.rawModes.push(on);
      return stdin;
    };
  }
  stdin.setEncoding = () => stdin;
  stdin.pause = () => {
    stdin.paused = true;
    return stdin;
  };
  stdin.type = (text) => stdin.emit('data', text);
  stdin.close = () => stdin.emit('end');
  return stdin;
}

function screen() {
  let text = '';
  const waiters = [];
  return {
    write(chunk) {
      text += chunk;
      for (const waiter of [...waiters]) {
        if (!waiter.test(text)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(text);
      }
      return true;
    },
    get text() {
      return text;
    },
    wait(test, label) {
      if (test(text)) return Promise.resolve(text);
      return new Promise((resolve, reject) => waiters.push({ test, resolve, reject, label }));
    },
    fail(reason) {
      for (const waiter of waiters.splice(0)) waiter.reject(new Error(`${reason} before ${waiter.label}:\n${JSON.stringify(text)}`));
    },
  };
}

export function count(text, needle) {
  return text.split(needle).length - 1;
}

export function heldFetch(replies = []) {
  const ready = [...replies];
  const calls = [];
  const waiting = [];
  const callWaiters = [];
  async function fetch(url, init = {}) {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    for (const waiter of callWaiters.filter((w) => calls.length >= w.n)) {
      callWaiters.splice(callWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    const reply = ready.length > 0 ? ready.shift() : await new Promise((resolve, reject) => {
      waiting.push(resolve);
      init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    return createFakeFetch([reply])(url, init);
  }
  fetch.calls = calls;
  fetch.push = (reply) => {
    const resolve = waiting.shift();
    if (resolve) resolve(reply);
    else ready.push(reply);
  };
  fetch.called = (n) => (calls.length >= n ? Promise.resolve() : new Promise((resolve) => callWaiters.push({ n, resolve })));
  return fetch;
}

export function startRepl(argv, { home, cwd, replies = [], env = {}, isTTY = true }) {
  const stdin = fakeStdin({ isTTY });
  const out = screen();
  const err = screen();
  const fetch = heldFetch(replies);
  const signals = {};
  const done = main(argv, {
    stdout: out,
    stderr: err,
    stdin,
    env: testEnv({ ANTHROPIC_API_KEY: 'sk-test', CLAY_HOME: home, ...env }),
    cwd,
    platform: 'darwin',
    fetch,
    sleep: async () => {},
    random: () => 0.5,
    now: () => 0,
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
  const repl = {
    stdin,
    out,
    err,
    fetch,
    signals,
    done,
    prompts: (n) => out.wait((text) => count(text, PROMPT_MARK) >= n, `prompt ${n}`),
    until: (needle, n = 1) => out.wait((text) => count(text, needle) >= n, `${JSON.stringify(needle)} x${n}`),
    sessionIds: () => [...out.text.matchAll(/^\[clay:session\] (\S+)$/gm)].map((m) => m[1]),
  };
  return repl;
}

export function userTexts(body) {
  const last = body.messages.at(-1);
  return last.content.filter((block) => block.type === 'text').map((block) => block.text);
}
