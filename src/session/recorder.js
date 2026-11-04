import { summaryMessage } from '../agent/compact.js';
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
  const toolInputs = new Map();
  let turnStart = null;
  let messageCount = 0;

  function append(record) {
    if (record.type === 'user' || record.type === 'assistant') messageCount++;
    transcript.append(record);
  }

  const handlers = {
    tool_use(event) {
      toolNames.set(event.id, event.name);
      toolInputs.set(event.id, event.input);
    },
    message_append(event) {
      if (event.kind === 'prompt' && turnStart === null) turnStart = now();
      const record = messageRecord(event);
      for (const block of event.content) {
        if (block.type !== 'tool_use') continue;
        toolNames.set(block.id, block.name);
        toolInputs.set(block.id, block.input);
      }
      if (event.kind === 'tool_results') {
        const [first] = event.content;
        record.toolUseResult = {
          name: toolNames.get(first.tool_use_id) ?? null,
          isError: first.is_error === true,
          input: toolInputs.get(first.tool_use_id) ?? null,
        };
      }
      append(record);
    },
    interrupted() {
      append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: INTERRUPT_TEXT }] }, isVisibleInTranscriptOnly: true });
    },
    compacted({ trigger, summary, preTokens, postTokens }) {
      transcript.append({
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        parentUuid: null,
        logicalParentUuid: transcript.lastUuid(),
        compactMetadata: { trigger, preTokens, postTokens },
      });
      transcript.append({ type: 'user', message: summaryMessage(summary), isVisibleInTranscriptOnly: true, isCompactSummary: true });
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
