import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { listFiles } from './files.js';
import { globToRegExp } from './glob-match.js';
import { checkInput, describeFsError, fail, isBinary, ok, oneLine, positiveInt } from './util.js';

export const DEFAULT_HEAD_LIMIT = 250;
const MODES = ['files_with_matches', 'content', 'count'];

function fileFilter(glob) {
  if (!glob) return () => true;
  const regex = globToRegExp(glob);
  return glob.includes('/') ? (rel) => regex.test(rel) : (rel) => regex.test(basename(rel));
}

function textLines(buf) {
  const lines = buf.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

async function targetFiles(target, keep, ctx, execFile) {
  const info = await stat(target);
  if (!info.isDirectory()) return [target];
  const rels = await listFiles(target, { env: ctx.env, signal: ctx.signal, execFile });
  return rels.filter(keep).map((rel) => join(target, rel)).sort();
}

export function createGrep(deps = {}) {
  return {
    name: 'Grep',
    kind: 'read',
    description: `Search file contents with a JavaScript regular expression. path is a file or directory (default the working directory); inside a git work tree .gitignore is respected, otherwise .git and node_modules are skipped. Binary files are skipped. glob filters files (matched against the file name, or the relative path when it contains /). output_mode: files_with_matches (default; sorted paths), content (path:line:text) or count (path:n). head_limit caps the output lines (default ${DEFAULT_HEAD_LIMIT}).`,
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript RegExp source.' },
        path: { type: 'string', description: 'File or directory to search. Default the working directory.' },
        glob: { type: 'string', description: 'Only search files matching this glob, e.g. *.js or src/**/*.ts.' },
        output_mode: { type: 'string', enum: MODES, description: 'Default files_with_matches.' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive match. Default false.' },
        head_limit: { type: 'integer', minimum: 1, description: `Maximum output lines. Default ${DEFAULT_HEAD_LIMIT}.` },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    summary: (input) => oneLine(input?.pattern),
    async run(input, ctx) {
      const bad = checkInput(input, ['pattern'], ['path', 'glob', 'output_mode']);
      if (bad) return bad;
      const mode = input.output_mode ?? 'files_with_matches';
      if (!MODES.includes(mode)) return fail(`output_mode must be one of ${MODES.join(', ')}`);
      let regex;
      try {
        regex = new RegExp(input.pattern, input.ignore_case === true ? 'i' : '');
      } catch (err) {
        return fail(err.message);
      }
      let keep;
      try {
        keep = fileFilter(input.glob);
      } catch (err) {
        return fail(`Invalid glob ${input.glob}: ${err.message}`);
      }
      const target = resolve(ctx.cwd, input.path ?? '.');
      let files;
      try {
        files = await targetFiles(target, keep, ctx, deps.execFile);
      } catch (err) {
        return fail(describeFsError(err, target));
      }
      if (ctx.signal?.aborted) return fail('Search aborted');
      const out = [];
      for (const file of files) {
        if (ctx.signal?.aborted) return fail('Search aborted');
        let buf;
        try {
          buf = await readFile(file);
        } catch {
          continue;
        }
        if (isBinary(buf)) continue;
        const lines = textLines(buf);
        if (mode === 'files_with_matches') {
          if (lines.some((line) => regex.test(line))) out.push(file);
        } else if (mode === 'count') {
          const n = lines.filter((line) => regex.test(line)).length;
          if (n > 0) out.push(`${file}:${n}`);
        } else {
          lines.forEach((line, i) => {
            if (regex.test(line)) out.push(`${file}:${i + 1}:${line}`);
          });
        }
      }
      if (out.length === 0) return ok('No matches found');
      const limit = positiveInt(input.head_limit, DEFAULT_HEAD_LIMIT);
      if (out.length <= limit) return ok(out.join('\n'));
      const note = `[clay: showing the first ${limit} of ${out.length} lines; raise head_limit to see more]`;
      return ok([...out.slice(0, limit), note].join('\n'));
    },
  };
}
