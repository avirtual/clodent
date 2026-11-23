import { execFileSync } from 'node:child_process';
import { closeSync, constants, createReadStream, openSync } from 'node:fs';
import { join } from 'node:path';
import { script } from '../hooks/scripts.js';
import { useTempDir } from '../tools/tmp-dir.js';
import { hookGroup, toolsReply, writeSettings } from './run-main.js';

export function readFifoLine(path, t) {
  const stream = createReadStream(path, 'utf8');
  t.after(() => {
    try {
      closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {}
    stream.destroy();
  });
  return new Promise((resolve, reject) => {
    let text = '';
    stream.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) resolve(text.trim());
    });
    stream.on('error', reject);
  });
}

export async function slowPost(t) {
  const home = await useTempDir(t);
  const cwd = await useTempDir(t);
  const dir = await useTempDir(t);
  const ran = join(dir, 'ran.fifo');
  const fifo = join(dir, 'post.fifo');
  execFileSync('mkfifo', [ran]);
  execFileSync('mkfifo', [fifo]);
  const post = await script(dir, 'post.sh', `cat > /dev/null\necho up > ${JSON.stringify(fifo)}\nexec sleep 30`);
  const stopRan = join(dir, 'stop-ran');
  const stop = await script(dir, 'stop.sh', `cat > /dev/null\ntouch ${JSON.stringify(stopRan)}`);
  const settings = writeSettings(dir, { hooks: { PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command: post, timeout: 3 }] }], Stop: [hookGroup('', stop)] } });
  const command = `echo run > ${JSON.stringify(ran)}; exec sleep 30`;
  return { home, cwd, dir, settings, reply: toolsReply([['Bash', { command }]]), running: readFifoLine(ran, t), up: readFifoLine(fifo, t), stopRan };
}
