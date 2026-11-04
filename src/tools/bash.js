import { StringDecoder } from 'node:string_decoder';
import { KILL_GRACE_MS, runProcess } from '../proc/run.js';
import { createCapSink } from './cap.js';
import { toolEnv } from './env.js';
import { checkInput, fail, oneLine } from './util.js';

export const DEFAULT_TIMEOUT_MS = 120000;
export const MAX_TIMEOUT_MS = 600000;
export { KILL_GRACE_MS };

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

async function execute(command, timeoutMs, ctx, deps) {
  const sink = createCapSink();
  let lastChar = '\n';
  const append = (text) => {
    if (!text) return;
    sink.push(Buffer.from(text, 'utf8'));
    lastChar = text.at(-1);
  };
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const res = await runProcess(
    command,
    {
      cwd: ctx.cwd,
      env: ctx.env,
      timeoutMs,
      signal: ctx.signal,
      onStdout: (chunk) => append(decoders.stdout.write(chunk)),
      onStderr: (chunk) => append(decoders.stderr.write(chunk)),
    },
    deps,
  );
  if (res.error) return fail(`Cannot run bash in ${ctx.cwd}: ${res.error.message}`);
  append(decoders.stdout.end());
  append(decoders.stderr.end());
  const status = { timedOut: res.timedOut, timeoutMs, code: res.code, signal: res.signal };
  sink.push(Buffer.from(`${lastChar === '\n' ? '' : '\n'}${trailerFor(status)}`, 'utf8'));
  return { content: sink.text(), isError: res.timedOut || res.signal !== null || res.code !== 0 };
}

export function createBash(deps = {}) {
  const options = { spawn: deps.spawn, kill: deps.kill, killGraceMs: deps.killGraceMs };
  const envDeny = deps.envDeny ?? [];
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
      return execute(input.command, clampTimeout(input.timeout), { ...ctx, env: toolEnv(ctx.env, envDeny) }, options);
    },
  };
}
