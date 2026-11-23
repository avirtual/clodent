import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { capResult } from './cap.js';
import { structuredPatch } from './patch.js';
import { checkInput, fail, isBinary, ok, oneLine } from './util.js';

async function previous(path) {
  try {
    return { exists: true, buf: await readFile(path) };
  } catch (err) {
    return { exists: err?.code !== 'ENOENT', buf: null };
  }
}

function writeResult(path, content, before) {
  if (!before.exists) return { type: 'create', filePath: path, content: capResult(content), structuredPatch: [] };
  const patch = before.buf && !isBinary(before.buf) ? structuredPatch(before.buf.toString('utf8'), content) : [];
  return { type: 'update', filePath: path, structuredPatch: patch };
}

export function createWrite() {
  return {
    name: 'Write',
    kind: 'write',
    description: 'Write a file with the given content. Parent directories are created and an existing file is overwritten. Relative paths resolve against the working directory.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path of the file to write.' },
        content: { type: 'string', description: 'The full new content of the file.' },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
    summary: (input) => oneLine(input?.file_path),
    async run(input, ctx) {
      const bad = checkInput(input, ['file_path', 'content']);
      if (bad) return bad;
      const path = resolve(ctx.cwd, input.file_path);
      const before = await previous(path);
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, input.content);
      } catch (err) {
        return fail(`Cannot write ${path}: ${err.message}`);
      }
      return ok(`Wrote ${Buffer.byteLength(input.content, 'utf8')} bytes to ${path}`, writeResult(path, input.content, before));
    },
  };
}
