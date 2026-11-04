const PREVIEW = 60;

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
  if (type === 'control_request') return { kind: 'control_request', requestId: value.request_id, request: value.request ?? {} };
  if (type === 'control_response') return { kind: 'control_response', response: value.response ?? {} };
  return { kind: 'ignored', warning: `stdin: ignoring a message of unknown type ${JSON.stringify(type ?? null)}` };
}
