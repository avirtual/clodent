import { runProcess } from '../proc/run.js';

export const STDOUT_CAP_BYTES = 1048576;
export const STDERR_CAP_BYTES = 65536;

function collector(cap) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (size >= cap) {
        truncated = true;
        return;
      }
      const take = chunk.subarray(0, cap - size);
      if (take.length < chunk.length) truncated = true;
      chunks.push(take);
      size += take.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    truncated: () => truncated,
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

export async function runCommand(command, { cwd, env, stdin, timeoutMs, signal }, deps = {}) {
  const out = collector(STDOUT_CAP_BYTES);
  const err = collector(STDERR_CAP_BYTES);
  const res = await runProcess(
    command,
    { cwd, env, stdin: stdin ?? '', timeoutMs, signal, onStdout: out.push, onStderr: err.push },
    deps,
  );
  return { ...res, stdout: out.text(), stderr: err.text(), truncated: out.truncated() };
}
