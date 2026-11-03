import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkInput, describeFsError, fail, ok, oneLine } from './util.js';

function asBytes(text) {
  return Buffer.from(text, 'utf8').toString('latin1');
}

export function createEdit() {
  return {
    name: 'Edit',
    kind: 'write',
    description: 'Replace an exact string in a file (no regex). old_string must occur exactly once unless replace_all is true. Everything else in the file stays byte-identical, line endings included.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path of the file to edit.' },
        old_string: { type: 'string', description: 'Exact text to replace. Must be non-empty.' },
        new_string: { type: 'string', description: 'Replacement text. Must differ from old_string.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    summary: (input) => oneLine(input?.file_path),
    async run(input, ctx) {
      const bad = checkInput(input, ['file_path', 'old_string', 'new_string']);
      if (bad) return bad;
      const path = resolve(ctx.cwd, input.file_path);
      if (input.old_string === '') return fail('old_string is empty');
      if (input.old_string === input.new_string) return fail('old_string and new_string are identical; nothing to change');
      let buf;
      try {
        buf = await readFile(path);
      } catch (err) {
        return fail(describeFsError(err, path));
      }
      const needle = asBytes(input.old_string);
      const parts = buf.toString('latin1').split(needle);
      const count = parts.length - 1;
      if (count === 0) return fail(`old_string not found in ${path}`);
      const replaceAll = input.replace_all === true;
      if (count > 1 && !replaceAll) {
        return fail(`old_string matches ${count} times in ${path}; add surrounding context to make it unique, or set replace_all`);
      }
      const replacement = asBytes(input.new_string);
      const edited = replaceAll ? parts.join(replacement) : parts[0] + replacement + parts.slice(1).join(needle);
      try {
        await writeFile(path, Buffer.from(edited, 'latin1'));
      } catch (err) {
        return fail(`Cannot write ${path}: ${err.message}`);
      }
      return ok(`Edited ${path}: ${count} replacement(s)`);
    },
  };
}
