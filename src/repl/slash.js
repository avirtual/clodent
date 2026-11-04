import { formatTotal } from '../cost/format.js';
import { isTyped } from './editor.js';

const NAME = /^\/[a-z]+$/;

export const HELP = Object.freeze([
  '/help           list these commands',
  '/cost           print the session cost so far',
  '/model [<id>]   print the model, or use <id> for the next requests',
  '/clear          start a new session with an empty history',
  '/compact        not available yet',
  '/quit, /exit    exit clay',
]);

export function parseCommand(submission) {
  if (!isTyped(submission) || submission.text.includes('\n')) return null;
  const [first, ...rest] = submission.text.trim().split(/\s+/);
  if (!NAME.test(first)) return null;
  return { name: first.slice(1), args: rest };
}

const COMMANDS = {
  help(ctx) {
    for (const line of HELP) ctx.print(line);
  },
  cost(ctx) {
    ctx.print(formatTotal(ctx.ledger.session()));
  },
  model(ctx, args) {
    if (args.length > 1) {
      ctx.print('clay: /model takes one model id');
      return;
    }
    if (args.length === 1) {
      try {
        ctx.setModel(args[0]);
      } catch (err) {
        ctx.print(`clay: ${err?.message ?? err}`);
      }
    }
    ctx.print(`clay: model ${ctx.model()}`);
  },
  clear(ctx) {
    return ctx.clear();
  },
  compact(ctx) {
    ctx.print('clay: /compact is not available yet');
  },
  quit: () => 'exit',
  exit: () => 'exit',
};

export async function runCommand({ name, args }, ctx) {
  const handler = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
  if (!handler) {
    ctx.print(`clay: unknown command /${name} (try /help)`);
    return undefined;
  }
  return handler(ctx, args);
}
