import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import { cleanEnv } from '../tools/tmp-dir.js';
import { createFakeFetch } from './fake-fetch.js';
import { sse } from './sse-builder.js';

const SESSION_LINE = /^\[clodent:session\] ([0-9a-f-]{36})$/;

export function testEnv(extra = {}) {
  const env = cleanEnv();
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLODENT_') || key === 'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS') delete env[key];
  }
  return { ...env, ...extra };
}

export const textReply = (text, usage) => ({ body: sse({ blocks: [{ type: 'text', text }], usage }) });

export function toolsReply(uses, usage) {
  const blocks = uses.map(([name, input], i) => ({ type: 'tool_use', id: `toolu_${i + 1}`, name, input }));
  return { body: sse({ blocks, stopReason: 'tool_use', usage }) };
}

export function hookGroup(matcher, ...commands) {
  return { matcher, hooks: commands.map((command) => ({ type: 'command', command })) };
}

export function writeSettings(dir, settings, name = 'settings.json') {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(settings));
  return path;
}

export function readJsonl(path) {
  return readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
}

export function strip(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => (key === 'cache_control' ? undefined : v)));
}

export async function runMain(argv, { home, cwd, responses = [], env = {}, onFetch, key = 'sk-test' }) {
  const out = [];
  const err = [];
  const signals = {};
  const inner = createFakeFetch(responses);
  const fetch = async (url, init) => {
    onFetch?.({ signals, calls: inner.calls.length });
    return inner(url, init);
  };
  const code = await main(argv, {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: testEnv({ ...(key ? { ANTHROPIC_API_KEY: key } : {}), CLODENT_HOME: home, ...env }),
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
  const stderr = err.join('');
  const id = stderr.split('\n')[0].match(SESSION_LINE)?.[1];
  return { code, stdout: out.join(''), stderr, id, calls: inner.calls, signals };
}
