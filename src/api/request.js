import { readFileSync } from 'node:fs';

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2026-10-21';
export const DEFAULT_MAX_TOKENS = 32000;
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const CACHE_TTLS = Object.freeze(['5m', '1h']);
export const DEFAULT_CACHE_TTL = '5m';

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;
const SKIP_FOR_CACHE = new Set(['thinking', 'redacted_thinking']);

export function apiUrl(baseUrl) {
  if (baseUrl === undefined || baseUrl === null) return API_URL;
  return `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
}

export function userAgent() {
  return `clodent/${PACKAGE_VERSION}`;
}

function withoutCacheControl(block) {
  const { cache_control: _dropped, ...rest } = block;
  return rest;
}

function markEphemeral(block, ttl) {
  const cacheControl = ttl === '1h' ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
  return { ...block, cache_control: cacheControl };
}

function isRealUserTurn(message) {
  if (message.role !== 'user') return false;
  if (typeof message.content === 'string') return message.content.trim() !== '';
  return Array.isArray(message.content) && message.content.some((block) => block.type === 'text');
}

function lastRealUserTurn(messages, before) {
  for (let i = before - 1; i >= 0; i--) {
    if (isRealUserTurn(messages[i])) return i;
  }
  return -1;
}

function settledAnchor(messages) {
  const boundary = lastRealUserTurn(messages, messages.length);
  if (boundary <= 0) return -1;
  if (messages.slice(boundary + 1).some((message) => message.role === 'assistant')) return boundary;
  return lastRealUserTurn(messages, boundary);
}

function toBlocks(message) {
  if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }];
}

function copyMessages(messages, ttl) {
  const copies = messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map(withoutCacheControl)
      : message.content,
  }));
  const anchor = settledAnchor(copies);
  if (anchor >= 0) {
    const pinned = copies[anchor];
    toBlocks(pinned);
    pinned.content[pinned.content.length - 1] = markEphemeral(pinned.content.at(-1), ttl);
  }
  const last = copies.at(-1);
  if (!last) return copies;
  toBlocks(last);
  if (!Array.isArray(last.content)) return copies;
  for (let i = last.content.length - 1; i >= 0; i--) {
    if (!SKIP_FOR_CACHE.has(last.content[i].type)) {
      last.content[i] = markEphemeral(last.content[i], ttl);
      break;
    }
  }
  return copies;
}

function byName(a, b) {
  if (a.name < b.name) return -1;
  return a.name > b.name ? 1 : 0;
}

function copyTools(tools, ttl) {
  const copies = tools.map(withoutCacheControl).sort(byName);
  copies[copies.length - 1] = markEphemeral(copies.at(-1), ttl);
  return copies;
}

export function buildRequest(
  { model, system, tools = [], messages, effort, maxTokens = DEFAULT_MAX_TOKENS, baseUrl, toolChoice, sessionId, cacheTtl = DEFAULT_CACHE_TTL, messageCacheTtl = cacheTtl },
  deps,
) {
  if (effort !== undefined && effort !== null && !EFFORTS.includes(effort)) {
    throw new Error(`invalid effort ${JSON.stringify(effort)}: expected one of ${EFFORTS.join(', ')}`);
  }
  if (!CACHE_TTLS.includes(cacheTtl)) {
    throw new Error(`invalid cacheTtl ${JSON.stringify(cacheTtl)}: expected one of ${CACHE_TTLS.join(', ')}`);
  }
  if (!CACHE_TTLS.includes(messageCacheTtl)) {
    throw new Error(`invalid messageCacheTtl ${JSON.stringify(messageCacheTtl)}: expected one of ${CACHE_TTLS.join(', ')}`);
  }
  const messageTtl = cacheTtl === '5m' ? '5m' : messageCacheTtl;
  if (typeof system !== 'string' || system === '') {
    throw new Error('system must be a non-empty string');
  }
  const apiKey = deps.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    system: [markEphemeral({ type: 'text', text: system }, cacheTtl)],
  };
  if (tools.length > 0) body.tools = copyTools(tools, cacheTtl);
  if (toolChoice !== undefined && toolChoice !== null) body.tool_choice = toolChoice;
  body.messages = copyMessages(messages, messageTtl);
  body.thinking = { type: 'adaptive' };
  if (effort !== undefined && effort !== null) body.output_config = { effort };
  if (sessionId !== undefined && sessionId !== null) body.metadata = { user_id: JSON.stringify({ session_id: sessionId }) };

  return {
    url: apiUrl(baseUrl),
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
      'user-agent': userAgent(),
    },
    body,
  };
}
