import { RESULT_MAX_BYTES } from './cap.js';

export const CONTEXT_LINES = 3;
export const MAX_EDIT_DISTANCE = 1000;

function linesOf(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function backtrack(trace, a, b, offset) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? k + 1 : k - 1;
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('=');
      x -= 1;
      y -= 1;
    }
    if (d > 0) ops.push(x === prevX ? '+' : '-');
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

function editScript(a, b) {
  const limit = Math.min(a.length + b.length, MAX_EDIT_DISTANCE);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace = [];
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? v[k + 1 + offset] : v[k - 1 + offset] + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= a.length && y >= b.length) return backtrack(trace, a, b, offset);
    }
  }
  return null;
}

function deletionsFirst(ops) {
  const out = [];
  for (let k = 0; k < ops.length; ) {
    if (ops[k] === '=') {
      out.push('=');
      k += 1;
      continue;
    }
    let end = k;
    while (end < ops.length && ops[end] !== '=') end += 1;
    const run = ops.slice(k, end);
    out.push(...run.filter((op) => op === '-'), ...run.filter((op) => op === '+'));
    k = end;
  }
  return out;
}

function hunksOf(ops, a, b, base) {
  const oldAt = [];
  const newAt = [];
  let i = base;
  let j = base;
  for (const op of ops) {
    oldAt.push(i);
    newAt.push(j);
    if (op !== '+') i += 1;
    if (op !== '-') j += 1;
  }
  oldAt.push(i);
  newAt.push(j);
  const groups = [];
  for (let k = 0; k < ops.length; ) {
    if (ops[k] === '=') {
      k += 1;
      continue;
    }
    let end = k;
    while (end < ops.length && ops[end] !== '=') end += 1;
    const last = groups.at(-1);
    if (last && k - last.end <= 2 * CONTEXT_LINES) last.end = end;
    else groups.push({ start: k, end });
    k = end;
  }
  return groups.map(({ start, end }) => {
    const from = Math.max(0, start - CONTEXT_LINES);
    const to = Math.min(ops.length, end + CONTEXT_LINES);
    const lines = [];
    for (let k = from; k < to; k += 1) {
      if (ops[k] === '+') lines.push(`+${b[newAt[k]]}`);
      else if (ops[k] === '-') lines.push(`-${a[oldAt[k]]}`);
      else lines.push(` ${a[oldAt[k]]}`);
    }
    const oldLines = oldAt[to] - oldAt[from];
    const newLines = newAt[to] - newAt[from];
    return {
      oldStart: oldLines === 0 ? oldAt[from] : oldAt[from] + 1,
      oldLines,
      newStart: newLines === 0 ? newAt[from] : newAt[from] + 1,
      newLines,
      lines,
    };
  });
}

export function structuredPatch(oldText, newText) {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  if (start === endA && start === endB) return [];
  const removed = endA - start;
  const added = endB - start;
  const middle = editScript(a.slice(start, endA), b.slice(start, endB)) ?? [...Array(removed).fill('-'), ...Array(added).fill('+')];
  const from = Math.max(0, start - CONTEXT_LINES);
  const ops = deletionsFirst([...Array(start - from).fill('='), ...middle, ...Array(Math.min(CONTEXT_LINES, a.length - endA)).fill('=')]);
  const hunks = hunksOf(ops, a, b, from);
  const bytes = hunks.reduce((sum, hunk) => sum + hunk.lines.reduce((n, line) => n + Buffer.byteLength(line, 'utf8') + 1, 0), 0);
  return bytes > RESULT_MAX_BYTES ? [] : hunks;
}
