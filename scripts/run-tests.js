import { run } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from './suite-runner.js';

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
  root: fileURLToPath(new URL('..', import.meta.url)),
  run,
});
