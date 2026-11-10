import { randomUUID } from 'node:crypto';
import { INTERRUPTED_RESULT, USER_DENIAL } from '../agent/loop.js';
import { CLOSED_DENIAL } from '../repl/repl.js';
import { parseCommand, runCommand } from '../repl/slash.js';
import { lineSplitter, parseLine } from './input.js';

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
  const lines = lineSplitter({ onLine, warn });
  let turnId = 0;
  let inTurn = false;
  let pendingInterrupt = false;
  let printed = [];
  let failed = false;
  let spent;
  let failure = {};

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
      const onAbort = () => cancel(INTERRUPTED_RESULT);
      const done = (verdict) => {
        signal?.removeEventListener('abort', onAbort);
        asks.delete(requestId);
        resolve(verdict);
      };
      const cancel = (reason) => {
        output.controlCancelRequest(requestId);
        done({ allow: false, reason });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      asks.set(requestId, { request, done, cancel });
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
    while (queue.length > 0 && !queue[0].command && !queue[0].empty && queue[0].turn === turnId) texts.push(queue.shift().text);
    return texts;
  }

  function onPermission(response) {
    const pending = asks.get(response.request_id);
    if (!pending) {
      warn(`stdin: no permission request ${JSON.stringify(response.request_id)} is waiting; reply ignored`);
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
    try {
      const next = runtime.setModel(raw);
      agent.setModel(next.model, next.system);
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
      if (running && (!inTurn || output.turnOpen())) running.abort();
      else if (queue.some((entry) => !entry.empty)) pendingInterrupt = true;
    } else if (subtype === 'set_model') {
      setModel(requestId, request.model);
    } else {
      output.controlResponse({ subtype: 'error', request_id: requestId, error: `unsupported control request: ${subtype}` });
    }
  }

  function commandOf(text) {
    const trimmed = text.trim();
    return parseCommand({ text: trimmed, parts: [{ kind: 'typed', text: trimmed }] });
  }

  function onLine(raw) {
    if (raw.trim() === '') return;
    const parsed = parseLine(raw);
    if (parsed.kind === 'ignored') {
      warn(parsed.warning);
    } else if (parsed.kind === 'user') {
      for (const warning of parsed.warnings) warn(warning);
      queue.push({ text: parsed.text, empty: parsed.empty, command: commandOf(parsed.text), turn: inTurn ? turnId : null });
      poke();
    } else if (parsed.kind === 'control_request') {
      onControl(parsed);
    } else {
      onPermission(parsed.response);
    }
  }

  function onData(chunk) {
    lines.push(chunk);
  }

  function onEnd() {
    if (ended) return;
    lines.end();
    ended = true;
    for (const pending of [...asks.values()]) pending.cancel(CLOSED_DENIAL);
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
    if (caught !== null || pendingInterrupt) controller.abort();
    pendingInterrupt = false;
    try {
      return await step(controller.signal);
    } finally {
      running = null;
    }
  }

  function openAgent(next) {
    agent = runtime.open(next, { ask: ctx.stdioAsk ? ask : undefined, drain });
  }

  async function clearSession() {
    const next = runtime.freshSession();
    if (!next.ok) {
      printed.push(`clodent: ${next.error}`);
      failed = true;
      return;
    }
    output.conversationReset(next.sessionId);
    ctx.useSession(next);
    openAgent(next);
    runtime.resetStatus(next);
    await guarded((signal) => agent.fireSessionStart('clear', { signal }));
    output.init();
  }

  async function compactSession(instructions) {
    output.status('compacting');
    const outcome = await guarded((signal) => agent.compact({ instructions, trigger: 'manual' }, { signal }));
    output.status(null, { compact_result: outcome.ok ? 'success' : 'failed' });
    failed = !outcome.ok;
    spent = outcome.turn?.tokens;
    failure = { apiError: outcome.apiError, tooLong: outcome.contextWindowExceeded };
    return outcome;
  }

  const commandCtx = {
    print: (line) => printed.push(line),
    ledger: runtime.ledger,
    model: () => runtime.model(),
    setModel(raw) {
      const next = runtime.setModel(raw);
      agent.setModel(next.model, next.system);
    },
    clear: clearSession,
    compact: compactSession,
  };

  async function runSlash(command) {
    printed = [];
    failed = false;
    spent = undefined;
    failure = {};
    output.beginCommand();
    const verdict = await runCommand(command, commandCtx);
    pendingInterrupt = false;
    if (verdict === 'exit') return 'exit';
    output.endCommand({ isError: failed || verdict === 'unknown', text: printed.join('\n'), requests: command.name === 'compact' ? 1 : 0, tokens: spent, ...failure });
  }

  async function run({ text, empty, command }) {
    if (empty) {
      output.emptyPrompt();
      return;
    }
    if (command) return runSlash(command);
    output.beginTurn();
    turnId++;
    inTurn = true;
    try {
      await guarded((signal) => agent.runTurn(text, { signal, stopSignal: stopHooks.signal }));
    } finally {
      inTurn = false;
    }
  }

  const offs = SIGNALS.map((name) => deps.onSignal(name, () => onSignal(name)));
  try {
    openAgent(session);
    await guarded((signal) => agent.fireSessionStart(ctx.resume ? 'resume' : 'startup', { signal }));
    output.init();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    while (caught === null) {
      if (queue.length > 0) {
        if ((await run(queue.shift())) === 'exit') break;
      } else if (ended) break;
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
