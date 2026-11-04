import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createAgent } from './agent/loop.js';
import { DEFAULT_MODEL, FLAGS, givenFlags, parseArgs } from './args.js';
import { createLedger } from './cost/ledger.js';
import { createHookFirer } from './hooks/fire.js';
import { createStatusLine } from './hooks/status-line.js';
import { buildSystemPrompt } from './prompt/system.js';
import { createRenderer } from './render/terminal.js';
import { loadSettings } from './settings/load.js';
import { openSession } from './session/open.js';
import { clayHome } from './session/paths.js';
import { createRecorder } from './session/recorder.js';
import { createTools } from './tools/index.js';

export const NOT_YET = new Set([]);
export const SIGNAL_EXIT = Object.freeze({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 });

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

function home(deps) {
  return clayHome(deps.env, deps.homedir ?? homedir());
}

function baseUrlFrom(env) {
  const raw = env.ANTHROPIC_BASE_URL;
  if (raw === undefined || raw === '') return { ok: true, baseUrl: undefined };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false };
  return { ok: true, baseUrl: raw };
}

function extraDirs(opts, settings, cwd) {
  return [...new Set([...opts.addDirs, ...settings.extraDirs].map((dir) => resolve(cwd, dir)))];
}

function statusState(usage = {}, base, ledger) {
  const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return { ...base, usedTokens: input + (usage.output_tokens ?? 0), totalInputTokens: input, totalCostUsd: ledger.session().usd };
}

function systemPrompt(opts, model, addDirs, deps) {
  return buildSystemPrompt(
    {
      cwd: deps.cwd,
      model,
      systemPrompt: opts.systemPrompt,
      systemPromptFile: opts.systemPromptFile,
      addDirs,
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
      home: home(deps),
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
  const { stdout, stderr, cwd } = deps;
  let loaded;
  try {
    loaded = await loadSettings({ clayHome: home(deps), files: opts.settings.map((file) => resolve(cwd, file)) });
  } catch (err) {
    stderr.write(`clay: ${err.message}\n`);
    return 2;
  }
  const { settings } = loaded;
  const env = { ...deps.env, ...settings.env };
  if (opts.print === '') {
    stderr.write('clay: -p needs a non-empty prompt\n');
    return 2;
  }
  if (!env.ANTHROPIC_API_KEY) {
    stderr.write('clay: ANTHROPIC_API_KEY is not set\n');
    return 2;
  }
  const base = baseUrlFrom(env);
  if (!base.ok) {
    stderr.write('clay: invalid ANTHROPIC_BASE_URL\n');
    return 2;
  }
  const model = opts.model ?? settings.model ?? DEFAULT_MODEL;
  let system;
  try {
    system = systemPrompt(opts, model, extraDirs(opts, settings, cwd), deps);
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
  for (const warning of [...loaded.warnings, ...session.warnings]) stderr.write(`clay: ${warning}\n`);
  const render = createRenderer({ out: stdout, err: stderr, mode: 'print' });
  const record = createRecorder(session.transcript, { now: deps.now });
  const procDeps = { spawn: deps.spawn, kill: deps.kill };
  const ledger = createLedger({ budgetUsd: opts.budgetUsd }, {});
  const statusLine = createStatusLine(
    { settings, env, cwd, version: version() },
    { ...procDeps, warn: (message) => render({ type: 'warning', message }) },
  );
  const statusBase = { modelId: model, sessionId: session.sessionId, transcriptPath: session.transcriptPath };
  const hooks = createHookFirer(
    { settings, env, cwd, sessionId: session.sessionId, transcriptPath: session.transcriptPath, permission: opts.permission },
    procDeps,
  );
  const agent = createAgent(
    {
      model,
      effort: opts.effort ?? settings.effortLevel,
      system,
      baseUrl: base.baseUrl,
      tools: createTools(procDeps),
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
      ledger,
      hooks,
      emit: (event) => {
        record(event);
        render(event);
        if (event.type === 'assistant_message') statusLine.update(statusState(event.message.usage, statusBase, ledger));
      },
    },
  );
  const controller = new AbortController();
  let caught = null;
  const offs = Object.keys(SIGNAL_EXIT).map((name) =>
    deps.onSignal(name, () => {
      caught ??= name;
      controller.abort();
    }),
  );
  let result;
  try {
    await agent.fireSessionStart(opts.resume === undefined ? 'startup' : 'resume', { signal: controller.signal });
    result = await agent.runTurn(opts.print, { signal: controller.signal });
  } finally {
    for (const off of offs) off();
  }
  agent.endSession();
  await statusLine.flush();
  if (controller.signal.aborted) return SIGNAL_EXIT[caught];
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
