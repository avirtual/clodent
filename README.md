# clay

clay is a terminal coding agent for Node.js that talks to the Anthropic Messages API directly. This release is the package scaffold: the `clay` binary prints its version and usage, and nothing else is implemented yet.

## Install

Requires Node.js 22 or later. clay has no dependencies.

```sh
npm link
```

## Development

```sh
npm test
```

`npm test` runs `node scripts/run-tests.js`, which discovers every `*.test.js` under `test/` (skipping `node_modules`, `fixtures` and dot-directories) and runs them with `node:test`. Its last stdout line is always exactly:

```
TOTALS: <pass> pass, <fail> fail, <tests> tests
```

`tests` is `pass + fail`; only leaf tests are counted, skipped and todo tests are excluded, and a test file that fails to load counts as one failure. Each failure is printed above it as `FAIL <file>: <test name> — <first line of error>`, followed by `SKIPPED: <n>` when any test was skipped. The script exits 0 when no test failed, including when no tests were found. `--dir <path>` runs the tests under another directory; file paths given as arguments are run instead of discovery; `--reporter=<name>` is accepted and ignored.

Tests use `node:test` and never call the live API.

## Contract

Later releases document every flag, environment variable, hook event, settings key and the cost line format here; this section is the contract a host integrates against.

The only flags today:

- `clay --version` prints `clay <version>` and exits 0.
- `clay --help` prints a usage block and exits 0.

Any other invocation prints `clay: not implemented yet` to stderr and exits 1.
