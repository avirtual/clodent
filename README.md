# clay

clay is a terminal coding agent for Node.js that talks to the Anthropic Messages API directly. This release runs one prompt in print mode (`clay -p`) with the built-in tools, cost accounting and a JSONL session transcript; the REPL, hooks and settings land in later releases.

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

Tests use `node:test` and never call the API; they use `test/helpers/fake-fetch.js`, which serves the SSE fixtures under `test/fixtures/sse/` as real `Response` objects.

### Live smoke

```sh
ANTHROPIC_API_KEY=sk-ant-... node scripts/live-smoke.js [--model <id>] [--pad <n>]
```

An opt-in check against the real Messages API; the suite only runs it without a key or over the fake fetch, never against the API. It reads the key from `ANTHROPIC_API_KEY` and, without it, prints `live-smoke: ANTHROPIC_API_KEY not set` to stderr and exits 2. With the key it sends one streamed request (model `claude-haiku-5-5` unless `--model` is given, a short system prompt, one trivial tool, the user text `Reply with exactly: pong`), streams the reply text to stdout, then prints `[1] stop_reason: <reason>` and `[1] usage: <raw usage JSON>`. It sends the same request again and prints the same lines prefixed `[2]`, so a cache read shows once the prefix is long enough to be cached. `--pad <n>` appends n filler words to the system prompt (default 0); with a pad, a request 2 whose `cache_read_input_tokens` is not above 0 prints `live-smoke: no cache read on request 2` to stderr and exits 1. `--pad 6000` makes the prefix long enough to cache. It exits 0 when both replies carry text, 1 when either is empty, a request fails (the failure is printed to stderr as `live-smoke: request <n> failed: <status> <type>: <message>`) or the pad check fails, and 2 on an unknown argument or a `--pad` that is not a non-negative integer.

## Contract

Hook events and settings keys are documented here as they land; this section is the contract a host integrates against.

### Flags

| flag | status | meaning |
|---|---|---|
| `-p`, `--print <prompt>` | works | run one prompt without the REPL, print the reply and exit |
| `--model <id>` | works | model id, default `claude-opus-5-5` |
| `--effort <level>` | works | `low`, `medium` or `high` |
| `--budget <usd>` | works | stop before the session spends more than this many US dollars |
| `--yolo` | works | run every tool without asking |
| `--read-only` | works | refuse write tools and every Bash command |
| `--session-id <uuid>` | works | use this session id instead of minting one; see [Sessions](#sessions) |
| `--resume <id>` | works | resume the session with this id |
| `--fork-session` | works | with `--resume`, continue under a new session id in a new transcript |
| `--settings <file>` | parsed; not yet implemented | merge settings from this JSON file; repeatable |
| `--add-dir <path>` | works | give the agent an additional directory; repeatable |
| `--system-prompt <text>` | works | replace the base system prompt with this text |
| `--system-prompt-file <path>` | works | replace the base system prompt with this file |
| `--append-system-prompt <text>` | works | append this text to the system prompt; repeatable |
| `--append-system-prompt-file <path>` | works | append this file's contents to the system prompt; repeatable |
| `-v`, `--version` | works | print `clay <version>` and exit 0 |
| `-h`, `--help` | works | print usage, one line per flag, and exit 0 |

Parsing:

- A value is the next argument, or the text after the first `=` (`--model=x`, `-p=x`). When the next argument is itself a clay flag, such as `--yolo` or `-p`, the value counts as missing; the `=` form passes such text.
- `--settings`, `--add-dir`, `--append-system-prompt` and `--append-system-prompt-file` collect every occurrence in argv order. Any other flag given twice is an error.
- These are errors: an unknown flag, a positional argument (clay takes none), a missing value, a value on a flag that takes none, an `--effort` other than `low`, `medium` or `high`, a `--budget` that is not a decimal number greater than 0, a `--session-id` not shaped as 8-4-4-4-12 hex digits, `--yolo` with `--read-only`, `--fork-session` without `--resume`, `--session-id` with `--resume` but without `--fork-session` (`--session-id with --resume requires --fork-session`), and `--system-prompt` with `--system-prompt-file`.

Exit codes:

- A parse error prints `clay: <error>` and then `clay: see --help` to stderr, and exits 2.
- Once the arguments parse, `--help` wins over every other flag, then `--version`.
- A flag marked parsed; not yet implemented prints `clay: --<flag> is not implemented yet` to stderr, one line per such flag in table order, and exits 2.
- Without `-p`, `clay` prints `clay: not implemented yet` to stderr and exits 1; the REPL lands in a later release.
- With `-p`, see [Print mode](#print-mode).

### Environment

| variable | meaning |
|---|---|
| `ANTHROPIC_API_KEY` | the API key, sent as `x-api-key`; `-p` exits 2 without it |
| `CLAY_HOME` | where clay keeps its data, such as session transcripts; default `~/.clay`; an empty value counts as unset |

### Print mode

`clay -p "<prompt>"` runs one turn of the agent loop: it sends the prompt, runs every tool the model calls, sends the results back, and repeats until the model ends its turn.

stdout gets only the final answer: the text blocks of the turn's last assistant message whose `stop_reason` is not `tool_use`, joined, then a newline. When there is no such message or it has no text, stdout gets nothing; text the model writes alongside a tool call is never printed. Thinking is never printed. stderr gets everything else, one line each:

- `[clay:session] <session-id>` first, before any other line; see [Sessions](#sessions).
- `● <Tool> <summary>` for each tool call; the summary is the call's main input, such as the path or the command.
- `  ✗ <reason>` when a tool call is refused, and `  ✗ <first line of the result>` when a tool returns an error.
- `clay: <message>` for warnings and errors. An API error message is printed verbatim.
- After the turn: `[clay:cost] warning: no price for model <id>; cost not counted` once per unpriced model, then the per-turn `[clay:cost]` line. A budget stop prints the `[clay:budget]` line first.
- On exit: the `[clay:cost] session total` line.

ANSI colour codes are written only to a stream that is a TTY.

Exit codes:

- 0: the model ended its turn (`end_turn` or `stop_sequence`).
- 1: an API error, a budget stop, a refusal, `max_tokens` (warned as `clay: response hit max_tokens`), or any other stop reason (warned as `clay: unexpected stop_reason <reason>`).
- 2: an argument error; an empty prompt (`-p ''` or `-p=`), printed as `clay: -p needs a non-empty prompt`; `ANTHROPIC_API_KEY` unset, printed as `clay: ANTHROPIC_API_KEY is not set`; an unreadable prompt file, printed as `clay: <message>`; or a session error (see [Sessions](#sessions)). No request is sent and no `[clay:session]` line is printed.
- 130: SIGINT. clay aborts the request or the running tool, waits for that tool to return (a Bash process group gets SIGTERM, then SIGKILL 2 s later), prints `clay: interrupted` and the cost lines, and exits.

Permissions in `-p` go by the tool's kind (see [Tools](#tools)). A refused call is not run: the model gets the reason as an error tool result, and the turn goes on.

| mode | read | write | exec (`Bash`) |
|---|---|---|---|
| default | runs | refused: `permission required: rerun with --yolo (interactive approval lands in the REPL)` | refused, same reason |
| `--yolo` | runs | runs | runs |
| `--read-only` | runs | refused: `--read-only: <Tool> is not allowed` | refused: `--read-only: Bash is not allowed` |

### System prompt

Every request carries this system prompt. Its parts, in this order, are separated by blank lines, and an empty part is left out:

1. The base: the `--system-prompt` text, else the contents of `--system-prompt-file`, else clay's own prompt.
2. `# Environment`: the working directory; whether it is a git repository, and its root; the platform; the local date as `YYYY-MM-DD`; the model id; and, when `--add-dir` is given, `Additional directories:` followed by one absolute path per line.
3. `# Instructions (AGENTS.md)`, when any AGENTS.md is found: each file under its own `## <absolute path>` heading.
4. Every `--append-system-prompt` text in argv order, then the contents of every `--append-system-prompt-file` in argv order.

Relative paths given to `--system-prompt-file`, `--append-system-prompt-file` and `--add-dir` resolve against the working directory. A prompt file that is missing or unreadable is an error that names its path.

The date carries no time of day, so the system prompt stays byte-identical all day.

AGENTS.md discovery:

- The git root is the nearest directory, from the working directory upwards, that has a `.git` entry, either a directory or a file (a git worktree has a `.git` file).
- clay reads `AGENTS.md` in every directory from the git root down to the working directory, so the most specific file comes last. Outside a git repository only the working directory's `AGENTS.md` is read.
- Each file is capped at 32 KiB, and all of them together at 96 KiB, counted in bytes. The total is spent from the working directory upwards, so the files nearest the git root are cut first. A cut file ends with the line `[clay: AGENTS.md truncated]`.

### API wire

clay sends every request as `POST https://api.anthropic.com/v1/messages` with exactly these headers:

- `x-api-key: <ANTHROPIC_API_KEY>`
- `anthropic-version: 2026-10-21`
- `content-type: application/json`
- `user-agent: clay/<version>`

No `anthropic-beta` header is sent. The body always has `stream: true`, `thinking: {"type": "adaptive"}` and `max_tokens` 32000 unless overridden; `output_config: {"effort": "low"|"medium"|"high"}` is present only when an effort is set. It carries exactly three `cache_control: {"type": "ephemeral"}` breakpoints: the system block, the last tool definition, and the last content block of the last message, skipping back over trailing `thinking` and `redacted_thinking` blocks. With no tools the tool breakpoint is absent and `tools` is omitted.

Requests that fail before the first SSE event with status 429, 500, 502, 503, 504 or 529, or with a network error, are tried at most 4 times. The waits are 1 s, 2 s and 4 s, each with ±20% jitter, and a `retry-after` header in seconds replaces the wait, capped at 60 s. Any other status is not retried. An `error` event once the stream has started discards the partial response; when its type is `overloaded_error` or `api_error`, clay re-sends the same request at most 2 more times, after 2 s and then 4 s, each announced by a `clay: <message>; retrying in <n> s` warning. Any other `error` event is not retried. The API's error message is surfaced verbatim.

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

`in` is `input_tokens`, `cache-read` is `cache_read_input_tokens`, `cache-write` is all cache-write tokens and `out` is `output_tokens`, summed over the turn's requests, or over the session for the total. The per-turn line prints after every turn, and the session total prints on exit.

`--budget <usd>` is checked before every API request:

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

Grep and Glob list files with `git ls-files --cached --others --exclude-standard` inside a git work tree, so `.gitignore` is respected; elsewhere they walk the directory, skipping `.git` and `node_modules`. A `path` that is itself git-ignored (such as `node_modules/pkg` or `dist`) is walked instead, so its files are listed. A malformed glob is an error, `Invalid glob <glob>: <message>`.

A Bash call returns once bash has exited and its stdout and stderr are closed. A background process that keeps them open (`server &`) holds the call until the timeout, which then ends it with the timed-out trailer even when bash exited 0. A descendant that has left the process group is not killed; 2 s after the SIGTERM clay closes its end of the pipes and returns.

Every tool result is capped at 32768 bytes (UTF-8). A longer result keeps its first 16384 and last 16384 bytes, cut back to whole characters, joined by:

```
\n[clay: truncated <n> bytes]\n
```

where `<n>` is the exact number of bytes removed.

### Events

Internal; serialized by a later stream-json mode. The agent loop reports everything through typed events, each `{type, ...fields}`; the terminal renderer and the session recorder consume them.

| type | fields | emitted |
|---|---|---|
| `session_start` | `model`, `cwd`, `tools` (names), `permission` (`ask`, `yolo` or `read-only`) | once, when the agent is created |
| `request_start` | `attempt` (1-based; a mid-stream re-send counts up) | before each request the loop sends; streamMessage's pre-stream retries are not announced |
| `text_delta` | `text`, `index` (content block index) | as text streams in |
| `thinking_delta` | `text`, `index` | as thinking streams in |
| `assistant_message` | `message` (the assembled API message), `requestId`, `durationMs`, `usd`, `priced` | when a response completes |
| `message_append` | `role`, `content` (the blocks just added to the history), `kind` (`prompt`, `tool_results`, `assistant` or `partial`), `meta` (`message`, `requestId`, `durationMs`, `usd` for `assistant`; `{}` otherwise) | each time blocks join the history; for a response, just before `assistant_message`, even when its content is empty |
| `tool_use` | `id`, `name`, `input`, `summary` | before each tool call, and before the result made up for a call that never ran |
| `permission` | `id`, `name`, `decision` (`allow` or `deny`), `reason` (on deny) | after `tool_use`, for a known tool |
| `tool_result` | `id`, `name`, `content`, `isError`, `durationMs` | after each tool call, including refused, unknown and interrupted calls |
| `turn_end` | `stopReason`, `turn` (the turn's cost aggregate) | last, once per turn |
| `budget_stop` | `result` (the budget check that failed) | instead of a request the budget does not cover |
| `warning` | `message` | |
| `error` | `message`, `errorType`, `status` (HTTP status, or null mid-stream) | when the turn ends on an error |
| `interrupted` | none | when the turn's signal aborts |
| `session_end` | `session` (the session's cost aggregate) | once, on exit |

`stopReason` is the API's `stop_reason` (`end_turn`, `stop_sequence`, `max_tokens`, `refusal`, or another value), or one of `budget`, `interrupted`, `error` and `unknown` (the response carried no `stop_reason`).

When a response that does not stop for `tool_use` still holds `tool_use` blocks, none of them runs: each gets a `tool_use` event and an error result `interrupted by user`, so the next request stays valid.

### Sessions

Every `-p` run records its session as a JSONL transcript, one record per line, at `$CLAY_HOME/projects/<slug>/<session-id>.jsonl` (see [Environment](#environment) for `CLAY_HOME`).

- `<slug>` is the working directory with every `/` and `.` replaced by `-`, and no other character changed: `/Users/a/my.proj/x_y` becomes `-Users-a-my-proj-x_y`.
- Directories are created mode 0700, the file mode 0600. The file appears with the first record.
- Each record is appended with one synchronous write, ending in `\n`, the moment it exists: every record of a request is on disk before the next request is sent, and the turn's last assistant record and `turn_duration` record are on disk when the turn ends.

Session id:

- `[clay:session] <session-id>` is printed at start, once the arguments, the API key and the session check out. In print mode it is the first line on stderr.
- Without `--session-id`, clay mints a random UUID.
- `--session-id <uuid>` uses that id. When its transcript already exists, clay prints `clay: session <id> already exists; use --resume` and exits 2.
- `--resume <id>` looks for `$CLAY_HOME/projects/<slug of cwd>/<id>.jsonl`, then for `$CLAY_HOME/projects/*/<id>.jsonl` in sorted dir order. With no such file, or an id that is not made of letters, digits, `_` and `-`, clay prints `clay: no session <id>` and exits 2. Otherwise it loads the history and appends to that same file under the same id; the first new record's `parentUuid` is the `uuid` of the file's last record.
- `--fork-session` (with `--resume`) records into a new file under a new id: the `--session-id` if given, else a minted one; an existing `--session-id` transcript exits 2 as above. It first copies every record of the source with `sessionId` set to the new id and every other field, `uuid` and `parentUuid` included, unchanged; then it continues. The source file is never written.
- `-p` with `--resume` loads the session, then runs the one prompt.

Loading a transcript:

- User and assistant records that are not `isMeta: true` are replayed in file order into the history, consecutive records of one role joining one message, exactly as the live history merged them. Other record types and meta records are skipped.
- A last line without its `\n` is a write cut short by a crash. clay prints `clay: <path>: ignoring a truncated last line` right after the `[clay:session]` line; when resuming in place, it cuts the file back to its last complete line before appending.
- Any other line that is not a JSON object, or a user or assistant record without a `message.content` array, prints `clay: <path>: line <n> is not valid JSON`, `… is not a record` or `… has no message content` and exits 2.
- When the last user record is the interrupt record, the next prompt goes to the API prefixed with the text block `[clay: previous turn interrupted by the user]`, as it would have in the interrupted run.

Every record carries:

| field | value |
|---|---|
| `type` | `user`, `assistant` or `system` |
| `uuid` | a fresh random UUID (copied records keep theirs) |
| `parentUuid` | the previous record's `uuid`; `null` for the first record of a new file |
| `sessionId` | the session id; the file's basename without `.jsonl` |
| `timestamp` | ISO 8601 in UTC |
| `cwd` | the working directory |
| `isSidechain` | `false` |
| `version` | clay's version |
| `entrypoint` | `clay` |

Record kinds, in the order a turn writes them:

| kind | fields besides the common ones |
|---|---|
| prompt | `type: "user"`, `message: {role: "user", content: [text blocks]}`; after an interrupted turn the content starts with the `[clay: previous turn interrupted by the user]` block |
| assistant | `type: "assistant"`, `message` (the API message: `id`, `model`, `role`, `content`, `stop_reason`, `stop_sequence`, `usage` as the API reported it), `requestId` (the `request-id` response header, or null), `costUsd` (this request's cost; 0 for an unpriced model), `durationMs` (this request's duration in whole milliseconds). A response with empty content is recorded too. |
| tool results | `type: "user"`, `message: {role: "user", content: [tool_result blocks]}`, `toolUseResult: {name, isError}` describing the first block |
| partial assistant | `type: "assistant"`, `message: {role: "assistant", content: [the completed text blocks], stop_reason: null}`; written on an interrupt that kept text |
| interrupt | `type: "user"`, `message: {role: "user", content: [{type: "text", text: "[Request interrupted by user]"}]}`, `isMeta: true` |
| turn end | `type: "system"`, `subtype: "turn_duration"`, `durationMs` (the turn's duration in whole milliseconds), `messageCount` (the turn's user and assistant records, the interrupt record included); after the turn's last record |

A turn the model ended has `stop_reason: "end_turn"` on its last assistant record.
