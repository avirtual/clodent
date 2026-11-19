import { createBash } from './bash.js';
import { createEdit } from './edit.js';
import { createGlob } from './glob.js';
import { createGrep } from './grep.js';
import { createRead } from './read.js';
import { fail } from './util.js';
import { createWebFetch, createWebSearch } from './web.js';
import { createWrite } from './write.js';

function guarded(tool) {
  return {
    ...tool,
    async run(input, ctx) {
      try {
        return await tool.run(input, ctx);
      } catch (err) {
        return fail(`${tool.name} failed: ${err?.message ?? err}`);
      }
    },
  };
}

export function createTools(deps = {}) {
  return [
    createRead(deps),
    createWrite(deps),
    createEdit(deps),
    createBash(deps),
    createGrep(deps),
    createGlob(deps),
    createWebSearch(deps),
    createWebFetch(deps),
  ].map(guarded);
}

export function listTools() {
  return createTools().map(({ name, kind, description, input_schema }) => ({ name, kind, description, input_schema }));
}
