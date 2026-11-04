export const HOOK_CONTEXT_DEFAULTS = Object.freeze({ perHook: 65536, perEvent: 262144 });
export const HOOK_CONTEXT_MIN_BYTES = 1024;
export const HOOK_CONTEXT_MAX_BYTES = 16777216;

function isContinuation(byte) {
  return (byte & 0xc0) === 0x80;
}

export function contextMarker(bytes, limit) {
  return `[clodent: hook context of ${bytes} bytes truncated to ${limit}]`;
}

export function capContext(text, limit) {
  if (Buffer.byteLength(text, 'utf8') <= limit) return { text, bytes: null };
  const buf = Buffer.from(text, 'utf8');
  const marker = `\n${contextMarker(buf.length, limit)}\n`;
  const keep = limit - Buffer.byteLength(marker, 'utf8');
  let headEnd = Math.floor(keep / 2);
  while (headEnd > 0 && isContinuation(buf[headEnd])) headEnd -= 1;
  let tailStart = buf.length - (keep - Math.floor(keep / 2));
  while (tailStart < buf.length && isContinuation(buf[tailStart])) tailStart += 1;
  return { text: `${buf.subarray(0, headEnd).toString('utf8')}${marker}${buf.subarray(tailStart).toString('utf8')}`, bytes: buf.length };
}
