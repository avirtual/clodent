import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildRequest } from '../src/api/request.js';
import { streamMessage } from '../src/api/stream.js';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
const SYSTEM = 'You are the clay live smoke check. Follow the user instruction exactly and do not call tools.';
const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the given text back.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];
const PROMPT = 'Reply with exactly: pong';
const FILLER = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

function parseArgs(argv) {
  const args = { model: DEFAULT_MODEL, pad: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model' && argv[i + 1]) args.model = argv[++i];
    else if (argv[i] === '--pad' && /^\d+$/.test(argv[i + 1] ?? '')) args.pad = Number(argv[++i]);
    else return { error: `unknown argument ${argv[i]}` };
  }
  return args;
}

export function padSystem(system, words) {
  if (words === 0) return system;
  return `${system}\n\n${Array.from({ length: words }, (_, i) => FILLER[i % FILLER.length]).join(' ')}`;
}

export async function liveSmoke(argv, deps) {
  const { stdout, stderr, env } = deps;
  const args = parseArgs(argv);
  if (args.error) {
    stderr.write(`live-smoke: ${args.error}\nusage: node scripts/live-smoke.js [--model <id>] [--pad <n>]\n`);
    return 2;
  }
  if (!env.ANTHROPIC_API_KEY) {
    stderr.write('live-smoke: ANTHROPIC_API_KEY not set\n');
    return 2;
  }
  const request = buildRequest(
    { model: args.model, system: padSystem(SYSTEM, args.pad), tools: TOOLS, messages: [{ role: 'user', content: PROMPT }] },
    { env },
  );
  let ok = true;
  let usage;
  for (const round of [1, 2]) {
    let text = '';
    try {
      const { message } = await streamMessage(request, deps, {
        onText: (chunk) => {
          text += chunk;
          stdout.write(chunk);
        },
      });
      stdout.write(`\n[${round}] stop_reason: ${message.stop_reason}\n`);
      stdout.write(`[${round}] usage: ${JSON.stringify(message.usage)}\n`);
      usage = message.usage;
    } catch (err) {
      stderr.write(`live-smoke: request ${round} failed: ${err.status ?? '-'} ${err.type ?? err.name}: ${err.message}\n`);
      return 1;
    }
    if (text === '') ok = false;
  }
  if (args.pad > 0 && !(usage?.cache_read_input_tokens > 0)) {
    stderr.write('live-smoke: no cache read on request 2\n');
    return 1;
  }
  return ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await liveSmoke(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    fetch: globalThis.fetch,
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
    random: Math.random,
    now: () => performance.now(),
  });
}
