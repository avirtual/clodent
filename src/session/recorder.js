import { INTERRUPT_TEXT } from './transcript.js';

function messageRecord({ role, content, kind, meta }) {
  if (kind === 'assistant') {
    return { type: 'assistant', message: meta.message, requestId: meta.requestId, costUsd: meta.usd, durationMs: Math.round(meta.durationMs) };
  }
  if (kind === 'partial') return { type: 'assistant', message: { role, content, stop_reason: null } };
  return { type: 'user', message: { role, content } };
}

function byToolResult(content) {
  const groups = [];
  for (const block of content) {
    if (block.type === 'tool_result' || groups.length === 0) groups.push([block]);
    else groups.at(-1).push(block);
  }
  return groups;
}

export function createRecorder(transcript, { now }) {
  const toolNames = new Map();
  const toolInputs = new Map();
  const toolResults = new Map();
  let turnStart = null;
  let messageCount = 0;

  function append(record) {
    if (record.type === 'user' || record.type === 'assistant') messageCount++;
    transcript.append(record);
  }

  function toolUseResult(block) {
    const id = block.tool_use_id;
    const structured = toolResults.get(id);
    toolResults.delete(id);
    return { name: toolNames.get(id) ?? null, isError: block.is_error === true, input: toolInputs.get(id) ?? null, ...structured };
  }

  const handlers = {
    tool_use(event) {
      toolNames.set(event.id, event.name);
      toolInputs.set(event.id, event.input);
    },
    tool_result(event) {
      if (event.structured) toolResults.set(event.id, event.structured);
    },
    message_append(event) {
      if (turnStart === null) transcript.refreshBranch();
      if (event.kind === 'prompt' && turnStart === null) turnStart = now();
      for (const block of event.content) {
        if (block.type !== 'tool_use') continue;
        toolNames.set(block.id, block.name);
        toolInputs.set(block.id, block.input);
      }
      if (event.kind !== 'tool_results') {
        append(messageRecord(event));
        return;
      }
      for (const content of byToolResult(event.content)) {
        const record = messageRecord({ ...event, content });
        if (content[0].type === 'tool_result') record.toolUseResult = toolUseResult(content[0]);
        append(record);
      }
    },
    side_request({ subtype, toolUseId, model, requestId, usage, usd, durationMs }) {
      transcript.append({ type: 'system', subtype, toolUseId, model, requestId, usage, costUsd: usd, durationMs: Math.round(durationMs) });
    },
    interrupted() {
      append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: INTERRUPT_TEXT }] }, isVisibleInTranscriptOnly: true });
    },
    compacted({ trigger, message, reloaded, preTokens, postTokens }) {
      transcript.append({
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        parentUuid: null,
        logicalParentUuid: transcript.lastUuid(),
        compactMetadata: { trigger, preTokens, postTokens, reloadedFiles: reloaded.map((file) => file.path) },
      });
      transcript.append({ type: 'user', message, isVisibleInTranscriptOnly: true, isCompactSummary: true });
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
