const CLASS_SPECIAL = /[\\\][^-]/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classEnd(glob, open) {
  let j = open + 1;
  if (glob[j] === '!' || glob[j] === '^') j += 1;
  if (glob[j] === ']') j += 1;
  while (j < glob.length && glob[j] !== ']') j += glob[j] === '\\' ? 2 : 1;
  return j < glob.length ? j : -1;
}

function translateClass(body) {
  const negate = body[0] === '!' || body[0] === '^';
  let out = '';
  for (let i = negate ? 1 : 0; i < body.length; i += 1) {
    const escaped = body[i] === '\\' && i + 1 < body.length;
    if (escaped) i += 1;
    const c = body[i];
    out += (escaped || c !== '-') && CLASS_SPECIAL.test(c) ? `\\${c}` : c;
  }
  return negate ? `[^/${out}]` : `[${out}]`;
}

function findBraceGroup(glob) {
  for (let i = 0; i < glob.length; i += 1) {
    if (glob[i] === '\\') {
      i += 1;
      continue;
    }
    if (glob[i] !== '{') continue;
    let depth = 0;
    const commas = [];
    let j = i;
    for (; j < glob.length; j += 1) {
      const c = glob[j];
      if (c === '\\') j += 1;
      else if (c === '{') depth += 1;
      else if (c === '}' && --depth === 0) break;
      else if (c === ',' && depth === 1) commas.push(j);
    }
    if (j >= glob.length || commas.length === 0) continue;
    const bounds = [i, ...commas, j];
    const parts = bounds.slice(0, -1).map((b, k) => glob.slice(b + 1, bounds[k + 1]));
    return { start: i, end: j, parts };
  }
  return null;
}

export function expandBraces(glob) {
  const group = findBraceGroup(glob);
  if (!group) return [glob];
  const prefix = glob.slice(0, group.start);
  const suffix = glob.slice(group.end + 1);
  return group.parts.flatMap((part) => expandBraces(prefix + part + suffix));
}

function translate(glob) {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) {
      out += escapeRegExp(glob[i + 1]);
      i += 2;
    } else if (c === '*') {
      let j = i;
      while (glob[j] === '*') j += 1;
      const wholeSegment = (i === 0 || glob[i - 1] === '/') && (j === glob.length || glob[j] === '/');
      if (j - i >= 2 && wholeSegment && j === glob.length) {
        out += '.*';
        i = j;
      } else if (j - i >= 2 && wholeSegment) {
        out += '(?:.*/)?';
        i = j + 1;
      } else {
        out += '[^/]*';
        i = j;
      }
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if (c === '[' && classEnd(glob, i) !== -1) {
      const close = classEnd(glob, i);
      out += translateClass(glob.slice(i + 1, close));
      i = close + 1;
    } else {
      out += escapeRegExp(c);
      i += 1;
    }
  }
  return out;
}

export function globToRegExp(glob) {
  const alternatives = expandBraces(glob).map(translate);
  return new RegExp(`^(?:${alternatives.join('|')})$`);
}
