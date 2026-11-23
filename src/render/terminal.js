import { formatBudgetStop, formatCost, formatTotal, formatUnpriced } from '../cost/format.js';
import { clipRows, linesRows, wrapWords } from '../repl/width.js';
import { visible } from '../text.js';

const STYLES = { dim: 2, red: 31, yellow: 33 };
const TEXT_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const SUMMARY_ROWS = 3;
const BASH_TRAILER = /^\[(exit -?\d+|timed out after \d+ ms|killed by \S+)\]$/;

export const CUT_OFF_NOTE = 'clodent: the text above was cut off and is repeated below';
export const COMPACTING = 'clodent: compacting…';
export const NO_MESSAGE = '(no message)';

function paint(stream, style, text) {
  return stream.isTTY && style ? `\x1b[${STYLES[style]}m${text}\x1b[0m` : text;
}

function errorLine(name, content, cwd) {
  const lines = String(content ?? '')
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => text !== '');
  const last = lines.at(-1);
  if (name === 'Bash' && last !== undefined && BASH_TRAILER.test(last)) return last;
  const first = lines[0] ?? NO_MESSAGE;
  return name === 'Read' && cwd ? first.split(`${cwd}/`).join('') : first;
}

function messageText(message) {
  return (message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export const TOO_LONG_HINTS = Object.freeze({
  repl: "clodent: the conversation is larger than the model's context window; use /compact or /clear",
  print: "clodent: the conversation is larger than the model's context window; start a new session",
});

export function createRenderer({ out, err, mode, screen }) {
  const repl = mode === 'repl';
  const info = repl ? out : err;
  const warnedUnpriced = new Set();
  const denied = new Set();
  let cwd = null;
  let finalText = '';
  let midLine = false;
  let attempt = { shown: '', clean: true };
  let textIndex = null;
  let heldCr = false;
  let drewText = false;
  let thinkingRun = false;
  let heldTool = null;

  const columnsOf = (stream) => (stream.columns > 0 ? stream.columns : DEFAULT_COLUMNS);
  const screenRows = () => (out.rows > 0 ? out.rows : DEFAULT_ROWS);

  function newAttempt() {
    attempt = { shown: '', clean: true };
  }

  function drawText(text) {
    const shown = visible(text, TEXT_CONTROLS);
    out.write(shown);
    attempt.shown += shown;
    midLine = !text.endsWith('\n');
  }

  function flushCr() {
    if (!heldCr) return;
    heldCr = false;
    drawText('\r');
  }

  function endLine() {
    flushCr();
    if (!midLine) return;
    out.write('\n');
    attempt.shown += '\n';
    midLine = false;
  }

  function layout(text, fit) {
    if (!info.isTTY) return text;
    const cols = columnsOf(info);
    return fit === 'clip' ? clipRows(text, cols, SUMMARY_ROWS) : wrapWords(text, cols);
  }

  function line(text, style, { fit = 'wrap', part = false } = {}) {
    if (repl) endLine();
    const shown = layout(visible(text), fit);
    const draw = () => info.write(`${paint(info, style, shown)}\n`);
    if (screen) screen.aside(draw);
    else draw();
    if (part) {
      attempt.shown += `${shown}\n`;
      return;
    }
    attempt.clean = false;
    thinkingRun = false;
  }

  function takeBack() {
    const { shown, clean } = attempt;
    newAttempt();
    heldCr = false;
    if (!repl || shown === '') return;
    const rows = linesRows(shown, columnsOf(out));
    if (out.isTTY && clean && rows < screenRows()) {
      out.write(`\r${rows > 1 ? `\x1b[${rows - 1}A` : ''}\x1b[J`);
      midLine = false;
      textIndex = null;
      thinkingRun = false;
      return;
    }
    line(CUT_OFF_NOTE, 'dim');
  }

  function warnUnpriced(turn) {
    for (const model of turn.unpriced) {
      if (warnedUnpriced.has(model)) continue;
      warnedUnpriced.add(model);
      line(formatUnpriced(model), 'yellow');
    }
  }

  function releaseTool() {
    const { text } = heldTool;
    heldTool = null;
    line(text, undefined, { fit: 'clip' });
  }

  const handlers = {
    session_start(event) {
      cwd = event.cwd ?? null;
    },
    request_start() {
      newAttempt();
      textIndex = null;
      heldCr = false;
      drewText = false;
    },
    text_delta({ text, index }) {
      if (!repl || text === '') return;
      if (textIndex !== null && index !== textIndex) endLine();
      textIndex = index;
      let chunk = `${heldCr ? '\r' : ''}${text}`;
      heldCr = chunk.endsWith('\r');
      if (heldCr) chunk = chunk.slice(0, -1);
      chunk = chunk.replaceAll('\r\n', '\n');
      if (chunk === '') return;
      drawText(chunk);
      drewText = true;
      thinkingRun = false;
    },
    thinking_delta() {
      if (!repl || !out.isTTY || thinkingRun) return;
      line('thinking…', 'dim', { part: true });
      thinkingRun = true;
    },
    assistant_message({ message }) {
      if (message.stop_reason !== 'tool_use') finalText = messageText(message);
      if (!repl) return;
      flushCr();
      if (message.stop_reason === 'max_tokens' && drewText && message.content?.at(-1)?.type === 'text') {
        out.write(paint(out, 'dim', '…'));
        midLine = true;
      }
      endLine();
      newAttempt();
    },
    tool_use({ id, name, summary }) {
      const text = summary ? `● ${name} ${summary}` : `● ${name}`;
      if (repl) heldTool = { id, text };
      else line(text, undefined, { fit: 'clip' });
    },
    permission_request({ id, name, summary }) {
      if (heldTool?.id === id) heldTool = null;
      line(summary ? `[clodent:permit ${name} ${id}] ${summary}` : `[clodent:permit ${name} ${id}]`, undefined, { fit: 'clip' });
    },
    permission({ id, decision, reason }) {
      if (decision !== 'deny') return;
      denied.add(id);
      line(`  ✗ ${reason}`, 'red');
    },
    tool_result({ id, name, content, isError }) {
      if (isError && !denied.has(id)) line(`  ✗ ${errorLine(name, content, cwd)}`, 'red');
    },
    warning({ message, retry }) {
      if (retry === 'http') {
        line(`clodent: ${message}`, 'dim');
        return;
      }
      if (retry === 'stream') takeBack();
      line(`clodent: ${message}`, 'yellow');
    },
    error({ message, contextWindowExceeded }) {
      line(`clodent: ${message}`, 'red');
      if (contextWindowExceeded) line(repl ? TOO_LONG_HINTS.repl : TOO_LONG_HINTS.print, 'red');
    },
    budget_stop({ result }) {
      line(formatBudgetStop(result), 'yellow');
    },
    interrupted() {
      line('clodent: interrupted', 'yellow');
    },
    turn_end({ turn }) {
      warnUnpriced(turn);
      if (!repl && finalText !== '') out.write(`${finalText}\n`);
      line(formatCost(turn), 'dim');
      finalText = '';
      denied.clear();
    },
    compact_start() {
      if (repl) line(COMPACTING, 'dim');
    },
    compacted({ preTokens, postTokens, reloaded, skipped, turn }) {
      line(`clodent: conversation compacted (${preTokens} → ${postTokens} tokens)`);
      if (reloaded.length > 0) line(`clodent: reloaded ${reloaded.length} file(s) after compact: ${reloaded.map((file) => file.path).join(', ')}`);
      for (const { path, reason } of skipped) line(`clodent: not reloaded ${path}: ${reason}`);
      warnUnpriced(turn);
      line(formatCost(turn), 'dim');
    },
    session_end({ session }) {
      line(formatTotal(session), 'dim');
    },
  };

  return (event) => {
    if (heldTool && !(event.type === 'permission_request' && event.id === heldTool.id)) releaseTool();
    handlers[event.type]?.(event);
  };
}
