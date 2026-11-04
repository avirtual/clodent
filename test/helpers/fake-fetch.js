import { readFileSync } from 'node:fs';

const FIXTURE_DIR = new URL('../fixtures/sse/', import.meta.url);
const FIXTURE_NAME = /^[\w-]+\.sse$/;
const encoder = new TextEncoder();
export const STALL = Symbol('stall');

export function readFixture(name) {
  return readFileSync(new URL(name, FIXTURE_DIR), 'utf8');
}

function toBytes(part) {
  return typeof part === 'string' ? encoder.encode(part) : part;
}

function splitEvery(bytes, n) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += n) parts.push(bytes.subarray(i, i + n));
  return parts;
}

function chunksFor(body, chunkEvery) {
  if (body === undefined || body === null) return [];
  const parts = Array.isArray(body)
    ? body
    : [typeof body === 'string' && FIXTURE_NAME.test(body) ? readFixture(body) : body];
  if (!chunkEvery) return parts.map((part) => (part instanceof Error || part === STALL ? part : toBytes(part)));
  const out = [];
  for (const part of parts) {
    if (part instanceof Error || part === STALL) out.push(part);
    else out.push(...splitEvery(toBytes(part), chunkEvery));
  }
  return out;
}

function streamOf(chunks, signal) {
  let i = 0;
  let onAbort;
  return new ReadableStream({
    start(controller) {
      if (!signal) return;
      onAbort = () => controller.error(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    },
    pull(controller) {
      if (i >= chunks.length) {
        signal?.removeEventListener('abort', onAbort);
        controller.close();
        return;
      }
      const chunk = chunks[i++];
      if (chunk === STALL) return new Promise(() => {});
      if (chunk instanceof Error) controller.error(chunk);
      else controller.enqueue(chunk);
    },
    cancel() {
      signal?.removeEventListener('abort', onAbort);
    },
  });
}

function parseBody(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function createFakeFetch(responses, { chunkEvery } = {}) {
  const queue = [...responses];
  const calls = [];
  async function fakeFetch(url, init = {}) {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers)),
      body: parseBody(init.body),
    });
    const next = queue.shift();
    if (!next) {
      throw new Error(`fake-fetch: no response left for call ${calls.length} (${url})`);
    }
    if (init.signal?.aborted) throw init.signal.reason;
    if (next.error) throw next.error;
    const { status = 200, headers = {}, body } = next;
    const chunks = chunksFor(body, next.chunkEvery ?? chunkEvery);
    return new Response(streamOf(chunks, init.signal), { status, headers });
  }
  fakeFetch.calls = calls;
  fakeFetch.remaining = () => queue.length;
  return fakeFetch;
}
