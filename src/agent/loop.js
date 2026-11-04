import { ApiError } from '../api/errors.js';
import { buildRequest } from '../api/request.js';
import { streamMessage } from '../api/stream.js';
import { appendMessage } from './history.js';
import { decide } from './permission.js';

export const INTERRUPT_MARKER = '[clay: previous turn interrupted by the user]';
export const INTERRUPTED_RESULT = 'interrupted by user';
export const MID_STREAM_DELAYS_MS = Object.freeze([2000, 4000]);
const MID_STREAM_RETRYABLE = new Set(['overloaded_error', 'api_error']);

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
  const { model, effort, system, permission } = config;
  const tools = config.tools ?? [];
  const { emit, ledger, now } = deps;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const definitions = tools.map(definition);
  const history = structuredClone(config.history ?? []);
  let interruptedBefore = config.interrupted ?? false;

  emit({ type: 'session_start', model, cwd: deps.cwd, tools: tools.map((tool) => tool.name), permission });

  function append(role, blocks, kind, meta = {}) {
    appendMessage(history, role, blocks);
    emit({ type: 'message_append', role, content: blocks, kind, meta });
  }

  function addUserText(text) {
    const blocks = interruptedBefore ? [{ type: 'text', text: INTERRUPT_MARKER }] : [];
    interruptedBefore = false;
    blocks.push({ type: 'text', text });
    append('user', blocks, 'prompt');
  }

  function finish(stopReason, ok) {
    emit({ type: 'turn_end', stopReason, turn: ledger.endTurn() });
    return { stopReason, ok };
  }

  function interrupt(partial) {
    if (partial.length > 0) append('assistant', partial.map((block) => ({ ...block })), 'partial');
    interruptedBefore = true;
    emit({ type: 'interrupted' });
    return finish('interrupted', false);
  }

  async function request(signal, partial) {
    const req = buildRequest({ model, system, tools: definitions, messages: history, effort }, { env: deps.env });
    const streamDeps = { fetch: deps.fetch, sleep: deps.sleep, random: deps.random, now, signal };
    const handlers = {
      onText: (text, index) => emit({ type: 'text_delta', text, index }),
      onThinking: (text, index) => emit({ type: 'thinking_delta', text, index }),
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

  async function execute(tool, use, signal) {
    const verdict = decide(tool, use.input, permission);
    emit({
      type: 'permission',
      id: use.id,
      name: use.name,
      decision: verdict.allow ? 'allow' : 'deny',
      ...(verdict.allow ? {} : { reason: verdict.reason }),
    });
    if (!verdict.allow) return { content: verdict.reason, isError: true };
    try {
      return await tool.run(use.input, { cwd: deps.cwd, env: deps.env, signal });
    } catch (err) {
      return { content: `${use.name} failed: ${err?.message ?? err}`, isError: true };
    }
  }

  function announce(use) {
    const tool = byName.get(use.name);
    emit({ type: 'tool_use', id: use.id, name: use.name, input: use.input, summary: tool?.summary?.(use.input) ?? '' });
    return tool;
  }

  async function runTool(use, signal) {
    const tool = announce(use);
    const started = now();
    const outcome = tool
      ? await execute(tool, use, signal)
      : { content: `unknown tool ${use.name}`, isError: true };
    const result = { id: use.id, name: use.name, content: outcome.content, isError: outcome.isError, durationMs: now() - started };
    emit({ type: 'tool_result', ...result });
    return result;
  }

  async function runTools(uses, signal) {
    const results = [];
    for (const use of uses) {
      if (signal?.aborted) break;
      results.push(await runTool(use, signal));
    }
    results.push(...notRun(uses.slice(results.length)));
    append('user', results.map(resultBlock), 'tool_results');
  }

  function notRun(uses) {
    return uses.map((use) => {
      announce(use);
      const result = { id: use.id, name: use.name, content: INTERRUPTED_RESULT, isError: true, durationMs: 0 };
      emit({ type: 'tool_result', ...result });
      return result;
    });
  }

  function closeDanglingUses() {
    const last = history.at(-1);
    const uses = last?.role === 'assistant' ? last.content.filter((block) => block.type === 'tool_use') : [];
    if (uses.length === 0) return;
    append('user', notRun(uses).map(resultBlock), 'tool_results');
    interruptedBefore = true;
  }

  async function runTurn(userText, { signal } = {}) {
    closeDanglingUses();
    addUserText(userText);
    const partial = [];
    try {
      for (;;) {
        if (signal?.aborted) return interrupt(partial);
        const check = ledger.check();
        if (!check.ok) {
          emit({ type: 'budget_stop', result: check });
          return finish('budget', false);
        }
        const { message, requestId, durationMs } = await request(signal, partial);
        partial.length = 0;
        const cost = ledger.record(model, message.usage);
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
          return finish(stop, true);
        } else if (stop === 'max_tokens') {
          emit({ type: 'warning', message: 'response hit max_tokens' });
          return finish(stop, false);
        } else if (stop === 'refusal') {
          return finish(stop, false);
        } else {
          emit({ type: 'warning', message: `unexpected stop_reason ${stop}` });
          return finish(stop ?? 'unknown', false);
        }
      }
    } catch (err) {
      if (signal?.aborted) return interrupt(partial);
      emit({
        type: 'error',
        message: err?.message ?? String(err),
        errorType: err?.type ?? err?.name ?? 'error',
        status: err?.status ?? null,
      });
      return finish('error', false);
    }
  }

  return {
    runTurn,
    messages: () => structuredClone(history),
    endSession() {
      const session = ledger.session();
      emit({ type: 'session_end', session });
      return session;
    },
  };
}
