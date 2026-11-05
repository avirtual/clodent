import * as nodeFs from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { capResult } from './cap.js';
import { oneLine } from './util.js';

export const CLODEX_PREFIX = 'mcp__clodex__';
export const CRED_ENV = 'CLODEX_INTENT_CRED';
export const SOCK_ENV = 'CLODEX_INTENT_SOCK';
export const CATALOG_FILE = 'mcp-tools.json';
export const CLIENT_TIMEOUT_MS = 500 * 1000;
export const LOOP_MAX = 3;
export const LOOP_WINDOW_MS = 60 * 1000;
export const LOOP_RING = 12;
export const COMPLETION_UNKNOWN = 'completion unknown — do not retry';
export const BAD_REPLY = 'bad reply from the seat channel';
export const INTERRUPTED = 'interrupted by user';
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const NEWLINE = 0x0a;
const NONE = Object.freeze({ tools: Object.freeze([]), warnings: Object.freeze([]), rev: null });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function isClodexToolName(name) {
  return typeof name === 'string' && name.length > CLODEX_PREFIX.length && name.startsWith(CLODEX_PREFIX) && TOOL_NAME.test(name);
}

export function clodexActive(env) {
  return Boolean(env?.[SOCK_ENV]) && Boolean(env?.[CRED_ENV]);
}

function catalogRows(list, builtins, file) {
  const taken = new Set(builtins);
  const tools = [];
  const warnings = [];
  for (const row of list) {
    if (!isObject(row) || typeof row.name !== 'string' || !isObject(row.inputSchema)) continue;
    const name = `${CLODEX_PREFIX}${row.name}`;
    if (!isClodexToolName(name)) continue;
    if (taken.has(name)) {
      warnings.push(`Clodex tool catalog ${file}: skipped ${JSON.stringify(row.name)}: a tool named ${name} already exists`);
      continue;
    }
    taken.add(name);
    tools.push({ name, tool: row.name, description: typeof row.description === 'string' ? row.description : '', inputSchema: row.inputSchema });
  }
  return { tools, warnings };
}

export function readClodexCatalog(env, deps = {}) {
  if (!clodexActive(env)) return NONE;
  const fs = deps.fs ?? nodeFs;
  const file = join(dirname(env[SOCK_ENV]), CATALOG_FILE);
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return NONE;
  }
  if (!isObject(catalog)) return NONE;
  const rev = typeof catalog.rev === 'string' ? catalog.rev : null;
  if (catalog.v !== 1) {
    return { tools: [], warnings: [`Clodex tool catalog ${file}: version ${JSON.stringify(catalog.v) ?? 'missing'} is not supported; no Clodex tools`], rev };
  }
  if (!Array.isArray(catalog.tools)) return { ...NONE, rev };
  return { ...catalogRows(catalog.tools, deps.builtins ?? [], file), rev };
}

function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])]));
}

export function createLoopRing(deps = {}) {
  const now = deps.now ?? Date.now;
  const fails = new Map();
  return {
    blocked(key) {
      const last = fails.get(key);
      if (!last || last.n < LOOP_MAX - 1 || now() - last.at >= LOOP_WINDOW_MS) return null;
      fails.set(key, { ...last, n: last.n + 1, at: now() });
      return `the same call failed ${LOOP_MAX} times — stop retrying: ${last.text}`;
    },
    failed(key, text) {
      const at = now();
      const last = fails.get(key);
      const n = last && at - last.at < LOOP_WINDOW_MS ? last.n + 1 : 1;
      fails.set(key, { n, at, text });
      if (fails.size > LOOP_RING) fails.delete(fails.keys().next().value);
    },
    cleared(key) {
      fails.delete(key);
    },
  };
}

function parseReply(chunks) {
  const text = Buffer.concat(chunks).toString('utf8');
  const end = text.indexOf('\n');
  let res;
  try {
    res = JSON.parse(end === -1 ? text : text.slice(0, end));
  } catch {
    return { transport: 'bad-reply' };
  }
  return isObject(res) ? { res } : { transport: 'bad-reply' };
}

export function callSocket({ sockPath, payload, timeoutMs = CLIENT_TIMEOUT_MS, signal }, deps = {}) {
  const connect = deps.connect ?? createConnection;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ transport: 'aborted' });
      return;
    }
    const chunks = [];
    let settled = false;
    let timer = null;
    let sock = null;
    const onAbort = () => finish({ transport: 'aborted' });
    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      sock?.destroy();
      resolve(result);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      sock = connect(sockPath);
    } catch (err) {
      finish({ transport: 'no-socket', message: err?.message ?? String(err) });
      return;
    }
    timer = setTimer(() => finish({ transport: 'timeout' }), timeoutMs);
    sock.on('connect', () => sock.write(`${JSON.stringify(payload)}\n`));
    sock.on('data', (data) => {
      const chunk = Buffer.from(data);
      chunks.push(chunk);
      if (chunk.includes(NEWLINE)) finish(parseReply(chunks));
    });
    sock.on('error', (err) => finish({ transport: 'no-socket', message: err?.message ?? String(err) }));
    sock.on('close', () => finish(parseReply(chunks)));
  });
}

function statusOf(r) {
  if (r.res?.ok) return ['ok', 'error', 'refused'].includes(r.res.status) ? r.res.status : 'error';
  if (r.res) return r.res.status === 'refused' || r.res.status === 'invalid' ? r.res.status : 'error';
  return r.transport;
}

function resultText(r, timeoutMs) {
  if (r.res?.ok) return String(r.res.reply ?? '');
  if (r.res?.status === 'invalid') return `invalid: ${r.res.error}`;
  if (r.res) return String(r.res.error || 'failed');
  if (r.transport === 'timeout') {
    return `${COMPLETION_UNKNOWN}: the seat did not answer within ${Math.round(timeoutMs / 1000)} s; the action may still have run — read the page before repeating it`;
  }
  if (r.transport === 'no-socket') return `no seat channel: ${r.message}`;
  return BAD_REPLY;
}

const plain = (text) => ({ content: capResult(text), isError: false });

function firstString(input) {
  if (!isObject(input)) return '';
  for (const [key, value] of Object.entries(input)) if (key !== 'ident' && typeof value === 'string') return value;
  return '';
}

async function callTool(tool, input, ctx, { env, ring, timeoutMs, deps }) {
  if (!isObject(input)) return plain('invalid: input must be an object');
  const { ident, ...args } = input;
  const key = JSON.stringify([tool, canon(args)]);
  const looped = ring.blocked(key);
  if (looped) return plain(looped);
  const payload = { cred: env[CRED_ENV], tool, args, ...(typeof ident === 'string' && ident ? { ident } : {}) };
  const r = await callSocket({ sockPath: env[SOCK_ENV], payload, timeoutMs, signal: ctx?.signal }, deps);
  if (r.transport === 'aborted') return { content: INTERRUPTED, isError: true };
  const text = resultText(r, timeoutMs);
  const status = statusOf(r);
  if (status === 'ok') ring.cleared(key);
  else if (status !== 'invalid' && status !== 'timeout') ring.failed(key, text);
  return plain(text);
}

export function createClodexTools(catalog, deps = {}) {
  const options = { env: deps.env ?? {}, ring: deps.ring ?? createLoopRing(deps), timeoutMs: deps.timeoutMs ?? CLIENT_TIMEOUT_MS, deps };
  return catalog.tools.map((row) => ({
    name: row.name,
    kind: 'read',
    description: row.description,
    input_schema: row.inputSchema,
    summary: (input) => oneLine(firstString(input)),
    run: (input, ctx) => callTool(row.tool, input, ctx, options),
  }));
}

export function createClodexToolset(env, deps = {}) {
  const ring = createLoopRing(deps);
  const removes = deps.removes ?? (() => false);
  let seen = null;
  let tools = [];
  return {
    refresh() {
      const catalog = readClodexCatalog(env, deps);
      const key = JSON.stringify([catalog.rev, catalog.warnings]);
      if (key === seen) return { tools, warnings: [], changed: false };
      seen = key;
      tools = createClodexTools(catalog, { ...deps, env, ring }).filter((tool) => !removes(tool.name));
      return { tools, warnings: [...catalog.warnings], changed: true };
    },
  };
}
