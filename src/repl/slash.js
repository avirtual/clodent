import { NOTHING_TO_COMPACT } from '../agent/compact.js';
import { formatTotal } from '../cost/format.js';
import { isTyped } from './editor.js';

const NAME = /^\/[a-z]+$/;

export const HELP = Object.freeze([
  '/help              list these commands',
  '/cost              print the session cost so far',
  '/model [<id>]      print the model, or use <id> for the next requests',
  '/clear             start a new session with an empty history',
  '/compact [<text>]  summarise the conversation into one message; <text> steers the summary',
  '/quit, /exit       exit clodent',
]);

export function parseCommand(submission) {
  if (!isTyped(submission) || submission.text.includes('\n')) return null;
  const text = submission.text.trim();
  const [first, ...rest] = text.split(/\s+/);
  if (!NAME.test(first)) return null;
  return { name: first.slice(1), args: rest, argText: text.slice(first.length).trim() };
}

const COMMANDS = {
  async compact(ctx, _args, argText) {
    const result = await ctx.compact(argText);
    if (result.ok) return;
    ctx.print(result.reason === NOTHING_TO_COMPACT ? `clodent: ${NOTHING_TO_COMPACT}` : `clodent: compact failed: ${result.reason}`);
  },
  clear(ctx) {
    return ctx.clear();
  },
  cost(ctx) {
    ctx.print(formatTotal(ctx.ledger.session()));
  },
  model(ctx, args) {
    if (args.length > 1) {
      ctx.print('clodent: /model takes one model id');
      return;
    }
    if (args.length === 1) {
      try {
        ctx.setModel(args[0]);
      } catch (err) {
        ctx.print(`clodent: ${err?.message ?? err}`);
      }
    }
    ctx.print(`clodent: model ${ctx.model()}`);
  },
  help(ctx) {
    for (const line of HELP) ctx.print(line);
  },
  quit: () => 'exit',
  exit: () => 'exit',
};

export const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));

export async function runCommand({ name, args, argText }, ctx) {
  const handler = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
  if (!handler) {
    ctx.print(`clodent: unknown command /${name} (try /help)`);
    return 'unknown';
  }
  return handler(ctx, args, argText);
}
