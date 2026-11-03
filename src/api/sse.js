import { ApiError } from './errors.js';

const LF = 10;
const CR = 13;

function splitLines(text, final) {
  const lines = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === LF) {
      lines.push(text.slice(start, i));
      start = i + 1;
    } else if (code === CR) {
      if (i + 1 === text.length && !final) break;
      lines.push(text.slice(start, i));
      if (text.charCodeAt(i + 1) === LF) i++;
      start = i + 1;
    }
    i++;
  }
  return { lines, rest: text.slice(start) };
}

function createEventBuilder() {
  let eventName = '';
  let dataLines = [];
  return {
    line(line) {
      if (line === '') {
        if (dataLines.length === 0) {
          eventName = '';
          return null;
        }
        return this.flush();
      }
      if (line.startsWith(':')) return null;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
      return null;
    },
    flush() {
      if (dataLines.length === 0) return null;
      const raw = dataLines.join('\n');
      const event = eventName || 'message';
      eventName = '';
      dataLines = [];
      try {
        return { event, data: JSON.parse(raw) };
      } catch (cause) {
        throw new ApiError({
          type: 'invalid_sse',
          message: `unparseable SSE data for event ${event}: ${raw.slice(0, 200)}`,
          cause,
        });
      }
    },
  };
}

export async function* parseSSE(byteIterable) {
  const decoder = new TextDecoder('utf-8');
  const builder = createEventBuilder();
  let buffer = '';
  for await (const chunk of byteIterable) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const { lines, rest } = splitLines(buffer, false);
    buffer = rest;
    for (const line of lines) {
      const event = builder.line(line);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  const { lines, rest } = splitLines(buffer, true);
  if (rest !== '') lines.push(rest);
  for (const line of lines) {
    const event = builder.line(line);
    if (event) yield event;
  }
  const last = builder.flush();
  if (last) yield last;
}
