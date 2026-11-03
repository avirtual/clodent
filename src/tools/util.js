import { capResult } from './cap.js';

export function ok(text) {
  return { content: capResult(text), isError: false };
}

export function fail(text) {
  return { content: capResult(text), isError: true };
}

export function oneLine(value, max = 200) {
  const flat = String(value ?? '').replace(/\r\n|\r|\n/g, '⏎');
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

export function checkInput(input, required, optional = []) {
  if (input === null || typeof input !== 'object') return fail('input must be an object');
  for (const name of required) {
    if (typeof input[name] !== 'string') return fail(`${name} must be a string`);
  }
  for (const name of optional) {
    if (input[name] !== undefined && input[name] !== null && typeof input[name] !== 'string') {
      return fail(`${name} must be a string`);
    }
  }
  return null;
}

export function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

export function isBinary(buf) {
  return buf.subarray(0, 8192).includes(0);
}

export function describeFsError(err, path) {
  if (err?.code === 'ENOENT') return `File does not exist: ${path}`;
  return `${path}: ${err?.message ?? err}`;
}
