import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);

export async function main(argv, deps) {
  const fail = (message) => {
    deps.stderr.write(`check-release-tag: ${message}\n`);
    return 1;
  };
  const [tag] = argv;
  if (!tag) return fail('missing tag; usage: node scripts/check-release-tag.js <tag>');

  let version;
  let changelog;
  try {
    version = JSON.parse(await deps.readFile('package.json')).version;
    changelog = await deps.readFile('CHANGELOG.md');
  } catch (err) {
    return fail(err.message);
  }

  if (tag !== `v${version}`) {
    return fail(`tag ${tag} does not match package.json version ${version} (expected v${version})`);
  }
  const heading = `## ${version}`;
  const found = changelog
    .split(/\r?\n/)
    .some((line) => line === heading || line.startsWith(`${heading} `));
  if (!found) return fail(`CHANGELOG.md has no "${heading}" heading`);

  deps.stdout.write(`check-release-tag: ${tag} matches package.json and CHANGELOG.md\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {
    readFile: (name) => readFile(new URL(name, ROOT), 'utf8'),
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
