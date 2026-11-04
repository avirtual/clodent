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

export function compactPrompt(instructions) {
  return instructions ? `${COMPACT_PROMPT}\n\nAdditional instructions: ${instructions}` : COMPACT_PROMPT;
}

export function compactMessages(history, instructions) {
  const messages = structuredClone(history);
  appendMessage(messages, 'user', [{ type: 'text', text: compactPrompt(instructions) }]);
  return messages;
}

export function summaryOf(message) {
  return (message.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function summaryMessage(summary) {
  return { role: 'user', content: [{ type: 'text', text: `${SUMMARY_PREFIX}${summary}` }] };
}

export function compactTokens(usage = {}) {
  const preTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return { preTokens, postTokens: usage.output_tokens ?? 0 };
}
