import { join } from 'node:path';
import { parseRule, RuleError } from './rules.js';

export function splitRuleList(text) {
  const entries = [];
  let current = '';
  let depth = 0;
  for (const c of text) {
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    if (depth <= 0 && (c === ',' || /\s/.test(c))) {
      if (current !== '') entries.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current !== '') entries.push(current);
  return entries;
}

export function flagRules(values, { cwd, home }) {
  const where = { file: join(cwd, 'argv'), cwd, home };
  const rules = [];
  for (const entry of values.flatMap(splitRuleList)) {
    let rule;
    try {
      rule = parseRule(entry, where);
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      throw new RuleError(`${JSON.stringify(entry)}: ${err.message}`);
    }
    if (rule) rules.push(rule);
  }
  return rules;
}
