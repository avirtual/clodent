import { readFileSync } from 'node:fs';

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2026-10-21';
export const DEFAULT_MAX_TOKENS = 32000;
export const EFFORTS = Object.freeze(['low', 'medium', 'high']);

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

function markEphemeral(block) {
  return { ...block, cache_control: { type: 'ephemeral' } };
}

function copyMessages(messages) {
  const copies = messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map(withoutCacheControl)
      : message.content,
  }));
  const last = copies.at(-1);
  if (!last) return copies;
  if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
  if (!Array.isArray(last.content)) return copies;
  for (let i = last.content.length - 1; i >= 0; i--) {
    if (!SKIP_FOR_CACHE.has(last.content[i].type)) {
      last.content[i] = markEphemeral(last.content[i]);
      break;
    }
  }
  return copies;
}

function copyTools(tools) {
  const copies = tools.map(withoutCacheControl);
  copies[copies.length - 1] = markEphemeral(copies.at(-1));
  return copies;
}

export function buildRequest(
  { model, system, tools = [], messages, effort, maxTokens = DEFAULT_MAX_TOKENS, baseUrl, toolChoice },
  deps,
) {
  if (effort !== undefined && effort !== null && !EFFORTS.includes(effort)) {
    throw new Error(`invalid effort ${JSON.stringify(effort)}: expected one of ${EFFORTS.join(', ')}`);
  }
  if (typeof system !== 'string' || system === '') {
    throw new Error('system must be a non-empty string');
  }
  const apiKey = deps.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    system: [markEphemeral({ type: 'text', text: system })],
  };
  if (tools.length > 0) body.tools = copyTools(tools);
  if (toolChoice !== undefined && toolChoice !== null) body.tool_choice = toolChoice;
  body.messages = copyMessages(messages);
  body.thinking = { type: 'adaptive' };
  if (effort !== undefined && effort !== null) body.output_config = { effort };

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
