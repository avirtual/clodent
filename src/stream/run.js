import { randomUUID } from 'node:crypto';
import { INTERRUPTED_RESULT, USER_DENIAL } from '../agent/loop.js';
import { stripModelSuffix } from '../args.js';
import { CLOSED_DENIAL } from '../repl/repl.js';
import { parseLine } from './input.js';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export async function runStream(ctx, deps) {
  const { runtime, session, output, signalExit } = ctx;
  const { stdin, warn } = deps;
  const uuid = deps.uuid ?? randomUUID;
  const queue = [];
  const asks = new Map();
  const stopHooks = new AbortController();
  let agent = null;
  let running = null;
  let wake = null;
  let ended = false;
  let caught = null;
  let buffer = '';

  function poke() {
    const resolve = wake;
    wake = null;
    resolve?.();
  }

  function ask(request, signal) {
    if (signal?.aborted) return Promise.resolve({ allow: false, reason: INTERRUPTED_RESULT });
    if (ended) return Promise.resolve({ allow: false, reason: CLOSED_DENIAL });
    const requestId = uuid();
    return new Promise((resolve) => {
      const onAbort = () => done({ allow: false, reason: INTERRUPTED_RESULT });
      const done = (verdict) => {
        signal?.removeEventListener('abort', onAbort);
        asks.delete(requestId);
        resolve(verdict);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      asks.set(requestId, { request, done });
      output.controlRequest(requestId, {
        subtype: 'can_use_tool',
        tool_name: request.name,
        display_name: request.name,
        input: request.input,
        description: request.summary,
        permission_suggestions: [],
        tool_use_id: request.id,
      });
    });
  }

  function drain() {
    const texts = [];
    for (let i = 0; i < queue.length; ) {
      if (queue[i].empty) i++;
      else texts.push(queue.splice(i, 1)[0].text);
    }
    return texts;
  }

  function onPermission(response) {
    const pending = asks.get(response.request_id);
    if (!pending) {
      warn(`stdin: no permission request ${JSON.stringify(response.request_id ?? null)} is waiting; reply ignored`);
      return;
    }
    const reply = response.response ?? {};
    if (response.subtype === 'success' && reply.behavior === 'allow') {
      pending.done({ allow: true });
      return;
    }
    const message = typeof reply.message === 'string' && reply.message !== '' ? reply.message : USER_DENIAL;
    output.permissionDenied({ toolName: pending.request.name, toolUseId: pending.request.id, message });
    pending.done({ allow: false, reason: message });
  }

  function setModel(requestId, raw) {
    if (typeof raw !== 'string' || raw === '') {
      output.controlResponse({ subtype: 'error', request_id: requestId, error: 'set_model needs a model id' });
      return;
    }
    const id = stripModelSuffix(raw);
    try {
      agent.setModel(id, runtime.setModel(id));
    } catch (err) {
      output.controlResponse({ subtype: 'error', request_id: requestId, error: err?.message ?? String(err) });
      return;
    }
    output.controlResponse({ subtype: 'success', request_id: requestId });
  }

  function onControl({ requestId, request }) {
    const subtype = request?.subtype;
    if (subtype === 'interrupt') {
      output.controlResponse({ subtype: 'success', request_id: requestId });
      running?.abort();
    } else if (subtype === 'set_model') {
      setModel(requestId, request.model);
    } else {
      output.controlResponse({ subtype: 'error', request_id: requestId, error: `unsupported control request: ${subtype}` });
    }
  }

  function onLine(raw) {
    const parsed = parseLine(raw);
    if (parsed.kind === 'ignored') {
      warn(parsed.warning);
    } else if (parsed.kind === 'user') {
      for (const warning of parsed.warnings) warn(warning);
      queue.push({ text: parsed.text, empty: parsed.empty });
      poke();
    } else if (parsed.kind === 'control_request') {
      onControl(parsed);
    } else {
      onPermission(parsed.response);
    }
  }

  function onData(chunk) {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const raw = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      onLine(raw);
    }
  }

  function onEnd() {
    if (ended) return;
    if (buffer !== '') {
      const rest = buffer;
      buffer = '';
      onLine(rest);
    }
    ended = true;
    for (const pending of [...asks.values()]) pending.done({ allow: false, reason: CLOSED_DENIAL });
    poke();
  }

  function onError(err) {
    if (err?.code !== 'EIO') warn(`stdin: ${err?.message ?? err}`);
    onEnd();
  }

  function onSignal(name) {
    if (caught !== null) {
      stopHooks.abort();
      return;
    }
    caught = name;
    running?.abort();
    poke();
  }

  async function guarded(step) {
    const controller = new AbortController();
    running = controller;
    if (caught !== null) controller.abort();
    try {
      return await step(controller.signal);
    } finally {
      running = null;
    }
  }

  async function run({ text, empty }) {
    if (empty) {
      output.emptyPrompt();
      return;
    }
    output.beginTurn();
    await guarded((signal) => agent.runTurn(text, { signal, stopSignal: stopHooks.signal }));
  }

  const offs = SIGNALS.map((name) => deps.onSignal(name, () => onSignal(name)));
  try {
    agent = runtime.open(session, { ask: ctx.stdioAsk ? ask : undefined, drain });
    await guarded((signal) => agent.fireSessionStart(ctx.resume ? 'resume' : 'startup', { signal }));
    output.init();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    while (caught === null) {
      if (queue.length > 0) await run(queue.shift());
      else if (ended) break;
      else await new Promise((resolve) => (wake = resolve));
    }
    agent.endSession();
    await runtime.statusLine.flush();
  } finally {
    stdin.off('data', onData);
    stdin.off('end', onEnd);
    stdin.off('error', onError);
    stdin.pause();
    for (const off of offs) off();
  }
  return caught === null ? 0 : signalExit[caught];
}
