const PREVIEW = 60;
export const LINE_CAP = 64 * 1024 * 1024;

function preview(raw) {
  return raw.length > PREVIEW ? `${raw.slice(0, PREVIEW)}…` : raw;
}

export function userText(message) {
  const content = message?.content;
  if (typeof content === 'string') return { text: content, warnings: [] };
  if (!Array.isArray(content)) return { text: '', warnings: ['stdin: a user message without string or array content'] };
  const texts = [];
  const warnings = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block?.type === 'image') warnings.push('stdin: dropped an image block: image input is not supported');
    else warnings.push(`stdin: dropped a ${JSON.stringify(block?.type ?? null)} block: only text blocks are read`);
  }
  return { text: texts.join('\n\n'), warnings };
}

export function parseLine(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'ignored', warning: `stdin: ignoring a line that is not JSON: ${preview(raw)}` };
  }
  const type = value !== null && typeof value === 'object' ? value.type : undefined;
  if (type === 'user') {
    const { text, warnings } = userText(value.message);
    return { kind: 'user', text, empty: text.trim() === '', warnings };
  }
  if (type === 'control_request') {
    if (typeof value.request_id !== 'string') return { kind: 'ignored', warning: 'stdin: ignoring a control_request without a string request_id' };
    return { kind: 'control_request', requestId: value.request_id, request: value.request ?? {} };
  }
  if (type === 'control_response') {
    const response = value.response ?? {};
    if (typeof response.request_id !== 'string') return { kind: 'ignored', warning: 'stdin: ignoring a control_response without a string request_id' };
    return { kind: 'control_response', response };
  }
  return { kind: 'ignored', warning: `stdin: ignoring a message of unknown type ${JSON.stringify(type ?? null)}` };
}

export function lineSplitter({ onLine, warn, cap = LINE_CAP }) {
  let pending = '';
  let size = 0;
  let dropping = false;

  function take(text) {
    if (dropping) return;
    size += Buffer.byteLength(text);
    if (size <= cap) {
      pending += text;
      return;
    }
    pending = '';
    dropping = true;
    warn(`stdin: ignoring a line over ${cap} bytes`);
  }

  function flush() {
    const line = pending.replace(/\r$/, '');
    const dropped = dropping;
    pending = '';
    size = 0;
    dropping = false;
    if (!dropped) onLine(line);
  }

  return {
    push(chunk) {
      let from = 0;
      for (let at = chunk.indexOf('\n'); at !== -1; at = chunk.indexOf('\n', from)) {
        take(chunk.slice(from, at));
        flush();
        from = at + 1;
      }
      if (from < chunk.length) take(chunk.slice(from));
    },
    end() {
      if (pending !== '' || dropping) flush();
    },
  };
}
