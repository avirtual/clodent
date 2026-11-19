const LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

export const INTERRUPTED_RESULT = 'interrupted by user';

export function visible(text, controls = LINE_CONTROLS) {
  return String(text ?? '').replace(controls, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
