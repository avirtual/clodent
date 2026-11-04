import { resolve } from 'node:path';
import { appendMessage } from './history.js';

export const COMPACT_PROMPT = [
  'Summarise this conversation so that a fresh context can continue the work from your summary alone. Cover:',
  "- the user's goals and every explicit instruction they gave;",
  '- the decisions made, and why;',
  '- the files and paths read, created or changed;',
  '- the current state of the work;',
  '- the errors met and how they were fixed;',
  '- the next step.',
  'Reply with the summary text only. Do not call any tools.',
].join('\n');
export const SUMMARY_PREFIX = 'This session continues an earlier conversation that was compacted. Summary of it:\n\n';
export const NOTHING_TO_COMPACT = 'nothing to compact';
export const COMPACT_TOOL_CHOICE = Object.freeze({ type: 'none' });
export const DEFAULT_RELOAD_FILES = 5;
export const MAX_RELOAD_FILES = 20;
export const RELOAD_BUDGET_BYTES = 65536;
const RELOAD_HEADING = 'Files to reload:';
const TOUCHING_TOOLS = new Set(['Read', 'Edit', 'Write']);

export function reloadRequest(count) {
  return `End the summary with a line \`${RELOAD_HEADING}\` followed by up to ${count} file paths, one per line, most important first: the files the next context needs in full to continue. Write \`${RELOAD_HEADING} none\` if there are none.`;
}

export function compactPrompt(instructions, reloadFiles = 0) {
  const prompt = reloadFiles > 0 ? `${COMPACT_PROMPT}\n${reloadRequest(reloadFiles)}` : COMPACT_PROMPT;
  return instructions ? `${prompt}\n\nAdditional instructions: ${instructions}` : prompt;
}

export function compactMessages(history, instructions, reloadFiles = 0) {
  const messages = structuredClone(history);
  appendMessage(messages, 'user', [{ type: 'text', text: compactPrompt(instructions, reloadFiles) }]);
  return messages;
}

export function summaryOf(message) {
  return (message.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function summaryMessage(summary, fileBlocks = []) {
  return { role: 'user', content: [{ type: 'text', text: `${SUMMARY_PREFIX}${summary}` }, ...fileBlocks] };
}

export function reloadBlock(path, output) {
  return { type: 'text', text: `Contents of ${path} at compact time (Read tool output):\n\n${output}` };
}

function listedPath(line) {
  let path = line.trim();
  if (path.startsWith('- ') || path.startsWith('* ')) path = path.slice(2).trim();
  return path.replace(/^`+([^`]*)`+$/, '$1').trim();
}

function headingRest(line) {
  const text = line.trim();
  const open = text.match(/^[`*#\s]*/)[0];
  if (!text.startsWith(RELOAD_HEADING, open.length)) return null;
  let rest = text.slice(open.length + RELOAD_HEADING.length).trim();
  if (open.includes('`')) rest = rest.replace(/^`+|`+$/g, '').trim();
  if (open.includes('*')) rest = rest.replace(/^\*+|\*+$/g, '').trim();
  return rest;
}

function listedFiles(summary) {
  const lines = summary.split('\n');
  const at = lines.findLastIndex((line) => headingRest(line) !== null);
  if (at === -1) return null;
  const first = listedPath(headingRest(lines[at]));
  if (first.toLowerCase() === 'none') return [];
  const paths = first === '' ? [] : [first];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') break;
    const path = listedPath(line);
    if (path !== '') paths.push(path);
  }
  return paths;
}

function touchedFiles(history) {
  const paths = [];
  for (const message of history.toReversed()) {
    if (message.role !== 'assistant') continue;
    for (const block of (message.content ?? []).toReversed()) {
      if (block.type === 'tool_use' && TOUCHING_TOOLS.has(block.name) && typeof block.input?.file_path === 'string') paths.push(block.input.file_path);
    }
  }
  return paths;
}

export function reloadPaths(summary, history, { cwd, count }) {
  if (!(count > 0)) return [];
  const named = listedFiles(summary) ?? touchedFiles(history);
  return [...new Set(named.map((path) => resolve(cwd, path)))].slice(0, count);
}

export function compactTokens(usage = {}) {
  const preTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return { preTokens, postTokens: usage.output_tokens ?? 0 };
}
