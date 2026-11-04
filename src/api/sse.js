import { ApiError, StreamFault } from './errors.js';

const LF = 10;
const CR = 13;
const MIB = 1024 * 1024;
export const MAX_EVENT_CHARS = 16 * MIB;

function sizeLabel(chars) {
  return chars % MIB === 0 ? `${chars / MIB} MiB` : `${chars} chars`;
}

function createLineSplitter() {
  let parts = [];
  let size = 0;
  let skipLF = false;

  function take(text, start, end) {
    parts.push(text.slice(start, end));
    const line = parts.length === 1 ? parts[0] : parts.join('');
    parts = [];
    size = 0;
    return line;
  }

  return {
    feed(text) {
      const lines = [];
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (skipLF) {
          skipLF = false;
          if (code === LF) {
            start = i + 1;
            continue;
          }
        }
        if (code === LF || code === CR) {
          lines.push(take(text, start, i));
          start = i + 1;
          skipLF = code === CR;
        }
      }
      if (start < text.length) {
        parts.push(text.slice(start));
        size += text.length - start;
      }
      return lines;
    },
    end() {
      return size > 0 ? [take('', 0, 0)] : [];
    },
    size: () => size,
  };
}

function createEventBuilder() {
  let eventName = '';
  let dataLines = [];
  let size = 0;
  return {
    size: () => size,
    line(line) {
      if (line === '') {
        size = 0;
        if (dataLines.length === 0) {
          eventName = '';
          return null;
        }
        return this.flush();
      }
      size += line.length + 1;
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
      size = 0;
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

export async function* parseSSE(byteIterable, { maxEventChars = MAX_EVENT_CHARS } = {}) {
  const decoder = new TextDecoder('utf-8');
  const splitter = createLineSplitter();
  const builder = createEventBuilder();
  const overCap = () => new StreamFault(`SSE event over ${sizeLabel(maxEventChars)}`);
  function accept(line) {
    const event = builder.line(line);
    if (builder.size() > maxEventChars) throw overCap();
    return event;
  }
  for await (const chunk of byteIterable) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    for (const line of splitter.feed(text)) {
      const event = accept(line);
      if (event) yield event;
    }
    if (builder.size() + splitter.size() > maxEventChars) throw overCap();
  }
  for (const line of [...splitter.feed(decoder.decode()), ...splitter.end()]) {
    const event = accept(line);
    if (event) yield event;
  }
  const last = builder.flush();
  if (last) yield last;
}
