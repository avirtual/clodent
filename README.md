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

`npm test` runs `node scripts/run-tests.js`, which discovers every `*.test.js` under `test/` (skipping `node_modules`, `fixtures` and dot-directories) and runs them with `node:test`. After a run, its last stdout line is exactly:

```
TOTALS: <pass> pass, <fail> fail, <tests> tests
```

`tests` is `pass + fail`. Only leaf tests are counted: a `describe` block or a test with subtests is not a test, but when it fails with no failing test beneath it (a broken hook, a `describe` that throws) it counts as one failure. Skipped and todo tests are excluded, a test file that registers no tests counts as nothing, and a test file that fails to load counts as one failure. Each failure is printed above it as `FAIL <file>: <test name> — <first line of error>`, followed by `SKIPPED: <n>` when any test or `describe` block was skipped. The script exits 0 when no test failed, including when no tests were found. `--dir <path>` runs the tests under another directory, which must exist; file paths given as arguments are run instead of discovery; `--reporter=<name>` is accepted and ignored.

Tests use `node:test` and never call the live API.

## Contract

Later releases document every flag, environment variable, hook event and settings key here; this section is the contract a host integrates against.

The only flags today:

- `clay --version` prints `clay <version>` and exits 0.
- `clay --help` prints a usage block and exits 0.

Any other invocation prints `clay: not implemented yet` to stderr and exits 1.

### Cost

clay prices each Messages API response from its `usage` object, against a table keyed by the exact model id. Ids never match by prefix: `claude-opus-5-5-preview` has no price. Rates are USD per million tokens:

| model | input | output | cache read | cache write 5m | cache write 1h |
|---|---|---|---|---|---|
| `claude-opus-5-5` | 4.00 | 20.00 | 0.20 | 5.00 | 8.00 |
| `claude-sonnet-5-5` | 2.00 | 10.00 | 0.10 | 2.50 | 4.00 |
| `claude-haiku-5-5` | 0.10 | 0.50 | 0.01 | 0.125 | 0.20 |
| `claude-fable-5-1` | 10.00 | 50.00 | 0.25 | 12.50 | 20.00 |

Source: wirescope's table (proxy-lab `proxylab/billing.py` `PRICES` at ee3917a, v0.6.85), taken from platform.claude.com pricing read 2026-09/10.

- Prompt tokens are `input_tokens + cache_read_input_tokens` plus the cache-write tokens. When a `claude-haiku-5-5` request has more than 100,000 prompt tokens, the whole request, output included, is priced at input 0.50, output 2.50, cache read 0.05, cache write 5m 0.625, cache write 1h 1.00.
- `usage.cache_creation.ephemeral_1h_input_tokens` are priced at the 1h rate. Every other cache-write token is priced at the 5m rate, including all of `cache_creation_input_tokens` when the `cache_creation` breakdown is absent.
- A missing or null usage field counts as 0. Sums are kept in integer nano-dollars, so they do not drift.
- A request for a model with no price still counts its tokens, but adds $0.

Line formats. Each is one line. Amounts have exactly four decimals, rounded half up, and counts are plain integers with no separators:

```
[clay:cost] $X.XXXX (in N, cache-read N, cache-write N, out N)
[clay:cost] session total $X.XXXX (in N, cache-read N, cache-write N, out N, requests N)
[clay:cost] warning: no price for model <id>; cost not counted
[clay:budget] stopped: spent $X.XXXX, next request est. $X.XXXX, budget $X.XXXX
[clay:budget] stopped: model <id> has no price; --budget needs a priced model
```

`in` is `input_tokens`, `cache-read` is `cache_read_input_tokens`, `cache-write` is all cache-write tokens and `out` is `output_tokens`, summed over the turn's requests, or over the session for the total. The per-turn line prints after every turn, and the session total prints on exit. The printing is wired in a later release, with the agent loop.

`--budget <usd>` (flag wired in a later release) is checked before every API request:

- The estimate for the next request is the cost of the previous request, or 0 before the first.
- clay stops with the `spent` line when the session total spent plus that estimate exceeds the budget. A projected total exactly equal to the budget proceeds.
- When any request in the session was for a model with no price, clay stops with the `has no price` line, naming the first such model. A budget is never run unmetered.

### Tools

clay gives the model six built-in tools, in this order. `kind` decides how permissions treat a tool. Input names follow the common agent-tool convention, so a hook reading `tool_input` sees the same fields. Relative paths resolve against the working directory, and every path in a result is absolute.

| Tool | Kind | Inputs | Result |
|---|---|---|---|
| `Read` | read | `file_path`; `offset` (1-based line, default 1); `limit` (lines, default 2000) | `cat -n` style: the line number right-aligned in 6 columns, a tab, the line. Lines over 2000 chars are cut and end in `…`. An empty file returns `<path> is empty (0 bytes)`. Errors: missing file, a directory or other non-regular file, a binary file (NUL in the first 8 KiB), an offset past the end. |
| `Write` | write | `file_path`; `content` | Creates parent directories and overwrites. `Wrote <n> bytes to <path>`. |
| `Edit` | write | `file_path`; `old_string`; `new_string`; `replace_all` (default false) | Exact string replacement, no regex; the rest of the file stays byte-identical. `Edited <path>: <n> replacement(s)`. Errors: missing file, empty `old_string`, `old_string` equal to `new_string`, no match, more than one match without `replace_all` (the message gives the count). |
| `Bash` | exec | `command`; `timeout` (ms, default 120000, clamped to 600000); `description` (ignored) | Runs `bash -c <command>` in its own process group with stdin closed; stdout and stderr interleaved in arrival order, then a trailer line `[exit <code>]`, `[timed out after <ms> ms]` or `[killed by <signal>]`. A timeout or interrupt sends SIGTERM to the group, then SIGKILL 2 s later. An error unless the exit code is 0. |
| `Grep` | read | `pattern` (JavaScript RegExp source); `path` (file or directory, default cwd); `glob`; `output_mode` (`files_with_matches` default, `content`, `count`); `ignore_case` (default false); `head_limit` (output lines, default 250) | `files_with_matches`: sorted paths. `content`: `<path>:<line>:<text>`. `count`: `<path>:<n>`. A `glob` without `/` matches the file name, with `/` the path relative to `path`. Binary files are skipped. No match: `No matches found` (not an error). An invalid pattern is an error carrying the SyntaxError message. Cut output ends with `[clay: showing the first <limit> of <n> lines; raise head_limit to see more]`. |
| `Glob` | read | `pattern`; `path` (directory, default cwd) | Paths whose path relative to `path` matches: `*` and `?` never cross `/`, `**` spans directories, `{a,b}` and `[abc]` / `[!abc]` are supported. Newest mtime first, at most 1000, followed by `[clay: showing the 1000 newest of <n> matches; narrow the pattern]` when cut. No match: `No files matched` (not an error). |

Grep and Glob list files with `git ls-files --cached --others --exclude-standard` inside a git work tree, so `.gitignore` is respected; elsewhere they walk the directory, skipping `.git` and `node_modules`. A `path` that is itself ignored inside a work tree (such as `node_modules/pkg`) lists no files. A malformed glob is an error, `Invalid glob <glob>: <message>`.

A Bash call returns once bash has exited and its stdout and stderr are closed. A background process that keeps them open (`server &`) holds the call until the timeout, which then ends it with the timed-out trailer even when bash exited 0. A descendant that has left the process group is not killed; 2 s after the SIGTERM clay closes its end of the pipes and returns.

Every tool result is capped at 32768 bytes (UTF-8). A longer result keeps its first 16384 and last 16384 bytes, cut back to whole characters, joined by:

```
\n[clay: truncated <n> bytes]\n
```

where `<n>` is the exact number of bytes removed.
