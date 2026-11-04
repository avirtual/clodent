import { ApiError, RETRYABLE_STATUSES, StreamFault, errorFromResponse } from './errors.js';
import { parseSSE } from './sse.js';

export const MAX_ATTEMPTS = 4;
export const BASE_DELAY_MS = 1000;
export const JITTER = 0.2;
export const IDLE_TIMEOUT_MS = 300_000;

export function backoffMs(attempt, random) {
  const base = BASE_DELAY_MS * 2 ** attempt;
  return Math.round(base * (1 + (random() * 2 - 1) * JITTER));
}

function isAbort(err, signal) {
  return Boolean(signal?.aborted) || err?.name === 'AbortError';
}

const USERINFO = /\/\/[^/\s?#]*@/g;

function isNetwork(err) {
  return err instanceof TypeError || err instanceof StreamFault;
}

async function* idleGuarded(body, idleMs) {
  const reader = body.getReader();
  try {
    for (;;) {
      let timer;
      const idle = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new StreamFault(`stream idle for ${idleMs / 1000}s`)), idleMs);
      });
      let step;
      try {
        step = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (step.done) return;
      yield step.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function networkError(err, requestId = null) {
  return new ApiError({ type: 'network_error', message: String(err.message).replace(USERINFO, '//'), requestId, cause: err });
}

function mergeUsage(usage, delta) {
  if (!delta || typeof delta !== 'object') return;
  for (const [key, value] of Object.entries(delta)) {
    if (value !== null && value !== undefined) usage[key] = value;
  }
}

function createAssembler(handlers, requestId) {
  const message = {
    id: null,
    role: 'assistant',
    model: null,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {},
  };
  const partialJson = new Map();
  let startUsage = null;
  let deltaOutput = 0;
  const reportUsage = () => handlers.onUsage?.({ ...startUsage, output_tokens: deltaOutput });

  function blockStart({ index, content_block: received }) {
    const block = { ...received };
    message.content[index] = block;
    if (block.type === 'tool_use') partialJson.set(index, '');
    handlers.onBlockStart?.(block, index);
  }

  function blockDelta({ index, delta }) {
    const block = message.content[index];
    if (!block || !delta) return;
    if (delta.type === 'text_delta') {
      block.text = (block.text ?? '') + delta.text;
      handlers.onText?.(delta.text, index);
    } else if (delta.type === 'thinking_delta') {
      block.thinking = (block.thinking ?? '') + delta.thinking;
      handlers.onThinking?.(delta.thinking, index);
    } else if (delta.type === 'signature_delta') {
      block.signature = (block.signature ?? '') + delta.signature;
    } else if (delta.type === 'input_json_delta') {
      partialJson.set(index, (partialJson.get(index) ?? '') + delta.partial_json);
    }
  }

  function blockStop({ index }) {
    const block = message.content[index];
    if (!block) return;
    if (partialJson.has(index)) {
      const json = partialJson.get(index);
      partialJson.delete(index);
      try {
        block.input = json === '' ? {} : JSON.parse(json);
      } catch (cause) {
        throw new ApiError({
          type: 'invalid_tool_json',
          message: `unparseable input for ${block.type} block ${index}: ${json.slice(0, 200)}`,
          requestId,
          cause,
        });
      }
    }
    handlers.onBlockStop?.(block, index);
  }

  return {
    message,
    handle(name, data) {
      switch (name) {
        case 'message_start':
          message.id = data.message?.id ?? null;
          message.model = data.message?.model ?? null;
          message.usage = { ...data.message?.usage };
          startUsage = { ...message.usage };
          reportUsage();
          return false;
        case 'content_block_start':
          blockStart(data);
          return false;
        case 'content_block_delta':
          blockDelta(data);
          return false;
        case 'content_block_stop':
          blockStop(data);
          return false;
        case 'message_delta':
          if (data.delta && 'stop_reason' in data.delta) message.stop_reason = data.delta.stop_reason;
          if (data.delta && 'stop_sequence' in data.delta) message.stop_sequence = data.delta.stop_sequence;
          mergeUsage(message.usage, data.usage);
          if (startUsage) {
            deltaOutput = data.usage?.output_tokens ?? deltaOutput;
            reportUsage();
          }
          return false;
        case 'message_stop':
          return true;
        case 'error':
          throw new ApiError({
            type: data.error?.type ?? 'error',
            message: data.error?.message ?? 'stream error',
            requestId,
          });
        default:
          return false;
      }
    },
  };
}

async function readStream(response, requestId, deps, handlers) {
  const { signal } = deps;
  const assembler = createAssembler(handlers, requestId);
  const events = parseSSE(idleGuarded(response.body, deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS), { maxEventChars: deps.maxEventChars });
  let sawEvent = false;
  try {
    for (;;) {
      let step;
      try {
        step = await events.next();
      } catch (err) {
        if (isAbort(err, signal) || !isNetwork(err)) throw err;
        if (!sawEvent) return { retry: networkError(err, requestId) };
        throw networkError(err, requestId);
      }
      if (step.done) break;
      sawEvent = true;
      signal?.throwIfAborted();
      const { event, data } = step.value;
      const name = event === 'message' ? data?.type : event;
      if (assembler.handle(name, data)) return { message: assembler.message, stoppedAt: deps.now() };
    }
  } finally {
    await events.return().catch(() => {});
  }
  throw new ApiError({
    type: 'incomplete_stream',
    message: 'stream ended before message_stop',
    requestId,
  });
}

async function attempt(request, body, deps, handlers) {
  const { fetch, signal } = deps;
  let response;
  try {
    response = await fetch(request.url, { method: 'POST', headers: request.headers, body, signal });
  } catch (err) {
    if (isAbort(err, signal) || !(err instanceof TypeError)) throw err;
    return { retry: networkError(err) };
  }
  const requestId = response.headers.get('request-id');
  if (!response.ok) {
    const error = await errorFromResponse(response);
    if (RETRYABLE_STATUSES.has(response.status)) return { retry: error };
    throw error;
  }
  const outcome = await readStream(response, requestId, deps, handlers);
  return { ...outcome, requestId };
}

export async function streamMessage(request, deps, handlers = {}) {
  const { sleep, random, now, signal } = deps;
  const body = JSON.stringify(request.body);
  const startedAt = now();
  for (let n = 0; ; n++) {
    signal?.throwIfAborted();
    const outcome = await attempt(request, body, deps, handlers);
    if (!outcome.retry) {
      return {
        message: outcome.message,
        requestId: outcome.requestId,
        durationMs: outcome.stoppedAt - startedAt,
      };
    }
    if (n + 1 >= MAX_ATTEMPTS) throw outcome.retry;
    await sleep(outcome.retry.retryAfterMs ?? backoffMs(n, random), signal);
  }
}
