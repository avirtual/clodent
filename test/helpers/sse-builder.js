function event(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
}

function blockEvents(block, index) {
  const out = [];
  if (block.type === 'text') {
    out.push(event('content_block_start', { index, content_block: { type: 'text', text: '' } }));
    for (const text of [].concat(block.text)) {
      out.push(event('content_block_delta', { index, delta: { type: 'text_delta', text } }));
    }
  } else if (block.type === 'thinking') {
    out.push(event('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } }));
    out.push(event('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } }));
    out.push(event('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } }));
  } else if (block.type === 'tool_use') {
    out.push(event('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }));
    out.push(event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }));
  }
  out.push(event('content_block_stop', { index }));
  return out;
}

export function sseEvents({ blocks = [], stopReason = 'end_turn', usage = {}, model = 'claude-opus-5-5' }) {
  const { input_tokens = 100, output_tokens = 20, cache_read_input_tokens = 0, cache_creation_input_tokens = 0 } = usage;
  return [
    event('message_start', {
      message: {
        id: 'msg_builder',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens: 1 },
      },
    }),
    ...blocks.flatMap(blockEvents),
    event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens } }),
    event('message_stop', {}),
  ];
}

export function sse(spec) {
  return sseEvents(spec).join('');
}

export function sseError(type, message) {
  return event('error', { error: { type, message } });
}
