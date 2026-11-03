import { readFileSync } from 'node:fs';
import { FLAGS, givenFlags, parseArgs } from './args.js';

export const NOT_YET = new Set([
  'print',
  'model',
  'effort',
  'budget',
  'yolo',
  'read-only',
  'session-id',
  'resume',
  'fork-session',
  'settings',
  'add-dir',
  'system-prompt',
  'system-prompt-file',
  'append-system-prompt',
  'append-system-prompt-file',
]);

function version() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

function usage() {
  const rows = FLAGS.map((flag) => {
    const names = flag.short ? `-${flag.short}, --${flag.long}` : `--${flag.long}`;
    const label = flag.arg ? `${names} <${flag.arg}>` : names;
    const status = NOT_YET.has(flag.long) ? ' (not implemented yet)' : '';
    return [label, `${flag.help}${status}`];
  });
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(([label, text]) => `  ${label.padEnd(width)}  ${text}`);
  return `usage: clay [options]\n\noptions:\n${lines.join('\n')}\n`;
}

export async function main(argv, deps) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.stderr.write(`clay: ${parsed.error}\nclay: see --help\n`);
    return 2;
  }
  const { opts } = parsed;
  if (opts.help) {
    deps.stdout.write(usage());
    return 0;
  }
  if (opts.version) {
    deps.stdout.write(`clay ${version()}\n`);
    return 0;
  }
  const pending = givenFlags(opts).filter((name) => NOT_YET.has(name));
  if (pending.length > 0) {
    for (const name of pending) deps.stderr.write(`clay: --${name} is not implemented yet\n`);
    return 2;
  }
  deps.stderr.write('clay: not implemented yet\n');
  return 1;
}
