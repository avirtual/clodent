export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

const CTRL_KEYS = Object.freeze({ '\x03': 'c', '\x04': 'd', '\x15': 'u', '\x17': 'w' });
const INCOMPLETE = Object.freeze({ incomplete: true });

function isControl(ch) {
  const code = ch.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function escapeAt(input, start) {
  if (start + 1 >= input.length) return INCOMPLETE;
  const kind = input[start + 1];
  if (kind === 'O') return start + 2 >= input.length ? INCOMPLETE : { length: 3 };
  if (kind !== '[') return { length: 1 };
  for (let i = start + 2; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return { length: i - start + 1 };
    if (code < 0x20 || code > 0x3f) return { length: i - start };
  }
  return INCOMPLETE;
}

export function createKeyParser() {
  let held = '';
  let paste = null;
  let afterCR = false;

  function feed(text) {
    const input = held + text;
    held = '';
    const tokens = [];
    let run = '';
    const push = (token) => {
      if (run !== '') tokens.push({ type: 'text', text: run });
      run = '';
      if (token) tokens.push(token);
    };
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      if (ch === '\x1b') {
        const seq = escapeAt(input, i);
        if (seq.incomplete) {
          held = input.slice(i);
          break;
        }
        const body = input.slice(i, i + seq.length);
        if (paste === null && body === PASTE_START) {
          push();
          paste = '';
        } else if (paste !== null && body === PASTE_END) {
          tokens.push({ type: 'paste', text: paste });
          paste = null;
        }
        afterCR = false;
        i += seq.length;
        continue;
      }
      i++;
      const lf = ch === '\n' && afterCR;
      afterCR = ch === '\r';
      if (lf) continue;
      if (paste !== null) {
        if (ch === '\r' || ch === '\n') paste += '\n';
        else if (ch === '\t' || !isControl(ch)) paste += ch;
      } else if (ch === '\r' || ch === '\n') {
        push({ type: 'enter' });
      } else if (ch === '\x7f' || ch === '\x08') {
        push({ type: 'backspace' });
      } else if (CTRL_KEYS[ch]) {
        push({ type: 'ctrl', key: CTRL_KEYS[ch] });
      } else if (!isControl(ch)) {
        run += ch;
      }
    }
    push();
    return tokens;
  }

  return { feed };
}
