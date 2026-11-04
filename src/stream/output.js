import { randomUUID } from 'node:crypto';
import { formatBudgetStop } from '../cost/format.js';
import { PERMISSION_MODES } from '../hooks/fire.js';
import { COMMAND_NAMES } from '../repl/slash.js';
import { INTERRUPT_TEXT } from '../session/transcript.js';

export const EMPTY_PROMPT = 'clodent: empty prompt (image input is not supported)';
const MADE_UP_STOPS = new Set(['budget', 'interrupted', 'error', 'unknown']);
const NO_TOKENS = Object.freeze({ in: 0, cacheRead: 0, cacheWrite: 0, out: 0 });

function textOf(content) {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function apiUsage(tokens) {
  return {
    input_tokens: tokens.in,
    cache_creation_input_tokens: tokens.cacheWrite,
    cache_read_input_tokens: tokens.cacheRead,
    output_tokens: tokens.out,
  };
}

function assistantMessage(message) {
  const { id, model, content, stop_reason, stop_sequence, usage } = message;
  return { id, type: 'message', role: 'assistant', model, content, stop_reason, stop_sequence, usage };
}

export function createStreamOutput(ctx, deps) {
  const { out, now, totalUsd } = deps;
  const uuid = deps.uuid ?? randomUUID;
  let started = { model: null, cwd: null, tools: [], permission: null };
  let turn = null;
  let command = null;
  let held = [];

  const line = (record) => out.write(`${JSON.stringify(record)}\n`);
  const sessionId = () => ctx.sessionId();

  function message(type, body) {
    line({ type, message: body, parent_tool_use_id: null, session_id: sessionId(), uuid: uuid() });
  }

  function result({ isError, text, subtype = isError ? 'error_during_execution' : 'success', stopReason = null, durationMs = 0, apiMs = 0, requests = 0, tokens = NO_TOKENS }) {
    line({
      type: 'result',
      subtype,
      is_error: isError,
      duration_ms: durationMs,
      duration_api_ms: apiMs,
      num_turns: requests,
      result: text,
      stop_reason: stopReason,
      session_id: sessionId(),
      total_cost_usd: totalUsd(),
      usage: apiUsage(tokens),
      permission_denials: [],
      uuid: uuid(),
    });
  }

  const handlers = {
    session_start({ model, cwd, tools, permission }) {
      started = { model, cwd, tools, permission };
    },
    request_start() {
      if (turn) turn.streamed = '';
    },
    text_delta({ text }) {
      if (turn) turn.streamed += text;
    },
    assistant_message({ message: received, durationMs }) {
      message('assistant', assistantMessage(received));
      if (!turn) return;
      turn.apiMs += durationMs;
      turn.streamed = '';
      if (received.stop_reason !== 'tool_use') turn.finalText = textOf(received.content);
    },
    message_append({ kind, role, content }) {
      if (kind === 'tool_results') message('user', { role, content });
      if (kind === 'partial') message('assistant', { role, content, stop_reason: null });
    },
    interrupted() {
      message('user', { role: 'user', content: [{ type: 'text', text: INTERRUPT_TEXT }] });
    },
    error({ message: text }) {
      if (turn) turn.error = text;
    },
    compacted({ trigger, preTokens, postTokens }) {
      line({
        type: 'system',
        subtype: 'compact_boundary',
        session_id: sessionId(),
        uuid: uuid(),
        compact_metadata: { trigger, pre_tokens: preTokens, post_tokens: postTokens },
      });
    },
    warning({ hookContext }) {
      if (!hookContext) return;
      const { event, scope, bytes, limit } = hookContext;
      const record = { type: 'system', subtype: 'hook_context_truncated', hook_event: event, scope, bytes, limit, session_id: sessionId(), uuid: uuid() };
      if (held) held.push(record);
      else line(record);
    },
    budget_stop({ result: check }) {
      if (turn) turn.error = formatBudgetStop(check);
    },
    turn_end({ stopReason, turn: spent }) {
      const current = turn ?? fresh();
      turn = null;
      const isError = stopReason === 'error' || stopReason === 'budget';
      const text = isError ? (current.error ?? '') : stopReason === 'interrupted' ? current.streamed : current.finalText;
      result({
        isError,
        text,
        stopReason: MADE_UP_STOPS.has(stopReason) ? null : stopReason,
        durationMs: Math.round(now() - current.startedAt),
        apiMs: Math.round(current.apiMs),
        requests: spent.requests,
        tokens: spent.tokens,
      });
    },
  };

  function fresh() {
    return { startedAt: now(), apiMs: 0, finalText: '', streamed: '', error: null };
  }

  return {
    event(event) {
      handlers[event.type]?.(event);
    },
    init() {
      line({
        type: 'system',
        subtype: 'init',
        cwd: started.cwd,
        session_id: sessionId(),
        model: started.model,
        tools: started.tools,
        permissionMode: PERMISSION_MODES[started.permission] ?? started.permission,
        slash_commands: [...COMMAND_NAMES],
        apiKeySource: 'ANTHROPIC_API_KEY',
        clodent_version: ctx.version,
        uuid: uuid(),
      });
      for (const record of held ?? []) line(record);
      held = null;
    },
    beginTurn() {
      turn = fresh();
    },
    emptyPrompt() {
      result({ isError: true, text: EMPTY_PROMPT });
    },
    beginCommand() {
      command = { startedAt: now() };
    },
    status(status, fields = {}) {
      line({ type: 'system', subtype: 'status', status, ...fields, session_id: sessionId(), uuid: uuid() });
    },
    conversationReset(newId) {
      held = [];
      line({ type: 'conversation_reset', new_conversation_id: newId, trigger: 'clear', session_id: sessionId(), uuid: uuid() });
    },
    endCommand({ isError, text, requests = 0, tokens = NO_TOKENS }) {
      const current = command;
      command = null;
      result({ isError, text, subtype: 'success', durationMs: Math.round(now() - current.startedAt), requests, tokens });
    },
    controlRequest(requestId, request) {
      line({ type: 'control_request', request_id: requestId, request });
    },
    controlResponse(response) {
      line({ type: 'control_response', response });
    },
    permissionDenied({ toolName, toolUseId, message: text }) {
      line({ type: 'system', subtype: 'permission_denied', tool_name: toolName, tool_use_id: toolUseId, message: text, session_id: sessionId(), uuid: uuid() });
    },
  };
}
