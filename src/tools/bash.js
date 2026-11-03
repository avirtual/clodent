import { spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createCapSink } from './cap.js';
import { checkInput, fail, oneLine } from './util.js';

export const DEFAULT_TIMEOUT_MS = 120000;
export const MAX_TIMEOUT_MS = 600000;
export const KILL_GRACE_MS = 2000;

export function clampTimeout(value) {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.ceil(n), MAX_TIMEOUT_MS);
}

function trailerFor({ timedOut, timeoutMs, code, signal }) {
  if (timedOut) return `[timed out after ${timeoutMs} ms]`;
  if (signal) return `[killed by ${signal}]`;
  return `[exit ${code}]`;
}

function execute(command, timeoutMs, ctx, { spawn, killGraceMs, kill }) {
  return new Promise((done) => {
    const sink = createCapSink();
    let lastChar = '\n';
    const append = (text) => {
      if (!text) return;
      sink.push(Buffer.from(text, 'utf8'));
      lastChar = text.at(-1);
    };
    let child;
    try {
      child = spawn('bash', ['-c', command], {
        cwd: ctx.cwd,
        env: ctx.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      done(fail(`Cannot run bash in ${ctx.cwd}: ${err.message}`));
      return;
    }
    let timedOut = false;
    let killTimer = null;
    let settled = false;
    const killGroup = (signal) => {
      if (child.pid === undefined) return;
      try {
        kill(-child.pid, signal);
      } catch {}
    };
    let exited = false;
    let graceOver = false;
    const releasePipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    child.on('exit', () => {
      exited = true;
      if (graceOver) releasePipes();
    });
    const terminate = () => {
      if (killTimer) return;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killGroup('SIGKILL');
        graceOver = true;
        if (exited) releasePipes();
      }, killGraceMs);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    ctx.signal?.addEventListener('abort', terminate, { once: true });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', terminate);
      done(result);
    };
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream.on('data', (chunk) => append(decoder.write(chunk)));
      stream.on('end', () => append(decoder.end()));
    }
    child.on('error', (err) => {
      finish(fail(`Cannot run bash in ${ctx.cwd}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      const status = { timedOut, timeoutMs, code, signal };
      sink.push(Buffer.from(`${lastChar === '\n' ? '' : '\n'}${trailerFor(status)}`, 'utf8'));
      finish({ content: sink.text(), isError: timedOut || signal !== null || code !== 0 });
    });
  });
}

export function createBash(deps = {}) {
  const options = {
    spawn: deps.spawn ?? nodeSpawn,
    kill: deps.kill ?? process.kill.bind(process),
    killGraceMs: deps.killGraceMs ?? KILL_GRACE_MS,
  };
  return {
    name: 'Bash',
    kind: 'exec',
    description: `Run a shell command with bash -c in the working directory. stdin is closed; stdout and stderr are returned interleaved in arrival order. timeout is in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}); on timeout or interrupt the whole process group is killed. The output ends with [exit <code>], [timed out after <ms> ms] or [killed by <signal>].`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run.' },
        timeout: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: `Timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.` },
        description: { type: 'string', description: 'A few words on what the command does.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    summary: (input) => oneLine(input?.command),
    async run(input, ctx) {
      const bad = checkInput(input, ['command'], ['description']);
      if (bad) return bad;
      if (ctx.signal?.aborted) return fail('Command not run: aborted');
      return execute(input.command, clampTimeout(input.timeout), ctx, options);
    },
  };
}
