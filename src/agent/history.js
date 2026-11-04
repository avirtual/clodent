export function appendMessage(history, role, blocks) {
  if (blocks.length === 0) return;
  const last = history.at(-1);
  if (last?.role === role) last.content.push(...blocks);
  else history.push({ role, content: [...blocks] });
}
