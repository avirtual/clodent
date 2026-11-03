export const RESULT_MAX_BYTES = 32768;
const HALF = RESULT_MAX_BYTES / 2;

function isContinuation(byte) {
  return (byte & 0xc0) === 0x80;
}

function joinCut(head, tail, total) {
  let headEnd = HALF;
  while (headEnd > 0 && isContinuation(head[headEnd])) headEnd -= 1;
  const tailOffset = total - tail.length;
  let tailStart = total - HALF;
  while (tailStart < total && isContinuation(tail[tailStart - tailOffset])) tailStart += 1;
  const omitted = tailStart - headEnd;
  const kept = [head.subarray(0, headEnd), tail.subarray(tailStart - tailOffset)];
  return `${kept[0].toString('utf8')}\n[clay: truncated ${omitted} bytes]\n${kept[1].toString('utf8')}`;
}

export function capResult(text) {
  if (Buffer.byteLength(text, 'utf8') <= RESULT_MAX_BYTES) return text;
  const buf = Buffer.from(text, 'utf8');
  return joinCut(buf, buf, buf.length);
}

export function createCapSink() {
  const head = [];
  const tail = [];
  let headBytes = 0;
  let tailBytes = 0;
  let total = 0;
  return {
    push(chunk) {
      total += chunk.length;
      let rest = chunk;
      if (headBytes < RESULT_MAX_BYTES) {
        const take = Math.min(RESULT_MAX_BYTES - headBytes, rest.length);
        head.push(rest.subarray(0, take));
        headBytes += take;
        rest = rest.subarray(take);
      }
      if (rest.length === 0) return;
      tail.push(rest);
      tailBytes += rest.length;
      while (tailBytes - tail[0].length >= RESULT_MAX_BYTES) tailBytes -= tail.shift().length;
    },
    text() {
      const headBuf = Buffer.concat(head);
      const tailBuf = Buffer.concat(tail);
      if (headBytes + tailBytes === total) return capResult(Buffer.concat([headBuf, tailBuf]).toString('utf8'));
      return joinCut(headBuf, tailBuf, total);
    },
  };
}
