import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { createAgent } from './agent/loop.js';
import { DEFAULT_MODEL, FLAGS, givenFlags, parseArgs } from './args.js';
import { createLedger } from './cost/ledger.js';
import { buildSystemPrompt } from './prompt/system.js';
import { createRenderer } from './render/terminal.js';
import { openSession } from './session/open.js';
import { clayHome } from './session/paths.js';
import { createRecorder } from './session/recorder.js';
import { createTools } from './tools/index.js';

export const NOT_YET = new Set(['settings']);

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

function systemPrompt(opts, model, deps) {
  return buildSystemPrompt(
    {
      cwd: deps.cwd,
      model,
      systemPrompt: opts.systemPrompt,
      systemPromptFile: opts.systemPromptFile,
      addDirs: opts.addDirs,
      appendSystemPrompt: opts.appendSystemPrompt,
      appendSystemPromptFile: opts.appendSystemPromptFile,
    },
    { readFile: readFileSync, stat: statSync, platform: deps.platform, clock: deps.clock },
  );
}

function startSession(opts, deps) {
  return openSession(
    {
      sessionId: opts.sessionId,
      resume: opts.resume,
      forkSession: opts.forkSession === true,
      home: clayHome(deps.env, deps.homedir ?? homedir()),
      cwd: deps.cwd,
      version: version(),
    },
    {
      existsSync,
      readdirSync,
      readFileSync,
      truncateSync,
      appendFileSync,
      mkdirSync,
      clock: deps.clock,
      uuid: deps.uuid ?? randomUUID,
    },
  );
}

async function runPrint(opts, deps) {
  const { stdout, stderr, env, cwd } = deps;
  if (opts.print === '') {
    stderr.write('clay: -p needs a non-empty prompt\n');
    return 2;
  }
  if (!env.ANTHROPIC_API_KEY) {
    stderr.write('clay: ANTHROPIC_API_KEY is not set\n');
    return 2;
  }
  const model = opts.model ?? DEFAULT_MODEL;
  let system;
  try {
    system = systemPrompt(opts, model, deps);
  } catch (err) {
    stderr.write(`clay: ${err.message}\n`);
    return 2;
  }
  let session;
  try {
    session = startSession(opts, deps);
  } catch (err) {
    session = { ok: false, error: err.message };
  }
  if (!session.ok) {
    stderr.write(`clay: ${session.error}\n`);
    return 2;
  }
  stderr.write(`[clay:session] ${session.sessionId}\n`);
  for (const warning of session.warnings) stderr.write(`clay: ${warning}\n`);
  const render = createRenderer({ out: stdout, err: stderr, mode: 'print' });
  const record = createRecorder(session.transcript, { now: deps.now });
  const agent = createAgent(
    {
      model,
      effort: opts.effort,
      system,
      tools: createTools({ spawn: deps.spawn, kill: deps.kill }),
      permission: opts.permission,
      history: session.history,
      interrupted: session.interrupted,
    },
    {
      fetch: deps.fetch,
      env,
      cwd,
      sleep: deps.sleep,
      random: deps.random,
      now: deps.now,
      ledger: createLedger({ budgetUsd: opts.budgetUsd }, {}),
      emit: (event) => {
        record(event);
        render(event);
      },
    },
  );
  const controller = new AbortController();
  const off = deps.onSignal('SIGINT', () => controller.abort());
  let result;
  try {
    result = await agent.runTurn(opts.print, { signal: controller.signal });
  } finally {
    off();
  }
  agent.endSession();
  if (controller.signal.aborted) return 130;
  return result.ok ? 0 : 1;
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
  if (opts.print !== undefined) return runPrint(opts, deps);
  deps.stderr.write('clay: not implemented yet\n');
  return 1;
}
