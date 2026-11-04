import { INTERRUPT_TEXT } from './transcript.js';

function messageRecord({ role, content, kind, meta }) {
  if (kind === 'assistant') {
    return { type: 'assistant', message: meta.message, requestId: meta.requestId, costUsd: meta.usd, durationMs: Math.round(meta.durationMs) };
  }
  if (kind === 'partial') return { type: 'assistant', message: { role, content, stop_reason: null } };
  return { type: 'user', message: { role, content } };
}

export function createRecorder(transcript, { now }) {
  const toolNames = new Map();
  let turnStart = null;
  let messageCount = 0;

  function append(record) {
    if (record.type === 'user' || record.type === 'assistant') messageCount++;
    transcript.append(record);
  }

  const handlers = {
    tool_use(event) {
      toolNames.set(event.id, event.name);
    },
    message_append(event) {
      if (event.kind === 'prompt' && turnStart === null) turnStart = now();
      const record = messageRecord(event);
      for (const block of event.content) {
        if (block.type === 'tool_use') toolNames.set(block.id, block.name);
      }
      if (event.kind === 'tool_results') {
        const [first] = event.content;
        record.toolUseResult = { name: toolNames.get(first.tool_use_id) ?? null, isError: first.is_error === true };
      }
      append(record);
    },
    interrupted() {
      append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: INTERRUPT_TEXT }] }, isVisibleInTranscriptOnly: true });
    },
    turn_end() {
      const durationMs = turnStart === null ? 0 : Math.round(now() - turnStart);
      transcript.append({ type: 'system', subtype: 'turn_duration', durationMs, messageCount });
      turnStart = null;
      messageCount = 0;
    },
  };

  return (event) => {
    handlers[event.type]?.(event);
  };
}
