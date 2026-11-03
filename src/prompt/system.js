import { resolve } from 'node:path';
import { discoverAgentsMd } from './agents-md.js';
import { CLAY_BASE_PROMPT } from './base.js';

function readPromptFile(flag, file, cwd, deps) {
  const path = resolve(cwd, file);
  try {
    return deps.readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${flag} ${path}: ${err.code ?? err.message}`);
  }
}

function isoDate(date) {
  const yyyy = String(date.getFullYear()).padStart(4, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function environment({ cwd, model, addDirs }, gitRoot, deps) {
  const lines = [
    '# Environment',
    `Working directory: ${cwd}`,
    gitRoot === null ? 'Git repository: no' : `Git repository: yes, root ${gitRoot}`,
    `Platform: ${deps.platform}`,
    `Date: ${isoDate(deps.now())}`,
    `Model: ${model}`,
  ];
  if (addDirs.length > 0) {
    lines.push('Additional directories:', ...addDirs.map((dir) => resolve(cwd, dir)));
  }
  return lines.join('\n');
}

function instructions(files) {
  if (files.length === 0) return '';
  const sections = files.map(({ path, text }) => `## ${path}\n\n${text.trimEnd()}`);
  return ['# Instructions (AGENTS.md)', ...sections].join('\n\n');
}

export function buildSystemPrompt(input, deps) {
  const { cwd, systemPrompt, systemPromptFile } = input;
  const addDirs = input.addDirs ?? [];
  let base = CLAY_BASE_PROMPT;
  if (systemPrompt !== undefined) base = systemPrompt;
  else if (systemPromptFile !== undefined) base = readPromptFile('--system-prompt-file', systemPromptFile, cwd, deps);
  const appendFiles = (input.appendSystemPromptFile ?? []).map((file) =>
    readPromptFile('--append-system-prompt-file', file, cwd, deps),
  );
  const { gitRoot, files } = discoverAgentsMd(cwd, deps);
  const parts = [
    base,
    environment({ cwd, model: input.model, addDirs }, gitRoot, deps),
    instructions(files),
    ...(input.appendSystemPrompt ?? []),
    ...appendFiles,
  ];
  return parts
    .map((part) => part.trimEnd())
    .filter((part) => part !== '')
    .join('\n\n');
}
