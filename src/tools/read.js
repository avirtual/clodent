import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkInput, describeFsError, fail, isBinary, ok, oneLine, positiveInt } from './util.js';

export const DEFAULT_LIMIT = 2000;
export const MAX_LINE_CHARS = 2000;

function cutLine(line) {
  if (line.length <= MAX_LINE_CHARS) return line;
  const code = line.charCodeAt(MAX_LINE_CHARS - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? MAX_LINE_CHARS - 1 : MAX_LINE_CHARS;
  return `${line.slice(0, end)}…`;
}

export function createRead() {
  return {
    name: 'Read',
    kind: 'read',
    description: `Read a text file. Lines come back in cat -n style: the line number right-aligned in 6 columns, a tab, then the line. offset is the 1-based first line; limit defaults to ${DEFAULT_LIMIT} lines. Lines longer than ${MAX_LINE_CHARS} characters are cut with …. Relative paths resolve against the working directory.`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path of the file to read.' },
        offset: { type: 'integer', minimum: 1, description: '1-based line to start at. Default 1.' },
        limit: { type: 'integer', minimum: 1, description: `Number of lines to read. Default ${DEFAULT_LIMIT}.` },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    summary: (input) => oneLine(input?.file_path),
    async run(input, ctx) {
      const bad = checkInput(input, ['file_path']);
      if (bad) return bad;
      const path = resolve(ctx.cwd, input.file_path);
      let info;
      try {
        info = await stat(path);
      } catch (err) {
        return fail(describeFsError(err, path));
      }
      if (info.isDirectory()) return fail(`${path} is a directory, not a file`);
      if (!info.isFile()) return fail(`${path} is not a regular file`);
      let buf;
      try {
        buf = await readFile(path);
      } catch (err) {
        return fail(describeFsError(err, path));
      }
      if (buf.length === 0) return ok(`${path} is empty (0 bytes)`);
      if (isBinary(buf)) return fail(`${path} is a binary file (NUL byte in the first 8 KiB)`);
      const lines = buf.toString('utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      const offset = positiveInt(input.offset, 1);
      const limit = positiveInt(input.limit, DEFAULT_LIMIT);
      if (offset > lines.length) {
        return fail(`offset ${offset} is past the end of ${path} (${lines.length} lines)`);
      }
      const shown = lines.slice(offset - 1, offset - 1 + limit);
      return ok(shown.map((line, i) => `${String(offset + i).padStart(6)}\t${cutLine(line)}`).join('\n'));
    },
  };
}
