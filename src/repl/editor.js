export function lineCount(text) {
  return text.replace(/\n$/, '').split('\n').length;
}

export function pasteEcho(text) {
  return text.includes('\n') ? `[pasted text, ${lineCount(text)} lines]` : text;
}

function echoOf(part) {
  return part.kind === 'paste' ? pasteEcho(part.text) : part.text;
}

export function isBlank(submission) {
  return submission.text.trim() === '';
}

export function isTyped(submission) {
  return submission.parts.every((part) => part.kind === 'typed');
}

export function createEditor() {
  let parts = [];

  function tail() {
    return parts.at(-1);
  }

  return {
    insertText(text) {
      const last = tail();
      if (last?.kind === 'typed') last.text += text;
      else parts.push({ kind: 'typed', text });
      return text;
    },
    insertPaste(text) {
      const part = { kind: 'paste', text };
      parts.push(part);
      return echoOf(part);
    },
    backspace() {
      const last = tail();
      if (!last) return;
      if (last.kind === 'typed') last.text = Array.from(last.text).slice(0, -1).join('');
      if (last.kind === 'paste' || last.text === '') parts.pop();
    },
    deleteWord() {
      const last = tail();
      if (!last) return;
      if (last.kind === 'typed') last.text = last.text.replace(/\S*\s*$/, '');
      if (last.kind === 'paste' || last.text === '') parts.pop();
    },
    clear() {
      parts = [];
    },
    isEmpty: () => parts.length === 0,
    echo: () => parts.map(echoOf).join(''),
    take() {
      const submission = { text: parts.map((part) => part.text).join(''), parts };
      parts = [];
      return submission;
    },
  };
}
