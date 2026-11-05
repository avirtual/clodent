import { INTERRUPTED_RESULT, USER_DENIAL } from '../agent/loop.js';
import { visible } from '../render/terminal.js';
import { createEditor, isBlank, isTyped, lineCount } from './editor.js';
import { createKeyParser } from './keys.js';
import { parseCommand, runCommand } from './slash.js';

export const PASTE_ON = '\x1b[?2004h';
export const PASTE_OFF = '\x1b[?2004l';
export const PROMPT = '> ';
export const CLEAR_LINE = '\r\x1b[2K';
export const EXIT_HINT = '(press Ctrl-C again or Ctrl-D to exit)';
export const ASK_LINE = 'Allow? [y/n] ';
export const QUEUED_NOTE = 'clodent: queued as a prompt; answer y or n';
export const CLOSED_DENIAL = 'denied: input closed';

const YES = new Set(['y', 'yes']);
const NO = new Set(['n', 'no']);
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export function queuedEcho(submission) {
  const [first] = submission.text.split('\n');
  const more = lineCount(submission.text) - 1;
  return `${PASTE_ON}${PROMPT}${first}${more > 0 ? ` [+${more} lines]` : ''}\n`;
}

export async function runRepl(ctx, deps) {
  const { stdin, stdout } = deps;
  const { runtime } = ctx;
  const parser = createKeyParser();
  const editor = createEditor();
  const queue = [];
  const stopHooks = new AbortController();
  const raw = stdin.isTTY === true && typeof stdin.setRawMode === 'function';
  let session = ctx.session;
  let agent = null;
  let mode = 'busy';
  let running = null;
  let asking = null;
  let wake = null;
  let armed = false;
  let ended = false;
  let exitCode = null;

  const write = (text) => stdout.write(text);
  const print = (line) => write(`${visible(line)}\n`);

  function showPrompt() {
    mode = 'idle';
    write(`${PASTE_ON}${PROMPT}${editor.echo()}`);
  }

  function leavePrompt(value) {
    write('\n');
    const resolve = wake;
    wake = null;
    mode = 'busy';
    resolve(value);
  }

  function edit(target, token, prefix) {
    const echo = prefix !== null;
    if (token.type === 'text' || token.type === 'paste') {
      const shown = token.type === 'text' ? target.insertText(token.text) : target.insertPaste(token.text);
      if (echo) write(shown);
      return true;
    }
    if (token.type === 'backspace') target.backspace();
    else if (token.type === 'ctrl' && token.key === 'u') target.clear();
    else if (token.type === 'ctrl' && token.key === 'w') target.deleteWord();
    else return false;
    if (echo) write(`${CLEAR_LINE}${prefix}${target.echo()}`);
    return true;
  }

  function onIdleToken(token, ctrlC, wasArmed) {
    if (edit(editor, token, PROMPT)) return;
    if (token.type === 'enter') {
      const submission = editor.take();
      if (!isBlank(submission)) {
        leavePrompt(submission);
        return;
      }
      write('\n');
      showPrompt();
    } else if (ctrlC && !editor.isEmpty()) {
      editor.clear();
      write(`${CLEAR_LINE}${PROMPT}`);
    } else if (ctrlC && wasArmed) {
      leavePrompt(null);
    } else if (ctrlC) {
      write(`\n${EXIT_HINT}\n`);
      armed = true;
      showPrompt();
    } else if (token.type === 'ctrl' && token.key === 'd' && editor.isEmpty()) {
      leavePrompt(null);
    }
  }

  function onAskToken(token, ctrlC) {
    const { answer, done } = asking;
    if (edit(answer, token, ASK_LINE)) return;
    if (ctrlC) running?.abort();
    if (token.type !== 'enter') return;
    const submission = answer.take();
    write('\n');
    const word = isTyped(submission) ? submission.text.trim().toLowerCase() : null;
    if (YES.has(word)) return done({ allow: true });
    if (NO.has(word)) return done({ allow: false, reason: USER_DENIAL });
    if (!isBlank(submission)) {
      queue.push(submission);
      print(QUEUED_NOTE);
    }
    write(ASK_LINE);
  }

  function onBusyToken(token, ctrlC) {
    if (edit(editor, token, null)) return;
    if (token.type === 'enter') {
      const submission = editor.take();
      if (!isBlank(submission)) queue.push(submission);
    } else if (ctrlC) {
      running?.abort();
    }
  }

  function onToken(token) {
    const ctrlC = token.type === 'ctrl' && token.key === 'c';
    const wasArmed = armed;
    armed = false;
    if (mode === 'idle') onIdleToken(token, ctrlC, wasArmed);
    else if (mode === 'ask') onAskToken(token, ctrlC);
    else onBusyToken(token, ctrlC);
  }

  function onData(text) {
    for (const token of parser.feed(text)) onToken(token);
  }

  function onEnd() {
    ended = true;
    if (mode === 'idle') leavePrompt(null);
    else if (mode === 'ask') {
      write('\n');
      asking.done({ allow: false, reason: CLOSED_DENIAL });
    }
  }

  function onError(err) {
    onEnd();
    if (err?.code !== 'EIO') print(`clodent: ${err?.message ?? err}`);
  }

  function onSignal(name) {
    if (name === 'SIGINT') {
      onToken({ type: 'ctrl', key: 'c' });
      return;
    }
    if (exitCode !== null) {
      stopHooks.abort();
      return;
    }
    exitCode = ctx.signalExit[name];
    running?.abort();
    if (mode === 'idle') leavePrompt(null);
  }

  function ask(request, signal) {
    if (signal?.aborted) return Promise.resolve({ allow: false, reason: INTERRUPTED_RESULT });
    if (ended) return Promise.resolve({ allow: false, reason: CLOSED_DENIAL });
    return new Promise((resolve) => {
      const onAbort = () => {
        write('\n');
        done({ allow: false, reason: INTERRUPTED_RESULT });
      };
      const done = (verdict) => {
        signal?.removeEventListener('abort', onAbort);
        asking = null;
        mode = 'busy';
        resolve(verdict);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      asking = { answer: createEditor(), done };
      mode = 'ask';
      write(ASK_LINE);
    });
  }

  async function guarded(step) {
    const controller = new AbortController();
    running = controller;
    if (exitCode !== null) controller.abort();
    try {
      return await step(controller.signal);
    } finally {
      running = null;
    }
  }

  function nextSubmission() {
    return new Promise((resolve) => {
      wake = resolve;
      showPrompt();
    });
  }

  async function clearSession() {
    const next = runtime.freshSession();
    if (!next.ok) {
      print(`clodent: ${next.error}`);
      return;
    }
    session = next;
    print(`[clodent:session] ${session.sessionId}`);
    agent = runtime.open(session, { ask });
    runtime.resetStatus(session);
    await guarded((signal) => agent.fireSessionStart('clear', { signal }));
  }

  const commandCtx = {
    print,
    ledger: runtime.ledger,
    model: () => runtime.model(),
    setModel(id) {
      agent.setModel(id, runtime.setModel(id));
    },
    clear: clearSession,
    compact(instructions) {
      return guarded((signal) => agent.compact({ instructions, trigger: 'manual' }, { signal }));
    },
  };

  async function handle(submission) {
    const command = parseCommand(submission);
    if (command) return runCommand(command, commandCtx);
    await guarded((signal) => agent.runTurn(submission.text, { signal, stopSignal: stopHooks.signal }));
    return undefined;
  }

  const offs = SIGNALS.map((name) => deps.onSignal(name, () => onSignal(name)));
  if (raw) stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.on('data', onData);
  stdin.on('end', onEnd);
  stdin.on('error', onError);
  try {
    print(`[clodent:session] ${session.sessionId}`);
    for (const warning of ctx.warnings) print(`clodent: ${warning}`);
    agent = runtime.open(session, { ask });
    await guarded((signal) => agent.fireSessionStart(ctx.resume ? 'resume' : 'startup', { signal }));
    while (exitCode === null) {
      let submission;
      if (queue.length > 0) {
        submission = queue.shift();
        write(queuedEcho(submission));
      } else if (ended) {
        break;
      } else {
        submission = await nextSubmission();
        if (submission === null) break;
      }
      if ((await handle(submission)) === 'exit') break;
    }
    agent.endSession();
    await runtime.statusLine.flush();
  } finally {
    write(PASTE_OFF);
    if (raw) stdin.setRawMode(false);
    stdin.off('data', onData);
    stdin.off('end', onEnd);
    stdin.off('error', onError);
    stdin.pause();
    for (const off of offs) off();
  }
  return exitCode ?? 0;
}
