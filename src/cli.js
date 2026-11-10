import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_RELOAD_FILES } from './agent/compact.js';
import { createAgent } from './agent/loop.js';
import { hookPaths } from './agent/permission.js';
import { DEFAULT_MODEL, FLAGS, givenFlags, modelChoice, parseArgs } from './args.js';
import { createLedger } from './cost/ledger.js';
import { createHookFirer } from './hooks/fire.js';
import { createStatusLine } from './hooks/status-line.js';
import { flagRules } from './permissions/flag-rules.js';
import { createGuard, sentTools } from './permissions/guard.js';
import { builtinDenies, RuleError, ruleHome } from './permissions/rules.js';
import { killPendingGroups } from './proc/run.js';
import { buildPrompt } from './prompt/system.js';
import { createRenderer } from './render/terminal.js';
import { runRepl } from './repl/repl.js';
import { createStreamOutput } from './stream/output.js';
import { runStream } from './stream/run.js';
import { loadSettings } from './settings/load.js';
import { openSession } from './session/open.js';
import { clodentHome } from './session/paths.js';
import { gitBranch } from './session/git-branch.js';
import { createRecorder } from './session/recorder.js';
import { toolEnv } from './tools/env.js';
import { createClodexToolset } from './tools/clodex.js';
import { createTools } from './tools/index.js';
import { readTokenCap } from './tools/read.js';

export const NOT_YET = new Set([]);
export const SIGNAL_EXIT = Object.freeze({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 });
export const CLAUDE_MD_WARNING = 'CLAUDE.md found but not loaded; clodent reads AGENTS.md (see README System prompt)';

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
  if (url.username !== '' || url.password !== '') return { ok: false, error: 'ANTHROPIC_BASE_URL: credentials in the URL are not supported' };
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
  return buildPrompt(
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
  const files = opts.settings.map((file) => resolve(cwd, file));
  let loaded;
  try {
    loaded = await loadSettings({
      clodentHome: home(deps),
      files,
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
  const fromFlag = (key) => {
    try {
      return { rules: flagRules(opts[key], { cwd, home: rulesHome }) };
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      return { error: `--${key}: ${err.message}` };
    }
  };
  const disallowed = fromFlag('disallowedTools');
  if (disallowed.error) return fail(disallowed.error);
  const allowed = fromFlag('allowedTools');
  if (allowed.error) return fail(allowed.error);
  const settingsFiles = [join(home(deps), 'settings.json'), ...files];
  const builtins = builtinDenies(settingsFiles, rulesHome);
  const permissions = {
    deny: [...(settings.permissions?.deny ?? []), ...disallowed.rules, ...builtins],
    ask: settings.permissions?.ask ?? [],
    allow: [...(settings.permissions?.allow ?? []), ...allowed.rules],
  };
  const env = { ...deps.env, ...settings.env };
  if (opts.print === '' && opts.inputFormat !== 'stream-json') return fail('-p needs a non-empty prompt');
  if (!env.ANTHROPIC_API_KEY) return fail('ANTHROPIC_API_KEY is not set');
  const base = baseUrlFrom(env);
  if (!base.ok) return fail(base.error ?? 'invalid ANTHROPIC_BASE_URL');
  const { id: model, contextWindow } = modelChoice(opts.model ?? settings.model ?? DEFAULT_MODEL);
  const addDirs = extraDirs(opts, settings, cwd);
  const where = { cwd, env, home: rulesHome };
  const scope = { dirs: addDirs, protect: hookPaths(settings, where) };
  const named = hookPaths(settings, where, (word) => word.includes('/'));
  const guarded = { protect: [...named, ...settingsFiles], protectExisting: hookPaths(settings, where, (word) => !word.includes('/')), home: rulesHome };
  let prompt;
  try {
    prompt = systemPrompt(opts, model, addDirs, deps, permissions);
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
  const readCap = readTokenCap(env);
  const warnings = [...loaded.warnings, ...session.warnings];
  if (readCap.warning) warnings.push(readCap.warning);
  if (prompt.claudeMdOnly) warnings.push(CLAUDE_MD_WARNING);
  return {
    settings,
    permissions,
    env,
    baseUrl: base.baseUrl,
    model,
    contextWindow,
    addDirs,
    scope,
    guarded,
    system: prompt.text,
    instructionFiles: prompt.instructionFiles,
    readMaxTokens: readCap.tokens,
    session,
    warnings,
  };
}

function createRuntime(prep, opts, deps, render) {
  const { settings, permissions, env, baseUrl, addDirs, scope } = prep;
  const { cwd } = deps;
  const procDeps = { spawn: deps.spawn, kill: deps.kill };
  const ledger = createLedger({ budgetUsd: opts.budgetUsd }, {});
  const statusLine = createStatusLine(
    { settings, env, cwd, version: version() },
    { ...procDeps, warn: (message) => render({ type: 'warning', message }) },
  );
  const guard = createGuard(permissions, { env: toolEnv(env, settings.envDeny ?? []), ...prep.guarded });
  const builtins = createTools({ ...procDeps, envDeny: settings.envDeny ?? [], readMaxTokens: prep.readMaxTokens });
  const tools = builtins.filter((tool) => !guard.removes(tool.name));
  const current = { model: prep.model, contextWindow: prep.contextWindow, system: prep.system, instructionFiles: prep.instructionFiles };
  const statusOf = (session, usage) =>
    statusState(usage, { modelId: current.model, contextWindow: current.contextWindow, sessionId: session.sessionId, transcriptPath: session.transcriptPath }, ledger);

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
        compactReloadFiles: settings.compactReloadFiles ?? DEFAULT_RELOAD_FILES,
        system: current.system,
        baseUrl,
        sessionId: session.sessionId,
        tools,
        toolset: createClodexToolset(env, { builtins: builtins.map((tool) => tool.name), removes: guard.removes, now: deps.now }),
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
        scope,
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
    contextWindow: () => current.contextWindow,
    instructionFiles: () => current.instructionFiles,
    setModel(raw) {
      const { id: model, contextWindow } = modelChoice(raw);
      const prompt = systemPrompt(opts, model, addDirs, deps, permissions);
      Object.assign(current, { model, contextWindow, system: prompt.text, instructionFiles: prompt.instructionFiles });
      return { model, system: prompt.text };
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
  let current = prep.session;
  const output = createStreamOutput(
    { version: version(), sessionId: () => current.sessionId, contextWindow: () => runtime.contextWindow(), instructionFiles: () => runtime.instructionFiles() },
    { out: deps.stdout, now: deps.now, uuid: deps.uuid, totalUsd: () => runtime.ledger.session().usd, unpriced: () => runtime.ledger.session().unpriced },
  );
  const runtime = createRuntime(prep, opts, deps, (event) => {
    toStderr(event);
    output.event(event);
  });
  return { runtime, output, useSession: (session) => (current = session) };
}

async function runStreamInput(opts, deps) {
  const prep = await prepare(opts, deps);
  if (prep.code !== undefined) return prep.code;
  headLines(opts, prep, deps.stderr);
  const { runtime, output, useSession } = streamRuntime(prep, opts, deps);
  return runStream(
    { runtime, output, useSession, session: prep.session, resume: opts.resume !== undefined, stdioAsk: opts.permissionPromptTool === 'stdio', signalExit: SIGNAL_EXIT },
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
