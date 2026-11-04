import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createAgent } from './agent/loop.js';
import { DEFAULT_MODEL, FLAGS, givenFlags, parseArgs } from './args.js';
import { createLedger } from './cost/ledger.js';
import { createHookFirer } from './hooks/fire.js';
import { createStatusLine } from './hooks/status-line.js';
import { flagRules } from './permissions/flag-rules.js';
import { createGuard, sentTools } from './permissions/guard.js';
import { RuleError, ruleHome } from './permissions/rules.js';
import { killPendingGroups } from './proc/run.js';
import { buildSystemPrompt } from './prompt/system.js';
import { createRenderer } from './render/terminal.js';
import { runRepl } from './repl/repl.js';
import { createStreamOutput } from './stream/output.js';
import { runStream } from './stream/run.js';
import { loadSettings } from './settings/load.js';
import { openSession } from './session/open.js';
import { clodentHome } from './session/paths.js';
import { gitBranch } from './session/git-branch.js';
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
    const names = [flag.short && `-${flag.short}`, `--${flag.long}`, flag.alias && `--${flag.alias}`].filter(Boolean).join(', ');
    const label = flag.arg ? `${names} <${flag.arg}>` : names;
    const status = NOT_YET.has(flag.long) ? ' (not implemented yet)' : '';
    return [label, `${flag.help}${status}`];
  });
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(([label, text]) => `  ${label.padEnd(width)}  ${text}`);
  return `usage: clodent [options]\n\noptions:\n${lines.join('\n')}\n`;
}

function home(deps) {
  return clodentHome(deps.env, deps.homedir ?? homedir());
}

function ignoredFlags(opts) {
  return FLAGS.filter((flag) => flag.ignored && opts[flag.key] === true).map((flag) => `clodent: ignoring --${flag.long}: not supported\n`);
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

function systemPrompt(opts, model, addDirs, deps, permissions) {
  return buildSystemPrompt(
    {
      cwd: deps.cwd,
      model,
      tools: sentTools(permissions),
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
      gitBranch: () => gitBranch(deps.cwd, { readFileSync, statSync }),
    },
  );
}

async function prepare(opts, deps) {
  const { stderr, cwd } = deps;
  const rulesHome = ruleHome(deps.env, () => deps.homedir ?? homedir());
  let loaded;
  try {
    loaded = await loadSettings({
      clodentHome: home(deps),
      files: opts.settings.map((file) => resolve(cwd, file)),
      cwd,
      home: rulesHome,
    });
  } catch (err) {
    stderr.write(`clodent: ${err.message}\n`);
    return { code: 2 };
  }
  const fail = (message) => {
    for (const warning of loaded.warnings) stderr.write(`clodent: ${warning}\n`);
    stderr.write(`clodent: ${message}\n`);
    return { code: 2 };
  };
  const { settings } = loaded;
  let disallowed;
  try {
    disallowed = flagRules(opts.disallowedTools, { cwd, home: rulesHome });
  } catch (err) {
    if (!(err instanceof RuleError)) throw err;
    return fail(`--disallowedTools: ${err.message}`);
  }
  const permissions = { deny: [...(settings.permissions?.deny ?? []), ...disallowed], ask: settings.permissions?.ask ?? [] };
  const env = { ...deps.env, ...settings.env };
  if (opts.print === '' && opts.inputFormat !== 'stream-json') return fail('-p needs a non-empty prompt');
  if (!env.ANTHROPIC_API_KEY) return fail('ANTHROPIC_API_KEY is not set');
  const base = baseUrlFrom(env);
  if (!base.ok) return fail('invalid ANTHROPIC_BASE_URL');
  const model = opts.model ?? settings.model ?? DEFAULT_MODEL;
  const addDirs = extraDirs(opts, settings, cwd);
  let system;
  try {
    system = systemPrompt(opts, model, addDirs, deps, permissions);
  } catch (err) {
    return fail(err.message);
  }
  let session;
  try {
    session = startSession(opts, deps);
  } catch (err) {
    session = { ok: false, error: err.message };
  }
  if (!session.ok) return fail(session.error);
  const warnings = [...loaded.warnings, ...session.warnings];
  return { settings, permissions, env, baseUrl: base.baseUrl, model, addDirs, system, session, warnings };
}

function createRuntime(prep, opts, deps, render) {
  const { settings, permissions, env, baseUrl, addDirs } = prep;
  const { cwd } = deps;
  const procDeps = { spawn: deps.spawn, kill: deps.kill };
  const ledger = createLedger({ budgetUsd: opts.budgetUsd }, {});
  const statusLine = createStatusLine(
    { settings, env, cwd, version: version() },
    { ...procDeps, warn: (message) => render({ type: 'warning', message }) },
  );
  const guard = createGuard(permissions);
  const tools = createTools({ ...procDeps, envDeny: settings.envDeny ?? [] }).filter((tool) => !guard.removes(tool.name));
  const current = { model: prep.model, system: prep.system };
  const statusOf = (session, usage) =>
    statusState(usage, { modelId: current.model, sessionId: session.sessionId, transcriptPath: session.transcriptPath }, ledger);

  function open(session, { ask, drain } = {}) {
    const record = createRecorder(session.transcript, { now: deps.now });
    const hooks = createHookFirer(
      { settings, env, cwd, sessionId: session.sessionId, transcriptPath: session.transcriptPath, permission: opts.permission },
      procDeps,
    );
    return createAgent(
      {
        model: current.model,
        effort: opts.effort ?? settings.effortLevel,
        cacheTtl: opts.cacheTtl ?? settings.cacheTtl,
        system: current.system,
        baseUrl,
        sessionId: session.sessionId,
        tools,
        permission: opts.permission,
        history: session.history,
        interrupted: session.interrupted,
        ask,
        drain,
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
        guard,
        emit: (event) => {
          record(event);
          render(event);
          if (event.type === 'assistant_message') statusLine.update(statusOf(session, event.message.usage));
          if (event.type === 'compacted') statusLine.update({ ...statusOf(session, {}), usedTokens: event.postTokens });
        },
      },
    );
  }

  return {
    ledger,
    statusLine,
    open,
    model: () => current.model,
    setModel(model) {
      const system = systemPrompt(opts, model, addDirs, deps, permissions);
      Object.assign(current, { model, system });
      return system;
    },
    freshSession() {
      try {
        return startSession({ ...opts, sessionId: undefined, resume: undefined, forkSession: false }, deps);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    resetStatus(session) {
      statusLine.update(statusOf(session, {}));
    },
  };
}

export function ignoreBrokenPipes(stream) {
  stream.on('error', (err) => {
    if (err?.code === 'EIO' || err?.code === 'EPIPE') return;
    throw err;
  });
  return stream;
}

function headLines(opts, prep, stderr) {
  stderr.write(`[clodent:session] ${prep.session.sessionId}\n`);
  for (const line of ignoredFlags(opts)) stderr.write(line);
  for (const warning of prep.warnings) stderr.write(`clodent: ${warning}\n`);
}

function streamRuntime(prep, opts, deps) {
  const plain = { write: (text) => deps.stderr.write(text) };
  const toStderr = createRenderer({ out: { write() {} }, err: plain, mode: 'print' });
  const output = createStreamOutput(
    { version: version(), sessionId: () => prep.session.sessionId },
    { out: deps.stdout, now: deps.now, uuid: deps.uuid, totalUsd: () => runtime.ledger.session().usd },
  );
  const runtime = createRuntime(prep, opts, deps, (event) => {
    toStderr(event);
    output.event(event);
  });
  return { runtime, output };
}

async function runStreamInput(opts, deps) {
  const prep = await prepare(opts, deps);
  if (prep.code !== undefined) return prep.code;
  headLines(opts, prep, deps.stderr);
  const { runtime, output } = streamRuntime(prep, opts, deps);
  return runStream(
    { runtime, output, session: prep.session, resume: opts.resume !== undefined, stdioAsk: opts.permissionPromptTool === 'stdio', signalExit: SIGNAL_EXIT },
    { stdin: deps.stdin, onSignal: deps.onSignal, uuid: deps.uuid, warn: (message) => deps.stderr.write(`clodent: ${message}\n`) },
  );
}

async function runPrint(opts, deps) {
  const prep = await prepare(opts, deps);
  if (prep.code !== undefined) return prep.code;
  headLines(opts, prep, deps.stderr);
  const stream = opts.outputFormat === 'stream-json' ? streamRuntime(prep, opts, deps) : null;
  const runtime = stream?.runtime ?? createRuntime(prep, opts, deps, createRenderer({ out: deps.stdout, err: deps.stderr, mode: 'print' }));
  const agent = runtime.open(prep.session);
  const controller = new AbortController();
  const stopHooks = new AbortController();
  let caught = null;
  const offs = Object.keys(SIGNAL_EXIT).map((name) =>
    deps.onSignal(name, () => {
      if (caught !== null) {
        stopHooks.abort();
        return;
      }
      caught = name;
      controller.abort();
    }),
  );
  let result;
  try {
    await agent.fireSessionStart(opts.resume === undefined ? 'startup' : 'resume', { signal: controller.signal });
    stream?.output.init();
    stream?.output.beginTurn();
    result = await agent.runTurn(opts.print, { signal: controller.signal, stopSignal: stopHooks.signal });
  } finally {
    for (const off of offs) off();
  }
  agent.endSession();
  await runtime.statusLine.flush();
  if (controller.signal.aborted) return SIGNAL_EXIT[caught];
  return result.ok ? 0 : 1;
}

async function runInteractive(opts, deps) {
  const prep = await prepare(opts, deps);
  if (prep.code !== undefined) return prep.code;
  for (const line of ignoredFlags(opts)) deps.stderr.write(line);
  const render = createRenderer({ out: deps.stdout, err: deps.stderr, mode: 'repl' });
  const runtime = createRuntime(prep, opts, deps, render);
  return runRepl(
    { runtime, session: prep.session, warnings: prep.warnings, resume: opts.resume !== undefined, signalExit: SIGNAL_EXIT },
    { stdin: deps.stdin, stdout: deps.stdout, onSignal: deps.onSignal },
  );
}

export async function main(argv, deps) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.stderr.write(`clodent: ${parsed.error}\nclodent: see --help\n`);
    return 2;
  }
  const { opts } = parsed;
  if (opts.help) {
    deps.stdout.write(usage());
    return 0;
  }
  if (opts.version) {
    deps.stdout.write(`clodent ${version()}\n`);
    return 0;
  }
  const pending = givenFlags(opts).filter((name) => NOT_YET.has(name));
  if (pending.length > 0) {
    for (const name of pending) deps.stderr.write(`clodent: --${name} is not implemented yet\n`);
    return 2;
  }
  try {
    if (opts.inputFormat === 'stream-json') return await runStreamInput(opts, deps);
    return await (opts.print !== undefined ? runPrint(opts, deps) : runInteractive(opts, deps));
  } finally {
    killPendingGroups();
  }
}
