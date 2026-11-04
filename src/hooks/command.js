import { spawn as nodeSpawn } from 'node:child_process';

export const OUTPUT_CAP_BYTES = 65536;
export const KILL_GRACE_MS = 2000;
const MAX_TIMER_MS = 2147483647;

function collector() {
  const chunks = [];
  let size = 0;
  return {
    push(chunk) {
      if (size >= OUTPUT_CAP_BYTES) return;
      const take = chunk.subarray(0, OUTPUT_CAP_BYTES - size);
      chunks.push(take);
      size += take.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

export function failureOf(result) {
  if (result.error) return result.error.message ?? String(result.error);
  if (result.timedOut) return 'timeout';
  if (result.aborted) return 'aborted';
  if (result.signal) return `killed by ${result.signal}`;
  if (result.code !== 0) return `exit ${result.code}`;
  return null;
}

export function commandLabel(command) {
  return command.slice(0, 60);
}

export function runCommand(command, { cwd, env, stdin, timeoutMs, signal }, deps = {}) {
  const spawn = deps.spawn ?? nodeSpawn;
  const kill = deps.kill ?? process.kill.bind(process);
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const base = { code: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, error: null };
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ...base, aborted: true });
      return;
    }
    let child;
    try {
      child = spawn('bash', ['-c', command], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      resolve({ ...base, error: err });
      return;
    }
    const out = collector();
    const err = collector();
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let exited = false;
    let graceOver = false;
    let killTimer = null;
    const releasePipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const killGroup = (sig) => {
      if (child.pid === undefined) return;
      try {
        kill(-child.pid, sig);
      } catch {}
    };
    const terminate = () => {
      if (killTimer) return;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killGroup('SIGKILL');
        graceOver = true;
        if (exited) setImmediate(releasePipes);
      }, killGraceMs);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      if (aborted) return;
      timedOut = true;
      terminate();
    }, Math.min(timeoutMs, MAX_TIMER_MS));
    const onAbort = () => {
      if (timedOut) return;
      aborted = true;
      clearTimeout(timer);
      terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (fields) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ...base, stdout: out.text(), stderr: err.text(), timedOut, aborted, ...fields });
    };
    child.on('exit', () => {
      exited = true;
      if (graceOver) setImmediate(releasePipes);
    });
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => finish({ error }));
    child.on('close', (code, sig) => finish({ code, signal: sig }));
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin ?? '');
    }
  });
}
