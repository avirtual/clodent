#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';
import { isInteractive } from '../src/args.js';

// Raw mode before cli.js loads: until then the cooked tty echoes keys typed at startup.
if (process.stdin.isTTY && isInteractive(process.argv.slice(2))) process.stdin.setRawMode(true);
const { ignoreBrokenPipes, main } = await import('../src/cli.js');

ignoreBrokenPipes(process.stdout);
ignoreBrokenPipes(process.stderr);

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
  platform: process.platform,
  fetch: globalThis.fetch,
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
  random: Math.random,
  now: () => performance.now(),
  clock: () => new Date(),
  onSignal: (name, handler) => {
    process.on(name, handler);
    return () => process.off(name, handler);
  },
});
