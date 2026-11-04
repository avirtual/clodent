import { formatBudgetStop, formatCost, formatTotal, formatUnpriced } from '../cost/format.js';

const STYLES = { dim: 2, red: 31, yellow: 33 };

function paint(stream, style, text) {
  return stream.isTTY && style ? `\x1b[${STYLES[style]}m${text}\x1b[0m` : text;
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0];
}

function messageText(message) {
  return (message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function createRenderer({ out, err, mode }) {
  const repl = mode === 'repl';
  const info = repl ? out : err;
  const warnedUnpriced = new Set();
  const denied = new Set();
  const thinkingShown = new Set();
  let finalText = '';
  let midLine = false;

  function endLine() {
    if (!midLine) return;
    out.write('\n');
    midLine = false;
  }

  function line(text, style) {
    if (repl) endLine();
    info.write(`${paint(info, style, text)}\n`);
  }

  const handlers = {
    request_start() {
      thinkingShown.clear();
    },
    text_delta({ text }) {
      if (!repl || text === '') return;
      out.write(text);
      midLine = !text.endsWith('\n');
    },
    thinking_delta({ index }) {
      if (!repl || !out.isTTY || thinkingShown.has(index)) return;
      thinkingShown.add(index);
      line('thinking…', 'dim');
    },
    assistant_message({ message }) {
      if (message.stop_reason !== 'tool_use') finalText = messageText(message);
      if (repl) endLine();
    },
    tool_use({ name, summary }) {
      line(summary ? `● ${name} ${summary}` : `● ${name}`);
    },
    permission_request({ id, name, summary }) {
      line(`[clay:permit ${name} ${id}] ${summary}`);
    },
    permission({ id, decision, reason }) {
      if (decision !== 'deny') return;
      denied.add(id);
      line(`  ✗ ${reason}`, 'red');
    },
    tool_result({ id, content, isError }) {
      if (isError && !denied.has(id)) line(`  ✗ ${firstLine(content)}`, 'red');
    },
    warning({ message }) {
      line(`clay: ${message}`, 'yellow');
    },
    error({ message }) {
      line(`clay: ${message}`, 'red');
    },
    budget_stop({ result }) {
      line(formatBudgetStop(result), 'yellow');
    },
    interrupted() {
      line('clay: interrupted', 'yellow');
    },
    turn_end({ turn }) {
      for (const model of turn.unpriced) {
        if (warnedUnpriced.has(model)) continue;
        warnedUnpriced.add(model);
        line(formatUnpriced(model), 'yellow');
      }
      if (!repl && finalText !== '') out.write(`${finalText}\n`);
      line(formatCost(turn), 'dim');
      finalText = '';
      denied.clear();
    },
    session_end({ session }) {
      line(formatTotal(session), 'dim');
    },
  };

  return (event) => {
    handlers[event.type]?.(event);
  };
}
