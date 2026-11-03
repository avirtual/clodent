import { readFileSync } from 'node:fs';

const USAGE = `usage: clay [options]

options:
  --version  print the version and exit
  --help     print this help and exit
`;

function version() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

export async function main(argv, deps) {
  const [arg] = argv;
  if (argv.length === 1 && arg === '--version') {
    deps.stdout.write(`clay ${version()}\n`);
    return 0;
  }
  if (argv.length === 1 && arg === '--help') {
    deps.stdout.write(USAGE);
    return 0;
  }
  deps.stderr.write('clay: not implemented yet\n');
  return 1;
}
