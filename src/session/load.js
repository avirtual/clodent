import { basename } from 'node:path';
import { appendMessage } from '../agent/history.js';
import { INTERRUPT_TEXT } from './transcript.js';

function isInterrupt(record) {
  const content = record.message?.content;
  return record.isMeta === true && content?.length === 1 && content[0].type === 'text' && content[0].text === INTERRUPT_TEXT;
}

function parseLine(line, number, path) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    throw new Error(`${path}: line ${number} is not valid JSON`);
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new Error(`${path}: line ${number} is not a record`);
  }
  return record;
}

export function loadTranscript(path, { readFileSync }) {
  const text = readFileSync(path, 'utf8');
  const end = text.lastIndexOf('\n') + 1;
  const warnings = end < text.length ? [`${path}: ignoring a truncated last line`] : [];
  const lines = text.slice(0, end).split('\n').slice(0, -1);
  const records = [];
  const history = [];
  let lastUuid = null;
  let interruptedLast = false;
  lines.forEach((line, i) => {
    const record = parseLine(line, i + 1, path);
    records.push(record);
    lastUuid = record.uuid ?? lastUuid;
    if (record.type !== 'user' && record.type !== 'assistant') return;
    if (record.type === 'user') interruptedLast = isInterrupt(record);
    if (record.isMeta === true) return;
    if (!Array.isArray(record.message?.content)) throw new Error(`${path}: line ${i + 1} has no message content`);
    appendMessage(history, record.type, record.message.content);
  });
  return {
    history,
    records,
    lastUuid,
    interruptedLast,
    warnings,
    validBytes: Buffer.byteLength(text.slice(0, end)),
    sessionId: basename(path, '.jsonl'),
  };
}
