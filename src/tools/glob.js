import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { listFiles } from './files.js';
import { globToRegExp } from './glob-match.js';
import { checkInput, describeFsError, fail, ok, oneLine } from './util.js';

export const MAX_GLOB_RESULTS = 1000;

function newestFirst(a, b) {
  if (a.mtime !== b.mtime) return b.mtime - a.mtime;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function createGlob(deps = {}) {
  return {
    name: 'Glob',
    kind: 'read',
    description: `Find files whose path relative to path (default the working directory) matches a glob. * and ? never cross /, ** spans directories, {a,b} and [abc] are supported. Inside a git work tree .gitignore is respected, otherwise .git and node_modules are skipped. Returns absolute paths, newest first, at most ${MAX_GLOB_RESULTS}.`,
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob such as **/*.js or src/*.{ts,tsx}.' },
        path: { type: 'string', description: 'Directory to search. Default the working directory.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    summary: (input) => oneLine(input?.pattern),
    async run(input, ctx) {
      const bad = checkInput(input, ['pattern'], ['path']);
      if (bad) return bad;
      const root = resolve(ctx.cwd, input.path ?? '.');
      let info;
      try {
        info = await stat(root);
      } catch (err) {
        return fail(describeFsError(err, root));
      }
      if (!info.isDirectory()) return fail(`${root} is not a directory`);
      let regex;
      try {
        regex = globToRegExp(input.pattern.replace(/^(\.\/)+/, ''));
      } catch (err) {
        return fail(`Invalid glob ${input.pattern}: ${err.message}`);
      }
      const rels = await listFiles(root, { env: ctx.env, signal: ctx.signal, execFile: deps.execFile });
      if (ctx.signal?.aborted) return fail('Search aborted');
      const hits = [];
      for (const rel of rels) {
        if (ctx.signal?.aborted) return fail('Search aborted');
        if (!regex.test(rel)) continue;
        const path = join(root, rel);
        if (await ctx.hidden?.(path)) continue;
        try {
          const found = await stat(path);
          if (found.isFile()) hits.push({ path, mtime: found.mtimeMs });
        } catch {}
      }
      if (hits.length === 0) return ok('No files matched');
      hits.sort(newestFirst);
      const shown = hits.slice(0, MAX_GLOB_RESULTS).map((hit) => hit.path);
      if (hits.length > MAX_GLOB_RESULTS) {
        shown.push(`[clodent: showing the ${MAX_GLOB_RESULTS} newest of ${hits.length} matches; narrow the pattern]`);
      }
      return ok(shown.join('\n'));
    },
  };
}
