import { ApiError } from '../api/errors.js';
import { buildRequest } from '../api/request.js';
import { streamMessage } from '../api/stream.js';
import { emptyOutcome, hookContextBlock, NO_HOOKS } from '../hooks/fire.js';
import { denialReason, OPEN_GUARD } from '../permissions/guard.js';
import { COMPACT_TOOL_CHOICE, compactMessages, compactTokens, NOTHING_TO_COMPACT, RELOAD_BUDGET_BYTES, reloadBlock, reloadPaths, summaryMessage, summaryOf } from './compact.js';
import { appendMessage } from './history.js';
import { ASK_DENIAL, asksInMode, decide } from './permission.js';

export const INTERRUPT_MARKER = '[clodent: previous turn interrupted by the user]';
export const INTERRUPTED_RESULT = 'interrupted by user';
export const USER_DENIAL = 'denied by the user';
export const MID_STREAM_DELAYS_MS = Object.freeze([2000, 4000]);
const MID_STREAM_RETRYABLE = new Set(['overloaded_error', 'api_error']);
const ALLOWED = Object.freeze({ allow: true });
const NO_HOOK_DECISION = Object.freeze({});
const RELOAD_SKIPS = Object.freeze({ deny: 'denied', ask: 'ask' });

function isMidStreamRetryable(err) {
  return err instanceof ApiError && err.status === null && MID_STREAM_RETRYABLE.has(err.type);
}

function definition({ name, description, input_schema }) {
  return { name, description, input_schema };
}

function resultBlock({ id, content, isError }) {
  return { type: 'tool_result', tool_use_id: id, content, is_error: isError };
}

export function createAgent(config, deps) {
  const { effort, permission, baseUrl, sessionId, cacheTtl } = config;
  let { model, system } = config;
  const tools = config.tools ?? [];
  const { emit, ledger, now } = deps;
  const hooks = deps.hooks ?? NO_HOOKS;
  const guard = deps.guard ?? OPEN_GUARD;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const reloadCount = byName.has('Read') ? (config.compactReloadFiles ?? 0) : 0;
  const definitions = tools.map(definition);
  const history = structuredClone(config.history ?? []);
  let interruptedBefore = config.interrupted ?? false;
  let heldContext = [];

  emit({ type: 'session_start', model, cwd: deps.cwd, tools: tools.map((tool) => tool.name), permission });

  function append(role, blocks, kind, meta = {}) {
    appendMessage(history, role, blocks);
    emit({ type: 'message_append', role, content: blocks, kind, meta });
  }

  async function fireHook(event, extra, signal) {
    if (signal?.aborted) return emptyOutcome();
    const outcome = await hooks.fire(event, extra, signal);
    for (const message of outcome.warnings) emit({ type: 'warning', message });
    return outcome;
  }

  function addUserText(text, submitContext) {
    const blocks = interruptedBefore ? [{ type: 'text', text: INTERRUPT_MARKER }] : [];
    interruptedBefore = false;
    const held = hookContextBlock('SessionStart', heldContext);
    heldContext = [];
    if (held) blocks.push(held);
    blocks.push({ type: 'text', text });
    const submitted = hookContextBlock('UserPromptSubmit', submitContext);
    if (submitted) blocks.push(submitted);
    append('user', blocks, 'prompt');
  }

  async function finish(stopReason, ok, stopSignal) {
    emit({ type: 'turn_end', stopReason, turn: ledger.endTurn() });
    await fireHook('Stop', { stop_hook_active: false }, stopSignal);
    return { stopReason, ok };
  }

  async function interrupt(partial, stopSignal) {
    if (partial.length > 0) append('assistant', partial.map((block) => ({ ...block })), 'partial');
    interruptedBefore = true;
    emit({ type: 'interrupted' });
    return finish('interrupted', false, stopSignal);
  }

  async function request(signal, partial, { messages = history, toolChoice, quiet = false } = {}) {
    const req = buildRequest({ model, system, tools: definitions, messages, effort, baseUrl, toolChoice, sessionId, cacheTtl }, { env: deps.env });
    const streamDeps = { fetch: deps.fetch, sleep: deps.sleep, random: deps.random, now, signal };
    const stream = quiet ? () => {} : emit;
    const handlers = {
      onText: (text, index) => stream({ type: 'text_delta', text, index }),
      onThinking: (text, index) => stream({ type: 'thinking_delta', text, index }),
      onBlockStop: (block) => {
        if (block.type === 'text' && block.text) partial.push(block);
      },
    };
    for (let attempt = 1; ; attempt++) {
      partial.length = 0;
      emit({ type: 'request_start', attempt });
      try {
        return await streamMessage(req, streamDeps, handlers);
      } catch (err) {
        const wait = MID_STREAM_DELAYS_MS[attempt - 1];
        if (signal?.aborted || !isMidStreamRetryable(err) || wait === undefined) throw err;
        partial.length = 0;
        emit({ type: 'warning', message: `${err.message}; retrying in ${wait / 1000} s` });
        await deps.sleep(wait, signal);
      }
    }
  }

  function verdictFor(tool, input, pre, ruled) {
    if (pre.decision === 'deny') return { allow: false, reason: pre.reason };
    if (ruled?.decision === 'deny') return { allow: false, reason: denialReason(ruled.rule) };
    if (ruled?.decision === 'ask' && permission !== 'yolo') return { allow: false, ask: asksInMode(permission), reason: ASK_DENIAL };
    if (pre.decision === 'allow' && asksInMode(permission)) return ALLOWED;
    return decide(tool, input, permission);
  }

  async function askUser(tool, use, input, signal) {
    const request = { id: use.id, name: use.name, input, summary: tool.summary?.(input) ?? '' };
    emit({ type: 'permission_request', ...request });
    const notice = {
      notification_type: 'permission_prompt',
      title: 'Permission needed',
      message: `clodent needs your permission to use ${use.name}`,
      tool: use.name,
      id: use.id,
    };
    const [answer] = await Promise.all([config.ask(request, signal), fireHook('Notification', notice, signal)]);
    if (signal?.aborted) return { allow: false, reason: INTERRUPTED_RESULT };
    return answer?.allow ? ALLOWED : { allow: false, reason: answer?.reason ?? USER_DENIAL };
  }

  async function execute(tool, use, input, pre, signal) {
    let ruled = null;
    let hidden = null;
    let approved = null;
    if (guard.active) {
      ({ ruled, hidden, approved } = await guard.screen(tool.name, input, deps.cwd, permission));
      if (signal?.aborted) return { content: INTERRUPTED_RESULT, isError: true, ran: false };
    }
    let verdict = verdictFor(tool, input, pre, ruled);
    if (verdict.ask && config.ask) {
      verdict = await askUser(tool, use, input, signal);
      if (verdict.allow) hidden = approved;
    }
    emit({
      type: 'permission',
      id: use.id,
      name: use.name,
      decision: verdict.allow ? 'allow' : 'deny',
      ...(verdict.allow ? {} : { reason: verdict.reason }),
    });
    if (!verdict.allow) return { content: verdict.reason, isError: true, ran: false };
    try {
      const outcome = await tool.run(input, { cwd: deps.cwd, env: deps.env, signal, hidden });
      return { content: outcome.content, isError: outcome.isError, ran: true };
    } catch (err) {
      return { content: `${use.name} failed: ${err?.message ?? err}`, isError: true, ran: true };
    }
  }

  function announce(use, input = use.input) {
    const tool = byName.get(use.name);
    emit({ type: 'tool_use', id: use.id, name: use.name, input, summary: tool?.summary?.(input) ?? '' });
  }

  function toolResult(use, outcome, durationMs) {
    const result = { id: use.id, name: use.name, content: outcome.content, isError: outcome.isError, durationMs };
    emit({ type: 'tool_result', ...result });
    return result;
  }

  async function runTool(use, signal, post) {
    const tool = byName.get(use.name);
    if (!tool) {
      announce(use);
      return toolResult(use, { content: `unknown tool ${use.name}`, isError: true }, 0);
    }
    const fields = { tool_name: use.name, tool_input: use.input, tool_use_id: use.id };
    const pre = await fireHook('PreToolUse', fields, signal);
    const input = pre.updatedInput ?? use.input;
    announce(use, input);
    if (signal?.aborted) return toolResult(use, { content: INTERRUPTED_RESULT, isError: true }, 0);
    const started = now();
    const outcome = await execute(tool, use, input, pre, signal);
    const result = toolResult(use, outcome, now() - started);
    if (outcome.ran) {
      const event = outcome.isError ? 'PostToolUseFailure' : 'PostToolUse';
      const tool_response = { content: outcome.content, isError: outcome.isError };
      const extra = outcome.isError ? { error: outcome.content } : {};
      const after = await fireHook(event, { ...fields, tool_input: input, tool_response, ...extra }, signal);
      post[event].push(...after.additionalContext);
    }
    return result;
  }

  async function runTools(uses, signal) {
    const results = [];
    const post = { PostToolUse: [], PostToolUseFailure: [] };
    for (const use of uses) {
      if (signal?.aborted) break;
      results.push(await runTool(use, signal, post));
    }
    results.push(...notRun(uses.slice(results.length)));
    const blocks = results.map(resultBlock);
    for (const [event, texts] of Object.entries(post)) {
      const block = hookContextBlock(event, texts);
      if (block) blocks.push(block);
    }
    if (!signal?.aborted) for (const text of config.drain?.() ?? []) blocks.push({ type: 'text', text });
    append('user', blocks, 'tool_results');
  }

  function notRun(uses) {
    return uses.map((use) => {
      announce(use);
      return toolResult(use, { content: INTERRUPTED_RESULT, isError: true }, 0);
    });
  }

  function closeDanglingUses() {
    const last = history.at(-1);
    const uses = last?.role === 'assistant' ? last.content.filter((block) => block.type === 'tool_use') : [];
    if (uses.length === 0) return;
    append('user', notRun(uses).map(resultBlock), 'tool_results');
    interruptedBefore = true;
  }

  async function runTurn(userText, { signal, stopSignal } = {}) {
    closeDanglingUses();
    const submit = await fireHook('UserPromptSubmit', { prompt: userText }, signal);
    addUserText(userText, submit.additionalContext);
    const partial = [];
    try {
      for (;;) {
        if (signal?.aborted) return interrupt(partial, stopSignal);
        const check = ledger.check();
        if (!check.ok) {
          emit({ type: 'budget_stop', result: check });
          return finish('budget', false, stopSignal);
        }
        const sentModel = model;
        const { message, requestId, durationMs } = await request(signal, partial);
        partial.length = 0;
        const cost = ledger.record(sentModel, message.usage);
        append('assistant', message.content, 'assistant', { message, requestId, durationMs, usd: cost.usd });
        emit({ type: 'assistant_message', message, requestId, durationMs, usd: cost.usd, priced: cost.priced });
        const stop = message.stop_reason;
        const uses = message.content.filter((block) => block.type === 'tool_use');
        if (stop === 'tool_use' && uses.length > 0) {
          await runTools(uses, signal);
          continue;
        }
        if (uses.length > 0) append('user', notRun(uses).map(resultBlock), 'tool_results');
        if (stop === 'pause_turn') {
          continue;
        } else if (stop === 'end_turn' || stop === 'stop_sequence') {
          return finish(stop, true, stopSignal);
        } else if (stop === 'max_tokens') {
          emit({ type: 'warning', message: 'response hit max_tokens' });
          return finish(stop, false, stopSignal);
        } else if (stop === 'refusal') {
          return finish(stop, false, stopSignal);
        } else {
          emit({ type: 'warning', message: `unexpected stop_reason ${stop}` });
          return finish(stop ?? 'unknown', false, stopSignal);
        }
      }
    } catch (err) {
      if (signal?.aborted) return interrupt(partial, stopSignal);
      emit({
        type: 'error',
        message: err?.message ?? String(err),
        errorType: err?.type ?? err?.name ?? 'error',
        status: err?.status ?? null,
      });
      return finish('error', false, stopSignal);
    }
  }

  async function fireSessionStart(source, { signal } = {}) {
    const outcome = await fireHook('SessionStart', { source, model }, signal);
    heldContext.push(...outcome.additionalContext);
    return outcome;
  }

  async function summarise(instructions, signal) {
    try {
      const { message } = await request(signal, [], { messages: compactMessages(history, instructions, reloadCount), toolChoice: COMPACT_TOOL_CHOICE, quiet: true });
      return { message };
    } catch (err) {
      return { reason: signal?.aborted ? 'interrupted' : (err?.message ?? String(err)) };
    }
  }

  async function reloadOne(path, signal) {
    const input = { file_path: path };
    const ruled = guard.active ? (await guard.screen('Read', input, deps.cwd, permission)).ruled : null;
    const tool = byName.get('Read');
    const verdict = tool ? verdictFor(tool, input, NO_HOOK_DECISION, ruled) : { allow: false, reason: 'unknown tool Read' };
    if (!verdict.allow) return { reason: RELOAD_SKIPS[ruled?.decision] ?? verdict.reason };
    try {
      const outcome = await tool.run(input, { cwd: deps.cwd, env: deps.env, signal, hidden: null });
      return outcome.isError ? { reason: outcome.content } : { output: outcome.content };
    } catch (err) {
      return { reason: `Read failed: ${err?.message ?? err}` };
    }
  }

  async function reloadFiles(paths, signal) {
    const files = { blocks: [], reloaded: [], skipped: [] };
    let spent = 0;
    for (const path of paths) {
      const { output, reason } = signal?.aborted ? { reason: 'interrupted' } : await reloadOne(path, signal);
      const bytes = output === undefined ? 0 : Buffer.byteLength(output);
      const skip = reason ?? (spent + bytes > RELOAD_BUDGET_BYTES ? 'budget' : null);
      if (skip !== null) {
        files.skipped.push({ path, reason: skip });
        continue;
      }
      spent += bytes;
      files.reloaded.push({ path, bytes });
      files.blocks.push(reloadBlock(path, output));
    }
    return files;
  }

  async function compact({ instructions, trigger } = {}, { signal } = {}) {
    if (history.length === 0) return { ok: false, reason: NOTHING_TO_COMPACT };
    closeDanglingUses();
    await fireHook('PreCompact', { trigger, custom_instructions: instructions ?? '' }, signal);
    if (signal?.aborted) return { ok: false, reason: 'interrupted' };
    const check = ledger.check();
    if (!check.ok) {
      emit({ type: 'budget_stop', result: check });
      return { ok: false, reason: 'budget' };
    }
    const { message, reason } = await summarise(instructions, signal);
    if (!message) return { ok: false, reason };
    ledger.record(model, message.usage);
    const summary = summaryOf(message);
    if (message.stop_reason !== 'end_turn' || summary.trim() === '') {
      return { ok: false, reason: message.stop_reason === 'end_turn' ? 'empty summary' : `stop_reason ${message.stop_reason}`, turn: ledger.endTurn() };
    }
    const { preTokens, postTokens } = compactTokens(message.usage);
    const { blocks, reloaded, skipped } = await reloadFiles(reloadPaths(summary, history, { cwd: deps.cwd, count: reloadCount }), signal);
    const next = summaryMessage(summary, blocks);
    history.splice(0, history.length, next);
    interruptedBefore = false;
    const turn = ledger.endTurn();
    emit({ type: 'compacted', trigger, summary, message: structuredClone(next), reloaded, skipped, preTokens, postTokens, turn });
    await fireSessionStart('compact', { signal });
    return { ok: true, preTokens, postTokens, turn };
  }

  return {
    runTurn,
    compact,
    fireSessionStart,
    messages: () => structuredClone(history),
    setModel(nextModel, nextSystem) {
      model = nextModel;
      system = nextSystem;
    },
    endSession() {
      const session = ledger.session();
      emit({ type: 'session_end', session });
      return session;
    },
  };
}
