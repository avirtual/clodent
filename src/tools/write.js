import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { checkInput, fail, ok, oneLine } from './util.js';

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
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, input.content);
      } catch (err) {
        return fail(`Cannot write ${path}: ${err.message}`);
      }
      return ok(`Wrote ${Buffer.byteLength(input.content, 'utf8')} bytes to ${path}`);
    },
  };
}
