import { homedir as osHomedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export const CLAY_TOOLS = Object.freeze(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']);
const CLAY_TOOL_SET = new Set(CLAY_TOOLS);

const PATH_RULES = {
  Read: { tools: ['Read', 'Edit', 'Grep', 'Glob'], bash: 'read' },
  Edit: { tools: ['Edit', 'Write'], bash: 'edit' },
  Write: { tools: ['Write'], bash: 'edit' },
  Grep: { tools: ['Grep'], bash: null },
  Glob: { tools: ['Glob'], bash: null },
};

const RUN = `[^\\s'"]*`;
const MENTION_END = '(?=$|[\\s\'"`;|&<>)/])';

export class RuleError extends Error {}

export function ruleHome(env, homedir = osHomedir) {
  return env?.HOME || homedir();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitRule(text) {
  let depth = 0;
  let open = -1;
  let close = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') {
      if (open === -1) open = i;
      depth += 1;
    } else if (text[i] === ')') {
      depth -= 1;
      if (depth < 0) throw new RuleError('unbalanced parenthesis');
      if (depth === 0 && close === -1) close = i;
    }
  }
  if (depth !== 0) throw new RuleError('unbalanced parenthesis');
  if (open === -1) return { name: text, specifier: null };
  if (close !== text.length - 1) throw new RuleError('text after the closing parenthesis');
  return { name: text.slice(0, open), specifier: text.slice(open + 1, close) };
}

function segmentSource(segment, star) {
  return segment.split(/\*+/).map(escapeRegExp).join(star);
}

function segmentsOf(path) {
  const segments = path.split('/').filter((segment) => segment !== '');
  while (segments.at(-1) === '**') segments.pop();
  return segments;
}

function pathSource(segments, star, any) {
  return segments.map((segment) => (segment === '**' ? `(?:/${any})?` : `/${segmentSource(segment, star)}`)).join('');
}

export function pathRegExp(pattern) {
  return new RegExp(`^${pathSource(segmentsOf(pattern), '[^/]*', '[\\s\\S]*')}(?:/[\\s\\S]*)?$`);
}

export function mentionRegExp(pattern, home) {
  const segments = segmentsOf(pattern);
  const homeSegments = home ? segmentsOf(resolve(home)) : [];
  const underHome =
    homeSegments.length > 0 &&
    homeSegments.length <= segments.length &&
    homeSegments.every((segment, i) => segment === segments[i]);
  if (!underHome) return new RegExp(`${pathSource(segments, RUN, RUN) || '/'}${MENTION_END}`);
  const rest = pathSource(segments.slice(homeSegments.length), RUN, RUN);
  const prefixes = [pathSource(homeSegments, RUN, RUN), '~', '\\$HOME', '\\$\\{HOME\\}'];
  return new RegExp(`(?:${prefixes.join('|')})${rest}${MENTION_END}`);
}

function expandPath(specifier, { file, cwd, home }) {
  if (specifier.startsWith('//')) return resolve(specifier.slice(1));
  if (specifier === '~' || specifier.startsWith('~/')) return home ? resolve(home, specifier.slice(2)) : '';
  if (specifier.startsWith('/')) return resolve(dirname(file), specifier.slice(1));
  return resolve(cwd, specifier);
}

function bashTest(specifier) {
  const spec = specifier.trim();
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2).trimEnd();
    return (command) => prefix === '' || command === prefix || (command.startsWith(prefix) && /\s/.test(command[prefix.length]));
  }
  if (spec.includes('*')) {
    const regex = new RegExp(`^${segmentSource(spec, '[\\s\\S]*')}$`);
    return (command) => regex.test(command);
  }
  return (command) => command === spec;
}

export function parseRule(text, where) {
  const trimmed = text.trim();
  const { name, specifier } = splitRule(trimmed);
  if (name.trim() === '') throw new RuleError('no tool name');
  if (!CLAY_TOOL_SET.has(name)) return null;
  if (specifier === null) return { text, kind: 'tool', tool: name };
  if (specifier.trim() === '') throw new RuleError(`empty () on ${name}`);
  if (name === 'Bash') return { text, kind: 'bash', test: bashTest(specifier) };
  const pattern = expandPath(specifier, where);
  if (pattern === '') throw new RuleError('the path expands to nothing (HOME is not set)');
  const { tools, bash } = PATH_RULES[name];
  return { text, kind: 'path', tool: name, tools, bash, pattern, regex: pathRegExp(pattern), mention: mentionRegExp(pattern, where.home) };
}

export function parseRules(list, key, where) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new RuleError(`${key} is not an array`);
  const rules = [];
  list.forEach((text, i) => {
    if (typeof text !== 'string') throw new RuleError(`${key}[${i}] is not a string`);
    let rule;
    try {
      rule = parseRule(text, where);
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      throw new RuleError(`${key}[${i}] ${JSON.stringify(text)}: ${err.message}`);
    }
    if (rule) rules.push(rule);
  });
  return rules;
}
