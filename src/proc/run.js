import { spawn as nodeSpawn } from 'node:child_process';

export const KILL_GRACE_MS = 2000;
const MAX_TIMER_MS = 2147483647;

export function runProcess(command, { cwd, env, stdin, timeoutMs, signal, onStdout, onStderr }, deps = {}) {
  const spawn = deps.spawn ?? nodeSpawn;
  const kill = deps.kill ?? process.kill.bind(process);
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const base = { code: null, signal: null, timedOut: false, aborted: false, error: null };
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ...base, aborted: true });
      return;
    }
    let child;
    try {
      child = spawn('bash', ['-c', command], {
        cwd,
        env,
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      resolve({ ...base, error });
      return;
    }
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
      signal?.removeEventListener('abort', onAbort);
      resolve({ ...base, timedOut, aborted, ...fields });
    };
    child.on('exit', () => {
      exited = true;
      if (graceOver) setImmediate(releasePipes);
    });
    child.stdout?.on('data', (chunk) => onStdout?.(chunk));
    child.stderr?.on('data', (chunk) => onStderr?.(chunk));
    child.on('error', (error) => finish({ error }));
    child.on('close', (code, sig) => finish({ code, signal: sig }));
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
  });
}
