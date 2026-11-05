# clodent

clodent is a terminal coding agent for Node.js that talks to the Anthropic Messages API directly. Version 0.5.1 has an interactive REPL built to be driven through a PTY, a print mode (`clodent -p`), a stream-json mode for hosts, six built-in tools, cost accounting, JSONL session transcripts, settings files, hooks and post-compact file reload. clodent was named clay up to 0.2.0.

Non-goals for v0.5: MCP, plugins, skills, subagents, web tools, image input, Windows, telemetry.

## Install

Requires Node.js 22 or later. clodent has no dependencies. From a checkout:

```sh
npm link
clodent --version   # clodent 0.5.1
```

## Usage

```sh
export ANTHROPIC_API_KEY=sk-ant-...
clodent -p "List the files in this directory"   # one prompt, answer on stdout
clodent                                         # the REPL
clodent --resume <session-id>                   # continue a session in the REPL
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

### Cloud review

```sh
scripts/cloud-review.sh v0.4.0 v0.5.0      # review a tag range
scripts/pre-release-review.sh              # review origin/master's Unreleased section before tagging
```

Both launch a detached `claude --cloud` session (opus, `scripts/cloud-review-brief.md` is its brief) on the account `claude` is logged into, and a poller (`scripts/cloud-review-post.sh`) that turns its report into one GitHub issue: `Release review <tag>: CLEAN` (opened and closed) or `: <finding>` (left open); `NO REPORT` when nothing lands within two hours. The session pushes its report to `claude/review-<tag>`; logs go to `~/.clodent/logs/`. Needs `gh` authenticated and `script(1)`; set `CLODENT_RELEASE_NO_REVIEW=1` to skip.

### Live smoke

```sh
ANTHROPIC_API_KEY=sk-ant-... node scripts/live-smoke.js [--model <id>] [--pad <n>]
```

An opt-in check against the real Messages API; the suite only runs it without a key or over the fake fetch, never against the API. It reads the key from `ANTHROPIC_API_KEY` and, without it, prints `live-smoke: ANTHROPIC_API_KEY not set` to stderr and exits 2. With the key it sends one streamed request (model `claude-haiku-5-5` unless `--model` is given, a short system prompt, one trivial tool, the user text `Reply with exactly: pong`), streams the reply text to stdout, then prints `[1] stop_reason: <reason>` and `[1] usage: <raw usage JSON>`. It sends the same request again and prints the same lines prefixed `[2]`, so a cache read shows once the prefix is long enough to be cached. `--pad <n>` appends n filler words to the system prompt (default 0); with a pad, a request 2 whose `cache_read_input_tokens` is not above 0 prints `live-smoke: no cache read on request 2` to stderr and exits 1. `--pad 6000` makes the prefix long enough to cache. It exits 0 when both replies carry text, 1 when either is empty, a request fails (the failure is printed to stderr as `live-smoke: request <n> failed: <status> <type>: <message>`) or the pad check fails, and 2 on an unknown argument or a `--pad` that is not a non-negative integer.

## Contract

This section is the contract a host integrates against. It describes clodent 0.5.1.

### Hosting clodent

A summary for a host adapter; each point links to the section that pins it down.

- Launch: `clodent` without `-p`, in a PTY, in the seat's working directory. Pass `--session-id <uuid>` for a new session, or `--resume <id>`, with `--fork-session` to continue under a new id (the `--session-id` if given). Add `--settings <file>` for the host's hooks and statusLine, one `--add-dir <path>` per extra directory, `--system-prompt-file <path>` and `--append-system-prompt-file <path>` for the prompt, `--model <id>` (one trailing `[…]` suffix such as `[1m]` is dropped), `--effort low|medium|high|xhigh|max`, and a permission mode: `--dangerously-skip-permissions` or `--yolo`, `--permission-mode default|plan|acceptEdits|bypassPermissions`, or `--read-only` (default: ask). Permission flags that name different modes exit 2. `--disallowedTools <list>` (or `--disallowed-tools`) adds deny rules. See [Flags](#flags) and [System prompt](#system-prompt).
- Stream seats: `clodent -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio` with the same flags as Launch. stdin takes one JSON message per line and stdout writes one JSON record per line: `system/init` first (again after each successful `/clear`), then each turn's records ending in exactly one `result`, and one `result` per empty prompt and per slash command but `/quit` and `/exit`; a prompt that joins a running turn gets none. Permission asks arrive as `control_request` `can_use_tool`. See [Stream JSON](#stream-json).
- Accepted and ignored: `--plugin-dir <dir>`, `--agents <json>`, `--mcp-config <path>`, `--strict-mcp-config`, `--allowedTools <list>` (or `--allowed-tools`) and `--dangerously-bypass-hook-trust`. Each one given prints `clodent: ignoring --<name>: not supported` once on stderr and changes nothing. See [Flags](#flags).
- Env: `ANTHROPIC_API_KEY` (required), `CLODENT_HOME` as the per-account config dir (`settings.json` and `projects/`; default `~/.clodent`), and optionally `ANTHROPIC_BASE_URL` to send requests to another origin, such as a proxy. See [Environment](#environment).
- Cache TTL: settings `cacheTtl: "1h"` (or `--cache-ttl 1h`) caches the system block, the last tool and the settled pin for an hour while the tail stays 5 minutes, which pays off for seats that idle between turns. The default `5m` suits short-lived seats. See [API wire](#api-wire).
- Transcript: `$CLODENT_HOME/projects/<slug>/<session-id>.jsonl`, where `<slug>` is the working directory with every `/` and `.` replaced by `-`. `SessionStart` hooks get the path as `transcript_path`. See [Sessions](#sessions).
- Boot-ready: the first `\x1b[?2004h` on stdout. It follows the `[clodent:session] <id>` line and the `SessionStart` hook. A startup error exits 2 before it. See [REPL](#repl).
- Inject: write `\x1b[200~<text>\x1b[201~`, then `\r`. The paste is one prompt with its newlines kept, and the `\r` submits it. A prompt submitted during a turn is queued. See [REPL](#repl).
- Idle: a turn the model ended writes an assistant record with `message.stop_reason` `end_turn`. Every turn, including an interrupted or failed one, then writes a `system` record with `subtype: "turn_duration"` and fires `Stop`; the REPL then shows the next prompt unless it is exiting. See [Sessions](#sessions).
- Context delivery: `hookSpecificOutput.additionalContext` from `SessionStart` (held for the next prompt), `UserPromptSubmit` (after the prompt text), and `PostToolUse` or `PostToolUseFailure` (after the tool results). See [Hooks](#hooks).
- Permission ask (default and `acceptEdits` modes only): clodent prints `[clodent:permit <Tool> <tool_use id>] <summary>` and `Allow? [y/n] `, then fires `Notification` with `notification_type: "permission_prompt"`, `title: "Permission needed"`, `message: "clodent needs your permission to use <Tool>"`, `tool` and `id` while the ask is listening. Answer once, by writing `y` or `n` then `\r`, as soon as you see the permit line or the Notification. A second answer arrives while the turn is busy and is queued as a prompt. See [REPL](#repl).
- `/compact`: fires `PreCompact` (`trigger: "manual"`), replaces the history with a summary plus up to `compactReloadFiles` (default 5) files the summary names (or the last files touched when the summary names none), re-read from disk, under the same session id, writes the `compact_boundary` and `isCompactSummary` records, and fires `SessionStart` with `source: "compact"`. `/clear`: prints a new `[clodent:session] <id>`, records into a new transcript, and fires `SessionStart` with `source: "clear"`. Type either as plain text, then `\r`; a pasted `/compact` is a prompt. Like every slash command, neither writes a `turn_duration` record or fires `Stop`: its end is the next `\x1b[?2004h`. See [REPL](#repl).
- statusLine: the settings `statusLine` command gets `context_window.used_tokens`, `context_window.context_window_size`, `context_window.used_percentage`, `model.id` and `cost.total_cost_usd` on stdin after each API response, after `/clear` (zero usage) and after `/compact` (`used_tokens` is the summary's size). See [Hooks](#hooks).
- Signals: SIGINT acts as Ctrl-C: it interrupts a turn, and two in a row at an empty prompt exit 0. SIGTERM exits 143 and SIGHUP 129, after interrupting a running turn, whose `Stop` hook still fires. Ctrl-D, `/quit` and stdin closing exit 0. See [REPL](#repl).
- Settings guard: `permissions.deny`/`ask` are enforced (see [Permission rules](#permission-rules)). A `sandbox` block with `enabled: true` is never fatal: its `filesystem.denyRead`, `filesystem.denyWrite` and deny `credentials.files` entries are enforced as deny rules, its deny `credentials.envVars` are removed from the Bash tool's environment, and its other keys are ignored with one warning; clodent does not sandbox Bash. A malformed sandbox shape is a startup error (exit 2). clodent also always denies Read and Edit of every settings file it loaded and Read of `/proc/*/environ`, and the Bash tool's environment never contains `ANTHROPIC_API_KEY`.
- Absent in 0.5.1: MCP and subagents, so hooks never get `agent_id`.

### Flags

| flag | status | meaning |
|---|---|---|
| `-p`, `--print <prompt>` | works | run one prompt without the REPL, print the reply and exit; with `--input-format stream-json`, read prompts from stdin instead (see [Stream JSON](#stream-json)); without `-p`, clodent starts the [REPL](#repl) |
| `--input-format <format>` | works | with `-p`: `text` (default: the `-p` prompt) or `stream-json` (JSON lines on stdin); see [Stream JSON](#stream-json) |
| `--output-format <format>` | works | with `-p`: `text` (default: the final answer) or `stream-json` (JSON lines on stdout); see [Stream JSON](#stream-json) |
| `--verbose` | works | accepted; no effect |
| `--permission-prompt-tool <name>` | works | `stdio`, the only value, with `--input-format stream-json`: permission asks go over stdout and stdin; see [Stream JSON](#stream-json) |
| `--model <id>` | works | model id; default the settings `model`, else `claude-opus-5-5`. One trailing bracketed suffix is dropped before any use (`claude-haiku-5-5[1m]` is `claude-haiku-5-5`), as it is from the settings `model` and `/model <id>` |
| `--effort <level>` | works | `low`, `medium`, `high`, `xhigh` or `max`, sent as is; default the settings `effortLevel`, else none |
| `--cache-ttl <ttl>` | works | prompt-cache lifetime, `5m` or `1h`; default the settings `cacheTtl`, else `5m`. With `1h` the system block, the last tool and the settled pin are cached for an hour and the tail for 5 minutes; see [API wire](#api-wire). Fixed for the process, across `/clear`, `/compact` and `/model`. Any other value exits 2 |
| `--budget <usd>` | works | stop before the session spends more than this many US dollars |
| `--yolo` | works | run every tool without asking |
| `--read-only` | works | refuse write tools and any Bash command that is not read-only (see [Read-only Bash](#read-only-bash)) |
| `--dangerously-skip-permissions` | works | same as `--yolo` |
| `--permission-mode <mode>` | works | `default` (ask, as with no permission flag), `plan` (as `--read-only`), `acceptEdits` (run read-only Bash commands without asking, and write tools only inside the working directory and the `--add-dir`/`trustedDirectories`/`additionalDirectories` dirs; ask for any other Bash command, for a `Write` or `Edit` outside those dirs or under a `.git`, `.clodent` or `.claude` directory, and for a file a hook or statusLine command names; see [Print mode](#print-mode)) or `bypassPermissions` (as `--yolo`) |
| `--disallowedTools <list>`, `--disallowed-tools <list>` | works | deny rules, see below; repeatable |
| `--session-id <uuid>` | works | use this session id instead of minting one; see [Sessions](#sessions) |
| `--resume <id>` | works | resume the session with this id |
| `--fork-session` | works | with `--resume`, continue under a new session id in a new transcript |
| `--settings <file>` | works | merge settings from this JSON file; repeatable; see [Settings](#settings) |
| `--add-dir <path>` | works | give the agent an additional directory; repeatable |
| `--system-prompt <text>` | works | replace the base system prompt with this text |
| `--system-prompt-file <path>` | works | replace the base system prompt with this file |
| `--append-system-prompt <text>` | works | append this text to the system prompt; repeatable |
| `--append-system-prompt-file <path>` | works | append this file's contents to the system prompt; repeatable |
| `--allowedTools <list>`, `--allowed-tools <list>` | ignored | accepted and ignored; repeatable |
| `--plugin-dir <dir>` | ignored | accepted and ignored; repeatable |
| `--agents <json>` | ignored | accepted and ignored |
| `--mcp-config <path>` | ignored | accepted and ignored; repeatable, one path each |
| `--strict-mcp-config` | ignored | accepted and ignored |
| `--dangerously-bypass-hook-trust` | ignored | accepted and ignored |
| `-v`, `--version` | works | print `clodent <version>` and exit 0 |
| `-h`, `--help` | works | print usage, one line per flag, and exit 0 |

Parsing:

- A value is the next argument, or the text after the first `=` (`--model=x`, `-p=x`). When the next argument is itself a clodent flag, such as `--yolo` or `-p`, the value counts as missing; the `=` form passes such text. The exception is `-p`: followed by a clodent flag it takes an empty prompt (`-p --input-format stream-json`), and only `-p` as the last argument counts as missing.
- `--settings`, `--add-dir`, `--append-system-prompt`, `--append-system-prompt-file`, `--disallowedTools`, `--allowedTools`, `--plugin-dir` and `--mcp-config` collect every occurrence in argv order; the two spellings of `--disallowedTools` and of `--allowedTools` count as one flag. Any other flag given twice is an error.
- An empty value (`--model ''` or `--model=`) counts as missing, except for `-p`, `--system-prompt` and `--append-system-prompt`, which take it. An empty `--system-prompt` leaves the base part out, and an empty `--append-system-prompt` adds nothing.
- These are errors: an unknown flag, a positional argument (clodent takes none), a missing value, a value on a flag that takes none, an `--effort` other than `low`, `medium`, `high`, `xhigh` or `max`, a `--permission-mode` other than `default`, `plan`, `acceptEdits` or `bypassPermissions`, a `--budget` that is not a decimal number greater than 0, a `--session-id` not shaped as 8-4-4-4-12 hex digits, two of `--yolo`, `--read-only`, `--dangerously-skip-permissions` and `--permission-mode` that name different modes (`--<a> and --<b> cannot be combined`, in table order; flags that name the same mode combine), `--fork-session` without `--resume`, `--session-id` with `--resume` but without `--fork-session` (`--session-id with --resume requires --fork-session`), `--system-prompt` with `--system-prompt-file`, an `--input-format` or `--output-format` other than `text` or `stream-json`, a `--permission-prompt-tool` other than `stdio`, and the format combinations [Stream JSON](#stream-json) lists.

`--disallowedTools <list>`: each value is split at commas and whitespace outside parentheses, and each entry is a deny rule parsed exactly as a settings `permissions.deny` entry (see [Permission rules](#permission-rules)), so `Bash`, `Bash(git push:*)` and `Read(~/x)` all work and other tool names are ignored silently; a `/p` path is relative to the working directory. These rules follow the settings deny rules. A malformed entry prints `clodent: --disallowedTools: "<entry>": <reason>` and exits 2, before the `[clodent:session]` line, any hook and any request.

The ignored flags take their value, if they have one, and change nothing. Each one given prints `clodent: ignoring --<name>: not supported` once per run, `<name>` spelled as in the table's first column, on stderr: in `-p` right after the `[clodent:session]` line, in the REPL before it.

Exit codes:

- A parse error prints `clodent: <error>` and then `clodent: see --help` to stderr, and exits 2.
- Once the arguments parse, `--help` wins over every other flag, then `--version`.
- Without `-p`, see [REPL](#repl).
- With `-p`, see [Print mode](#print-mode).

### Environment

| variable | meaning |
|---|---|
| `ANTHROPIC_API_KEY` | the API key, sent as `x-api-key`; clodent exits 2 without it |
| `ANTHROPIC_BASE_URL` | replaces the API origin: requests go to `<value without trailing slashes>/v1/messages`; must be an `http:` or `https:` URL, else clodent prints `clodent: invalid ANTHROPIC_BASE_URL` and exits 2; a URL with a user name or password (`https://user:pass@host`) makes clodent print `clodent: ANTHROPIC_BASE_URL: credentials in the URL are not supported` and exit 2; an empty value counts as unset |
| `CLODENT_HOME` | where clodent keeps its data, such as `settings.json` and session transcripts; default `~/.clodent`; an empty value counts as unset |

The settings `env` (see [Settings](#settings)) is laid over the process environment, and that one environment is what clodent reads `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` from and what tools, hooks and the statusLine command run in, less `ANTHROPIC_API_KEY` and the settings sandbox `credentials.envVars` names for the Bash tool, Grep and Glob's git calls, hooks and the statusLine command (see [Permission rules](#permission-rules) and [Hooks](#hooks)). `CLODENT_HOME` alone is read from the process environment, since it locates `settings.json`.

### Print mode

`clodent -p "<prompt>"` runs one turn of the agent loop: it sends the prompt, runs every tool the model calls, sends the results back, and repeats until the model ends its turn.

With `--output-format stream-json`, stdout gets JSON lines instead, and the lines below go to stderr uncoloured; see [Stream JSON](#stream-json).

stdout gets only the final answer: the text blocks of the turn's last assistant message whose `stop_reason` is not `tool_use`, joined, then a newline. When there is no such message or it has no text, stdout gets nothing; text the model writes alongside a tool call is never printed. Thinking is never printed. stderr gets everything else, one line each:

- `[clodent:session] <session-id>` first, before any other line; see [Sessions](#sessions).
- `clodent: ignoring --<name>: not supported` once for each ignored flag given (see [Flags](#flags)), then `clodent: settings <path>: <what was dropped>` for each settings warning.
- `● <Tool> <summary>` for each tool call; the summary is the call's main input: `file_path` for Read, Write and Edit, `command` for Bash, `pattern` for Grep and Glob. It is one line, with each line break shown as `⏎`, and is cut to 200 characters ending in `…`. With an empty summary the line is `● <Tool>`.
- `  ✗ <reason>` when a tool call is refused, and `  ✗ <first line of the result>` when a tool returns an error.
- `clodent: <message>` for warnings and errors, hook warnings included. An API error message is printed as the API sent it, except that each control byte in it, a line break included, is written as `\u` and four lowercase hex digits, as in the REPL (see [REPL](#repl)).
- After the turn: `[clodent:cost] warning: no price for model <id>; cost not counted` once per unpriced model, then the per-turn `[clodent:cost]` line. A budget stop prints the `[clodent:budget]` line first.
- On exit: the `[clodent:cost] session total` line.

ANSI colour codes are written only to a stream that is a TTY.

Exit codes:

- 0: the model ended its turn (`end_turn` or `stop_sequence`). A `pause_turn` response is sent back for the model to continue.
- 1: an API error, a budget stop, a refusal, `max_tokens` (warned as `clodent: response hit max_tokens`), or any other stop reason (warned as `clodent: unexpected stop_reason <reason>`).
- 2: an argument error; a settings file error, printed as `clodent: <message>` (see [Settings](#settings)); an empty prompt (`-p ''`, `-p=`, or `-p` followed by another flag, without `--input-format stream-json`), printed as `clodent: -p needs a non-empty prompt`; `ANTHROPIC_API_KEY` unset, printed as `clodent: ANTHROPIC_API_KEY is not set`; an invalid `ANTHROPIC_BASE_URL`, printed as `clodent: invalid ANTHROPIC_BASE_URL`, or one with credentials, printed as `clodent: ANTHROPIC_BASE_URL: credentials in the URL are not supported`; an unreadable prompt file, printed as `clodent: <message>`; a malformed `--disallowedTools` entry (see [Flags](#flags)); or a session error (see [Sessions](#sessions)). Settings warnings print first, as `clodent: <warning>` lines. No request is sent and no `[clodent:session]` line is printed.
- 130: SIGINT; 143: SIGTERM; 129: SIGHUP. clodent aborts the request, the running tool or the running hooks, waits for them to return (each process group gets SIGTERM, then SIGKILL 2 s later), prints `clodent: interrupted` and the turn's cost line, fires `Stop` (a second signal kills it), prints the session total, waits for the statusLine command, sends any pending SIGKILL (see [Tools](#tools)), and exits. The transcript ends with the interrupt and `turn_duration` records, so `--resume` continues it.

Permissions in `-p` go by the tool's kind (see [Tools](#tools)), and for `Bash` by the command (see [Read-only Bash](#read-only-bash)). A refused call is not run: the model gets the reason as an error tool result, and the turn goes on.

| mode | read | write | exec (`Bash`) |
|---|---|---|---|
| default, `--permission-mode default` | runs | refused: `permission required: run clodent without -p to approve it, or pass --yolo` | a read-only command runs; any other is refused, same reason |
| `--permission-mode acceptEdits` | runs | runs inside the working directory and the `--add-dir`/`trustedDirectories`/`additionalDirectories` dirs, except under a `.git`, `.clodent` or `.claude` directory or to a file a hook or statusLine command names (see [Read-only Bash](#read-only-bash)); any other `Write` or `Edit` is refused: `permission required: run clodent without -p to approve it, or pass --yolo` | a read-only command runs; any other is refused, same reason |
| `--yolo`, `--dangerously-skip-permissions`, `--permission-mode bypassPermissions` | runs | runs | runs |
| `--read-only`, `--permission-mode plan` | runs | refused: `--read-only: <Tool> is not allowed` | a read-only command runs; any other is refused: `--read-only: Bash command is not read-only (<reason>)` |

A `PreToolUse` hook can refuse any call or let a call run in the default or `acceptEdits` mode; see [Hooks](#hooks) for the order. A call a settings deny rule matches is refused in every mode, and one an ask rule matches or a `PreToolUse` hook asks about is refused unless the mode is `--yolo`'s; see [Permission rules](#permission-rules).

### Stream JSON

`clodent -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio` speaks the JSON-lines protocol of Clodex's Claude stream codec: prompts, permission replies and control requests arrive on stdin, and stdout carries one JSON object per line. `clodent -p "<prompt>" --output-format stream-json` (text input) runs that one prompt, writes the same output lines, and exits as [Print mode](#print-mode) does.

Flags:

- `--input-format` and `--output-format` take `text` (the default) or `stream-json`; any other value prints `--input-format must be text or stream-json, got "<value>"` (or `--output-format …`).
- `--verbose` is accepted and has no effect.
- `--permission-prompt-tool` takes only `stdio` (else `--permission-prompt-tool must be stdio, got "<value>"`).
- `-p` directly followed by another clodent flag takes an empty prompt, so Clodex's `-p --input-format stream-json …` parses; `-p ''` works too.
- These are argument errors (exit 2): a `stream-json` format without `-p` (`--input-format stream-json requires -p`, or `--output-format …`), `--input-format stream-json` without `--output-format stream-json` (`--input-format stream-json requires --output-format stream-json`), `--input-format stream-json` with a non-empty `-p` prompt (`--input-format stream-json reads prompts from stdin: give -p no prompt`), and `--permission-prompt-tool` without `--input-format stream-json` (`--permission-prompt-tool requires --input-format stream-json`).
- Every other flag works as without them.

stdout holds JSON lines only. stderr gets the [Print mode](#print-mode) lines, never coloured: `[clodent:session] <id>` first, the ignored-flag and settings warnings, `● <Tool> <summary>`, `[clodent:permit <Tool> <tool_use id>] <summary>` and `  ✗ <reason>` lines, `clodent: <message>` warnings and errors (the stdin warnings below included), `clodent: interrupted`, the `[clodent:budget]` line, each turn's `[clodent:cost]` line, and the session total on exit.

Output lines. Every `session_id` is the session's id, as on the `[clodent:session]` line, or after a `/clear` the new id (see Slash commands below), and every `uuid` is a fresh v4 UUID.

| line | fields | when |
|---|---|---|
| `{"type":"system","subtype":"init",…}` | `cwd`, `session_id`, `model` (the id with any `[…]` suffix dropped), `tools` (the names of the tools sent to the API), `permissionMode` (`default`, `acceptEdits`, `plan` or `bypassPermissions`), `slash_commands` (`["compact","clear","cost","model","help","quit","exit"]`), `apiKeySource` (`"ANTHROPIC_API_KEY"`), `clodent_version`, `uuid` | once, after the `SessionStart` hooks and before stdin is read; again after each successful `/clear`, with the new `session_id` |
| `{"type":"assistant",…}` | `message` (`id`, `type: "message"`, `role: "assistant"`, `model`, `content` with its text, thinking (signature kept) and tool_use blocks, `stop_reason`, `stop_sequence` and `usage`, as the API sent them), `parent_tool_use_id: null`, `session_id`, `uuid` | once per API response. An interrupt during a response writes one for the text blocks it completed, if any, with `message` `{"role":"assistant","content":[…],"stop_reason":null}` |
| `{"type":"user",…}` | `message` (`role: "user"`, `content`: the `tool_result` blocks `{type, tool_use_id, content, is_error}`, then any hook context block and folded prompt text blocks), `parent_tool_use_id: null`, `session_id`, `uuid` | once per tool-results message. An interrupt writes one with `content` `[{"type":"text","text":"[Request interrupted by user]"}]` |
| `{"type":"control_request",…}` | `request_id` (a v4 UUID), `request`: `subtype: "can_use_tool"`, `tool_name`, `display_name` (the tool name), `input` (the tool input), `description` (the summary of the `● <Tool>` line), `permission_suggestions: []`, `tool_use_id` | a permission ask, with `--permission-prompt-tool stdio` |
| `{"type":"system","subtype":"permission_denied",…}` | `tool_name`, `tool_use_id`, `message` (the refusal reason), `session_id`, `uuid` | when a reply denies an ask |
| `{"type":"control_response",…}` | `response`: `subtype` (`success` or `error`), `request_id` (the request's, echoed), `error` (with `error` only) | in reply to each stdin `control_request` with a string `request_id` |
| `{"type":"control_cancel_request",…}` | `request_id` (the abandoned ask's) | when an interrupt, a signal or stdin closing abandons a waiting ask, before the turn's result |
| `{"type":"system","subtype":"status",…}` | `status` (`"compacting"`, or `null` with `compact_result` `"success"` or `"failed"`), `session_id`, `uuid` | at the start and the end of a `/compact` |
| `{"type":"system","subtype":"compact_boundary",…}` | `session_id`, `uuid`, `compact_metadata`: `trigger` (`"manual"`), `pre_tokens`, `post_tokens` (the numbers of the `clodent: conversation compacted (<pre> → <post> tokens)` line) | when a `/compact` succeeds |
| `{"type":"system","subtype":"hook_context_truncated",…}` | `hook_event` (the event name), `scope` (`"hook"` for one command's context, `"event"` for a firing's joined context), `bytes` (the size before the cut), `limit` (the cap), `session_id`, `uuid` | each hook context cut (see [Hooks](#hooks)), with its warning on stderr; one from a `SessionStart` before an `init` waits and follows it |
| `{"type":"conversation_reset",…}` | `new_conversation_id` (the new session id), `trigger` (`"clear"`), `session_id` (the old id), `uuid` | at a `/clear`, before its `init` |
| `{"type":"result",…}` | below | once per turn, as its last line; once per empty prompt; once per slash command other than `/quit` and `/exit`, as its last line |

Result fields, in this order:

- `subtype`: `error_during_execution` when `is_error`, else `success`; always `success` for a slash command.
- `is_error`: true for an API error after retries, a budget stop, an empty prompt, a failed `/compact` or `/clear`, or an unknown slash command.
- `duration_ms`: the turn's wall time in ms, from the prompt to the end of the turn, before the `Stop` hook.
- `duration_api_ms`: the summed durations of the turn's API responses.
- `num_turns`: the number of API responses in the turn; a failed or interrupted attempt is not one.
- `result`: the text blocks of the turn's last response that did not stop for `tool_use`, joined, or `""`. For an API error it is the error message; for a budget stop, the `[clodent:budget]` line; for an interrupt, the text that streamed in the interrupted response before the interrupt, or `""`; for an empty prompt, `clodent: empty prompt (image input is not supported)`.
- `stop_reason`: the last response's `stop_reason`; null after an interrupt, an API error, a budget stop, a response without one, and for an empty prompt.
- `session_id`.
- `total_cost_usd`: the session total so far, the number on the `[clodent:cost] session total` line. It is cumulative for the process and never resets.
- `usage`: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` and `output_tokens`, summed over the turn's requests, failed and interrupted attempts included (see [Cost](#cost)).
- `permission_denials`: always `[]`.
- `uuid`.

An interrupted turn, in either input mode, has `subtype: "success"`, `is_error: false` and `stop_reason: null`.

Input lines, with `--input-format stream-json`: one JSON object per line, UTF-8; a trailing `\r` is dropped. A line over 64 MiB (67108864 bytes) is dropped with a warning (below), up to its newline, and the next line is read as usual.

| line | effect |
|---|---|
| `{"type":"user","message":{"role":"user","content":<text or blocks>}}` | a prompt: the string, or the `text` blocks' `text` joined with `\n\n`. Each `image` block is dropped with `clodent: stdin: dropped an image block: image input is not supported`, any other block with `clodent: stdin: dropped a "<type>" block: only text blocks are read`, and content that is neither with `clodent: stdin: a user message without string or array content`. A prompt with no non-whitespace text left is empty: it gets an `is_error` result and sends no request. `session_id`, `uuid`, `parent_tool_use_id` and other fields are ignored |
| `{"type":"control_response","response":{"subtype":"success","request_id":<id>,"response":{"behavior":"allow",…}}}` | answers the ask with that `request_id`: the call runs with the `input` of its `control_request`. `updatedInput` and `updatedPermissions` are ignored |
| any other `control_response` for a waiting ask, such as `"behavior":"deny","message":<text>` | refuses the call with the reason `message`, or `denied by the user` when it is missing or empty: the `permission_denied` line, then the model gets the reason as the error tool result, and the turn goes on |
| `{"type":"control_request","request_id":<id>,"request":{"subtype":"interrupt"}}` | the `success` reply, then, if a turn is running, the REPL's Ctrl-C: the request, tool or hooks are aborted, the transcript gets the interrupt records, the turn's cost line goes to stderr, and its result follows. When idle, which includes a turn's `Stop` hooks after its result, only the reply, unless a non-empty prompt or a command read before it has not started yet: the first such one takes it: a prompt's turn is interrupted before its first request, and a command runs with it: a `/compact` on a non-empty history fails as `interrupted`, a `/clear` starts its new session without running the `SessionStart` hooks, and any other command ignores it. During a `/compact`, it aborts the `PreCompact` hooks or the summary request, and the compact fails as `interrupted`; once the summary is in, it stops the file reloads and the `SessionStart` hooks, and the compact succeeds with the files read so far. During a `/clear`'s `SessionStart` hooks, it kills them; the new session stands, and its `init` and result follow |
| `{"type":"control_request","request_id":<id>,"request":{"subtype":"set_model","model":<id>}}` | the REPL's `/model <id>`: the id less one trailing `[…]` suffix is used from the next request and the system prompt is rebuilt; then the `success` reply. A missing model replies `error` with `set_model needs a model id`, and a failed rebuild with its message, keeping the model |
| a `control_request` of any other subtype | the reply `{"subtype":"error","request_id":<id>,"error":"unsupported control request: <subtype>"}` |

A line that is empty or only whitespace is skipped without a warning.

Warnings, each one `clodent: <warning>` line on stderr, after which the line is ignored: `stdin: ignoring a line that is not JSON: <the line, cut to 60 characters and …>`, `stdin: ignoring a message of unknown type "<type>"` (`null` when there is none), `stdin: ignoring a control_request without a string request_id` and `stdin: ignoring a control_response without a string request_id` (no reply is written), `stdin: ignoring a line over 67108864 bytes`, and `stdin: no permission request "<id>" is waiting; reply ignored` for a reply to an unknown, already answered or cancelled ask.

Turns:

- A prompt that arrives while no turn runs starts its own turn, after any prompt waiting ahead of it, and never joins that prompt's tool results: `UserPromptSubmit` fires, then the turn runs as in [Print mode](#print-mode).
- A prompt that arrives during a turn joins the turn's next tool-results message as one more `text` block, after any hook context: no new turn and no extra result, and `UserPromptSubmit` does not fire for it. If the turn ends first, or is interrupted, the prompt runs as its own turn after the result, and never joins a later turn's tool results. Waiting prompts run one at a time in arrival order; an empty one gets its `is_error` result in its place, and a prompt that arrives during a turn while an older one waits, empty or not, waits behind it instead of joining the turn.
- A slash command (below) never joins a turn: one that arrives during a turn waits and runs after that turn's result, and a prompt that arrives after it waits for it instead of joining the turn. Waiting prompts and commands run one at a time in arrival order.
- stdin closing (EOF) cancels a waiting ask (the `control_cancel_request` line) and refuses it, and any later one, with `denied: input closed`, lets the running turn and the waiting prompts and commands finish, and exits 0 as the REPL's Ctrl-D does: the session total on stderr, then the wait for the statusLine command. A stdin read error counts as stdin closing; one other than `EIO` first prints `clodent: stdin: <message>`.
- SIGINT exits 130, SIGTERM 143, SIGHUP 129: the running turn is interrupted and its result written, waiting prompts and commands are dropped, and clodent exits as print mode does on a signal. A second signal kills a running `Stop` hook.

Slash commands: a user message whose text, trimmed, is one line whose first word is `/` followed by lowercase letters is a command, parsed as the REPL parses a typed line (see [REPL](#repl)); anything else, such as `/Users/me/x fix it` or a multi-line text, is a prompt. A command runs the REPL's command instead of a turn: no `UserPromptSubmit`, no `Stop`, no `turn_duration` record. Its reply lines, listed below, go into its result's `result`, never onto stdout; a `/compact`'s `clodent: conversation compacted (<pre> → <post> tokens)`, `clodent: reloaded …`, `clodent: not reloaded …` and `[clodent:cost]` lines, the `[clodent:budget]` line and warnings go to stderr. Each command but `/quit` and `/exit` ends with one result: `duration_ms` the command's wall time, `duration_api_ms` 0, `num_turns` 0, `usage` all zeros, `stop_reason` null, `total_cost_usd` the session total so far, unless said otherwise below.

| command | lines on stdout |
|---|---|
| `/compact [<instructions>]` | the REPL's `/compact` (`PreCompact`, the summary request, the transcript records, `SessionStart` with `source` `compact`, the statusLine update), under the same session id: `status` `"compacting"`; on success the `compact_boundary` line; `status` `null` with `compact_result`; then the result, with `num_turns` 1, `usage` the summary request's, its failed and interrupted attempts included (see [Cost](#cost); all zeros when no attempt reported usage), and `total_cost_usd` including it. On success `is_error` is false and `result` is `""`; on failure no `compact_boundary` is written, `is_error` is true and `result` is the REPL's line: `clodent: nothing to compact` or `clodent: compact failed: <reason>` |
| `/clear` | the REPL's `/clear` (a new minted session id and transcript, the statusLine update with zero usage, `SessionStart` with `source` `clear`): `conversation_reset`, then a full `init` with the new `session_id` after the `SessionStart` hooks, then the result with `result` `""` and the new `session_id`; `total_cost_usd` is not reset. Later requests carry the new id in `metadata.user_id`. If a new session cannot start, only an `is_error` result with `clodent: <message>` |
| `/cost` | the result, with `result` the REPL's `[clodent:cost] session total …` line |
| `/model [<id>]` | as the REPL: with an id, the same as a `set_model` request; the result, with `result` the REPL's lines, such as `clodent: model <id>` |
| `/help` | the result, with `result` the help lines joined with `\n` |
| `/quit`, `/exit` | no result: clodent stops reading stdin, drops any input waiting behind the command, and exits 0 as on stdin EOF |
| any other `/<name>` | an `is_error` result with `result` `clodent: unknown command /<name> (try /help)` |

Permissions go as in print mode (see [Print mode](#print-mode) and [Permission rules](#permission-rules)), except that with `--permission-prompt-tool stdio` a call the REPL would ask about writes a `control_request` and waits for its reply. The `PreToolUse` hooks, the settings deny rules and the mode decide first, in the REPL's order, and `--yolo`'s mode never asks. The `Notification` hook fires at the ask exactly as in the REPL. An interrupt or a signal abandons a waiting ask: the `control_cancel_request` line names its `request_id`, and the call is refused with `interrupted by user`. Without `--permission-prompt-tool stdio`, such a call is refused with the print mode reason.

Everything else is the REPL's: hooks, the statusLine after each response, the transcript records, cost and `--budget`, retries, `AGENTS.md`, `--add-dir`, `--resume` and `--fork-session`.

### REPL

`clodent` without `-p` starts the interactive REPL on stdin and stdout; a host such as Clodex drives it through a PTY. Everything it prints goes to stdout. Only a startup error that exits 2 (the [Print mode](#print-mode) list, settings warnings first) and the `clodent: ignoring --<name>: not supported` lines, written before the `[clodent:session]` line (see [Flags](#flags)), go to stderr.

Startup, in this order:

1. When stdin is a TTY, clodent turns raw mode on. Input that arrives from here on is parsed and kept.
2. `[clodent:session] <session-id>`, then one `clodent: <warning>` line per settings or session warning.
3. The `SessionStart` hook, with `source` `startup`, or `resume` with `--resume`.
4. The first prompt.

Every prompt, and every queued line's echo, is written as `\x1b[?2004h` and then `> `. A host can take the first `\x1b[?2004h` as "ready for input". Bracketed paste stays on until exit, when clodent writes `\x1b[?2004l`.

Keys, with stdin read as UTF-8:

| input | effect |
|---|---|
| printable text | typed into the line and echoed |
| `\r`, `\n` or `\r\n` | submits the line; an empty or whitespace-only line just shows a new prompt |
| `\x7f` or `\x08` (backspace) | deletes the last typed character, or the whole last paste |
| `\x15` (Ctrl-U) | clears the line |
| `\x17` (Ctrl-W) | deletes the last typed word, or the whole last paste |
| `\x03` (Ctrl-C) | during a turn, interrupts it. At a prompt with text, clears the line. At an empty prompt, prints `(press Ctrl-C again or Ctrl-D to exit)` and a new prompt; a second Ctrl-C with no other key in between exits |
| `\x04` (Ctrl-D) | at an empty prompt, exits; otherwise ignored |
| any other control byte, CSI sequence (`\x1b[` up to a final byte `@` to `~`) or SS3 sequence (`\x1bO` and one byte) | ignored; an ESC before any other byte is dropped alone |

Paste:

- Everything between `\x1b[200~` and `\x1b[201~` is one paste, even when it arrives in several writes. Inside it, `\r\n` and `\r` become `\n`; control bytes other than `\n` and `\t`, and escape sequences, are dropped; only `\x1b[201~` ends it.
- A paste joins the line as one piece and does not submit it; the next `\r` does.
- A paste without a newline is echoed as is. One with a newline is echoed as `[pasted text, <n> lines]`, a trailing newline not counting as a line, and never line by line.
- The submitted text is the typed text and the pastes joined, newlines kept.

Queueing: during a turn, input is parsed but not echoed, and each submitted line is queued. When the turn ends, the queued lines run one at a time in order, each echoed as `> <first line>`, plus ` [+<n> lines]` for the lines after the first, and run like a typed line, slash commands included. An interrupt keeps the queue. Text typed during a turn but not submitted shows at the next prompt.

A prompt runs one turn of the agent loop, as in print mode. The model's text streams as it arrives, and the tool lines, warnings and the per-turn `[clodent:cost]` line follow it on stdout. Thinking is never printed; when stdout is a TTY, each thinking block shows one dim `thinking…` line instead. On a TTY, these lines carry SGR colour codes around their text, closed by `\x1b[0m`: yellow (`\x1b[33m`) for warnings, `clodent: interrupted`, `[clodent:budget]` and the no-price warning; red (`\x1b[31m`) for errors and `  ✗` lines; dim (`\x1b[2m`) for `thinking…` and the per-turn and session-total `[clodent:cost]` lines. The `[clodent:session]`, `[clodent:permit …]`, `● <Tool>` and slash command lines are never coloured.

In the streamed text and in the `● <Tool>`, `[clodent:permit …]`, `  ✗`, warning, error, `conversation compacted`, `reloaded` and `not reloaded` lines, each C0 control byte, DEL and C1 control (U+0080–U+009F) is written as `\u` and four lowercase hex digits, such as `\u001b` for ESC, except `\n` and `\t` in the streamed text, so model or tool text cannot move the cursor or send a terminal escape; print mode's stderr lines get the same, while its stdout answer, transcripts, stream-json and hook stdin keep the raw text.

Slash commands: a submitted line is a command when it was typed, with no paste in it, and its first word is `/` followed by lowercase letters. Anything else is a prompt, such as `/Users/me/x fix it` or a pasted `/clear`.

| command | effect |
|---|---|
| `/help` | one line per command |
| `/cost` | prints the `[clodent:cost] session total …` line |
| `/model` | prints `clodent: model <id>` |
| `/model <id>` | uses `<id>`, less one trailing bracketed suffix such as `[1m]`, for the next requests and rebuilds the system prompt, which names the model; the history is kept. If the rebuild fails, prints `clodent: <message>` and keeps the model. Then prints `clodent: model <id>`. With more than one word after `/model`, prints `clodent: /model takes one model id` and changes nothing |
| `/clear` | starts a new session with a minted id (never the `--session-id`) and an empty history: prints `[clodent:session] <new id>`, records into a new transcript and leaves the old one as is, sends a statusLine update with zero usage and the new session id, and fires `SessionStart` with `source` `clear`, whose context goes into the next prompt. The cost, model and effort carry over |
| `/compact [<instructions>]` | summarises the conversation into one message, under the same session id (see below) |
| `/quit`, `/exit` | exits, as Ctrl-D does |
| any other `/<name>` | prints `clodent: unknown command /<name> (try /help)`; no request is sent |

`/compact`: everything after `/compact` on the line, trimmed, is the instructions. ^C interrupts it.

1. With an empty history it prints `clodent: nothing to compact` and does nothing else.
2. When the history ends in an assistant message with `tool_use` blocks and no results, it first closes them the way a turn does: it prints the `● <Tool> <summary>` and `  ✗ interrupted by user` lines for each, writes a tool results record giving each the error result `interrupted by user`, and marks the next prompt as following an interrupt until the compact succeeds. Then it fires the `PreCompact` hook with `trigger: "manual"` and `custom_instructions` (see [Hooks](#hooks)).
3. It sends one summary request: the model, system prompt and tools of a normal turn, `tool_choice: {type: "none"}`, and the history with one user text block appended that asks for a summary a fresh context can continue from, followed by `\n\nAdditional instructions: <instructions>` when there are any. When `compactReloadFiles` (see [Settings](#settings)) is above 0 and the `Read` tool is sent, the block asks, before any instructions, that the summary end with a `Files to reload:` line followed by up to that many file paths, one per line, most important first, or `Files to reload: none`; at 0, or when a bare-name `Read` deny removes the tool (see [Permission rules](#permission-rules)), it is the block without that sentence. The budget check applies as before any request. The summary does not stream to the screen.
4. On a response with `stop_reason: "end_turn"` and non-empty text, clodent reloads the files (below), and the history becomes one user message: a text block `This session continues an earlier conversation that was compacted. Summary of it:\n\n` followed by the summary, then one text block per reloaded file. clodent prints `clodent: conversation compacted (<preTokens> → <postTokens> tokens)`, then `clodent: reloaded <n> file(s) after compact: <path>, <path>` when it reloaded any and one `clodent: not reloaded <path>: <reason>` per skipped file, the `[clodent:cost] warning: no price for model <id>; cost not counted` line if this model has not been warned about yet, and the request's `[clodent:cost]` line, sends a statusLine update with `used_tokens` at `<postTokens>`, and fires `SessionStart` with `source` `compact`, whose context goes into the next prompt. `<preTokens>` is the request's input, cache-read and cache-write tokens; `<postTokens>` is its output tokens, so the reloaded files count from the next request's usage on. The transcript gets the two compact records (see [Sessions](#sessions)).
5. Otherwise the history and transcript are unchanged apart from that closing of step 2, and clodent prints `clodent: compact failed: <reason>`: `budget` (after the `[clodent:budget]` line), `interrupted`, `stop_reason <stop_reason>`, `empty summary`, or the API error message. A response's cost, and a failed or interrupted attempt's (see [Cost](#cost)), still counts in the session total.

Reloading files after a compact, unless `compactReloadFiles` is 0 or the `Read` tool is not sent:

- The files: the text after the colon of the summary's last line whose trim starts with `Files to reload:` once leading `` ` ``, `*`, `#` and spaces are dropped (when a `` ` `` or `*` is among those, the run of `` ` `` and `*` right after the colon, or else at the end of that text, is dropped too), then the lines after that line, up to the first blank line or the end, each trimmed, less one leading `- ` or `* ` and surrounding backticks; when that text is empty, blank lines right after the line are skipped first; empty entries left are dropped. When that text, cleaned, is `none` (in any case), no file. When no line starts so, or no entry is left, the `file_path` of the history's `Read`, `Edit` and `Write` calls whose result was not an error, most recent first, so a call a hook or rule refused, or one that failed, is left out. A relative path resolves against the working directory; duplicates are dropped and the first `compactReloadFiles` kept. The summary text stays as the model wrote it, the list included.
- Each file, in order, is read with the `Read` tool's defaults (its 32 KiB cap included) after the screen a model `Read` gets: the `PreToolUse` hooks (see [Hooks](#hooks)), the settings deny rules (the `sandbox` block's included), the ask rules and the mode. Nothing asks: a file a hook denies or asks about is skipped as `hook` in every mode, one a deny rule matches as `denied`, and one an ask rule matches as `ask` unless the mode is `--yolo`, which never asks. A hook `updatedInput` replaces the `Read` input, as for a model call, and the rules screen that input; the file's block and lines still name the listed path. A missing file, a directory or any other `Read` error is skipped with the error text as the reason.
- The outputs may total 64 KiB (65536 bytes). A file that would pass that is skipped as `budget`; a later, smaller one may still fit. The `SessionStart` context does not count.
- Each reloaded file's block is `Contents of <absolute path> at compact time (Read tool output):\n\n<output>`. A skipped file's content goes nowhere, and the message does not name the skipped files.
- A reload is not a tool call: apart from `PreToolUse`, no hook fires (no `PostToolUse`, `PostToolUseFailure` or `Notification`), no `● <Tool>` line prints, and no `tool_use`, `tool_result` or `permission` event and no tool results record is written.
- ^C during the reads or their `PreToolUse` hooks kills the running hooks and stops the remaining reads, each skipped as `interrupted`, the file whose hooks it stopped included; the compact still succeeds with the files read.

A compact is not a turn: it fires no `Stop` hook and writes no `turn_duration` record. Print mode has no compact.

Permission ask: in the default mode, a write or exec tool call that no hook allowed or denied waits for an answer, unless it is a read-only `Bash` command (see [Read-only Bash](#read-only-bash)). In `--permission-mode acceptEdits` write tools run inside the working directory and the `--add-dir`/`trustedDirectories`/`additionalDirectories` dirs, so only a `Bash` command that is not read-only waits, and so does a `Write` or `Edit` outside those dirs, under a `.git`, `.clodent` or `.claude` directory, or to a file a hook or statusLine command names (see [Read-only Bash](#read-only-bash)). So does any call a settings ask rule matches, even one a hook allowed, and any call a hook asks about, a read included; a call a deny rule matches is refused without asking (see [Permission rules](#permission-rules)). The `--yolo` and `--read-only` modes, whichever flag names them, never ask, and print mode refuses the call instead.

1. clodent prints `[clodent:permit <Tool> <tool_use id>] <summary>` on its own line, with the summary of the `● <Tool> <summary>` line; with an empty summary the line ends at `]`.
2. It writes `Allow? [y/n] ` and starts reading one line.
3. With the ask listening, it fires the `Notification` hook with `notification_type: "permission_prompt"`, `title: "Permission needed"`, `message: "clodent needs your permission to use <Tool>"`, `tool` (the tool name) and `id` (the tool_use id). A line written while the hook runs is read as the answer. The call runs or is refused once both the answer and the hook are done. A hook warning may print after `Allow? [y/n] `.
4. `y` or `yes`, trimmed and in any case, runs the call. `n` or `no` refuses it with the reason `denied by the user`. An empty line asks again. Any other line, and any line with a paste in it, is not an answer: it is queued as a prompt, and clodent prints `clodent: queued as a prompt; answer y or n` and asks again.
5. Ctrl-C interrupts the turn, and the call does not run. stdin closing refuses the call with the reason `denied: input closed`.

Exit, on every path: clodent prints the session total line, waits for the statusLine command, writes `\x1b[?2004l`, turns raw mode off, stops reading stdin and sends any pending SIGKILL (see [Tools](#tools)). An unexpected error skips the session total and the wait, but still restores the terminal and sends the pending SIGKILLs. Exit codes:

- 0: Ctrl-D or a second Ctrl-C at an empty prompt, `/quit`, `/exit`, or stdin closing, once the running turn and the queue are done. A stdin read error counts as stdin closing; one other than `EIO` first prints `clodent: <message>`.
- 143 on SIGTERM, 129 on SIGHUP: clodent interrupts the running turn, then exits. A second SIGTERM or SIGHUP kills a running `Stop` hook.
- SIGINT acts as Ctrl-C.
- 2: a startup error, as in print mode.

### System prompt

Every request carries this system prompt. Its parts, in this order, are separated by blank lines, and an empty part is left out:

1. The base: the `--system-prompt` text, else the contents of `--system-prompt-file`, else clodent's own prompt.
2. `# Environment`: the working directory; whether it is a git repository, and its root; the platform; the local date as `YYYY-MM-DD`; the model id; and, when there are extra directories, `Additional directories:` followed by one absolute path per line: every `--add-dir` in argv order, then the settings extra directories (see [Settings](#settings)), without duplicates.
3. `# Instructions (AGENTS.md)`, when any AGENTS.md is found: each file under its own `## <absolute path>` heading.
4. Every `--append-system-prompt` text in argv order, then the contents of every `--append-system-prompt-file` in argv order.

Relative paths given to `--system-prompt-file`, `--append-system-prompt-file` and `--add-dir`, and relative settings extra directories, resolve against the working directory. A prompt file that is missing or unreadable is an error that names its path.

The date carries no time of day, so the system prompt stays byte-identical all day.

AGENTS.md discovery:

- The git root is the nearest directory, from the working directory upwards, that has a `.git` entry, either a directory or a file (a git worktree has a `.git` file).
- clodent reads `AGENTS.md` in every directory from the git root down to the working directory, so the most specific file comes last. Outside a git repository only the working directory's `AGENTS.md` is read.
- A file that is empty or holds only whitespace, a directory named `AGENTS.md` and an unreadable file are skipped, with no heading.
- Each file is capped at 32 KiB, and all of them together at 96 KiB, counted in bytes. The total is spent from the working directory upwards, so the files nearest the git root are cut first. A cut file ends with the line `[clodent: AGENTS.md truncated]`.

### API wire

clodent sends every request as `POST https://api.anthropic.com/v1/messages`, or `POST <ANTHROPIC_BASE_URL>/v1/messages` when that is set (see [Environment](#environment)), with exactly these headers:

- `x-api-key: <ANTHROPIC_API_KEY>`
- `anthropic-version: 2026-10-21`
- `content-type: application/json`
- `user-agent: clodent/<version>`

No `anthropic-beta` header is sent. The body always has `stream: true`, `thinking: {"type": "adaptive"}` and `max_tokens: 32000`; `output_config: {"effort": "low"|"medium"|"high"|"xhigh"|"max"}` is present only when an effort is set. Every request, retries and the `/compact` summary request included, carries `metadata: {"user_id": "{\"session_id\":\"<id>\"}"}`: the value is the string `JSON.stringify({session_id: <id>})`, not an object, and `<id>` is the current session id printed on `[clodent:session]` and used as the transcript filename, that is the `--session-id` or minted id, the resumed id under `--resume`, the new id under `--resume … --fork-session`, and the new id after `/clear`. It carries at most four `cache_control` breakpoints: the system block, the last tool definition, the tail (the last content block of the last message, skipping back over trailing `thinking` and `redacted_thinking` blocks), and the settled pin. A real user turn is a `user` message whose content is a non-blank string or contains at least one `text` block; a message of only `tool_result` blocks is not one, and a `tool_result` message that also has a `text` block is. The boundary is the index of the last real user turn in the messages sent. When an `assistant` message comes after the boundary, that is from the second request of a turn on, the pin is on the boundary message; otherwise, on the first request of a turn, it is on the last real user turn before the boundary. There is no pin when the boundary is the first message or there is no real user turn, or when, on the first request of a turn, no real user turn comes before the boundary. The pin marks the last content block of its message, and string content there is sent as one `text` block. With no tools the tool breakpoint is absent and `tools` is omitted. `tools` is sent sorted by `name` in ascending code-unit order, so the tool breakpoint is on the last name in that order; only the wire order changes.

With the cache TTL `5m`, the default (see `--cache-ttl` and the settings `cacheTtl`), every breakpoint is `{"type": "ephemeral"}`, with no `ttl` key. With `1h`, the system block, the last tool definition and the settled pin are `{"type": "ephemeral", "ttl": "1h"}` and the tail stays `{"type": "ephemeral"}`, so no 1-hour breakpoint follows a 5-minute one in tools, system, messages order. The `/compact` summary request uses the same TTL.

Requests that fail before the first SSE event with status 429, 500, 502, 503, 504 or 529, or with a network error, are tried at most 4 times. The waits are 1 s, 2 s and 4 s, each with ±20% jitter, and a `retry-after` header in seconds replaces the wait, capped at 60 s. Any other status is not retried. An `error` event once the stream has started discards the partial response; when its type is `overloaded_error` or `api_error`, clodent re-sends the same request at most 2 more times, after 2 s and then 4 s, each announced by a `clodent: <message>; retrying in <n> s` warning. Any other `error` event is not retried. The API's error message is surfaced verbatim. A network error's message is surfaced with any `//<user>:<password>@` in it cut to `//`.

When no bytes of the response body arrive for 300 s, clodent drops the connection as a network error `stream idle for 300s`; an event whose unterminated text passes 16 MiB (16,777,216 characters) fails the same way with `SSE event over 16 MiB`. The rules above apply to both: retried before the first SSE event, and failing the turn after it. The API sends `ping` events while the model thinks, so a live stream is never idle that long.

### Cost

clodent prices each Messages API response from its `usage` object, against a table keyed by the exact model id. Ids never match by prefix: `claude-opus-5-5-preview` has no price. Rates are USD per million tokens:

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
[clodent:cost] $X.XXXX (in N, cache-read N, cache-write N, out N)
[clodent:cost] session total $X.XXXX (in N, cache-read N, cache-write N, out N, requests N)
[clodent:cost] warning: no price for model <id>; cost not counted
[clodent:budget] stopped: spent $X.XXXX, next request est. $X.XXXX, budget $X.XXXX
[clodent:budget] stopped: model <id> has no price; --budget needs a priced model
```

`in` is `input_tokens`, `cache-read` is `cache_read_input_tokens`, `cache-write` is all cache-write tokens and `out` is `output_tokens`, summed over the turn's requests, or over the session for the total. The per-turn line prints after every turn, and the session total prints on exit.

Every request attempt that got its `message_start` event is charged and counts in `requests`, also when it then fails, is re-sent or is interrupted (Ctrl-C, a signal, a stream-json `interrupt`). A failed or interrupted attempt is charged its `message_start` input, cache-read and cache-write tokens and the `output_tokens` of its last `message_delta`, or 0 output before any. The per-turn line, the session total, `/cost` and `--budget` all include these charges; the transcript records no usage for a failed or interrupted attempt. An attempt that fails before `message_start` reported no usage and is not charged.

`--budget <usd>` is checked before every request the loop sends, each mid-stream re-send included:

- The estimate for the next request is the cost of the previous charged attempt, or 0 before the first.
- clodent stops with the `spent` line when the session total spent plus that estimate exceeds the budget. A projected total exactly equal to the budget proceeds.
- When any request in the session was for a model with no price, clodent stops with the `has no price` line, naming the first such model. A budget is never run unmetered.

A re-send the budget does not cover is not sent, and the turn stops with the `spent` line as a first request would, without the `retrying` warning. Pre-stream retries (see [API wire](#api-wire)) charge nothing, so the check before the first try covers them.

### Tools

clodent has six built-in tools, in this order (the request sends them sorted by name, see [API wire](#api-wire)); a bare-name deny rule in settings or `--disallowedTools` removes one (see [Permission rules](#permission-rules)). `kind` decides how permissions treat a tool. Input names follow the common agent-tool convention, so a hook reading `tool_input` sees the same fields. Relative paths resolve against the working directory, and every path in a result is absolute.

| Tool | Kind | Inputs | Result |
|---|---|---|---|
| `Read` | read | `file_path`; `offset` (1-based line, default 1); `limit` (lines, default 2000) | `cat -n` style: the line number right-aligned in 6 columns, a tab, the line. Lines over 2000 chars are cut and end in `…`. An empty file returns `<path> is empty (0 bytes)`. Errors: missing file, a directory or other non-regular file, a binary file (NUL in the first 8 KiB), an offset past the end. |
| `Write` | write | `file_path`; `content` | Creates parent directories and overwrites. `Wrote <n> bytes to <path>`. |
| `Edit` | write | `file_path`; `old_string`; `new_string`; `replace_all` (default false) | Exact string replacement, no regex; the rest of the file stays byte-identical. `Edited <path>: <n> replacement(s)`. Errors: missing file, empty `old_string`, `old_string` equal to `new_string`, no match, more than one match without `replace_all` (the message gives the count). |
| `Bash` | exec | `command`; `timeout` (ms, default 120000, clamped to 600000); `description` (ignored) | Runs `bash -c <command>` in its own process group with stdin closed; stdout and stderr interleaved in arrival order, then a trailer line `[exit <code>]`, `[timed out after <ms> ms]` or `[killed by <signal>]`. A timeout or interrupt sends SIGTERM to the group, then SIGKILL 2 s later. An error unless the exit code is 0. |
| `Grep` | read | `pattern` (JavaScript RegExp source); `path` (file or directory, default cwd); `glob`; `output_mode` (`files_with_matches` default, `content`, `count`); `ignore_case` (default false); `head_limit` (output lines, default 250) | `files_with_matches`: sorted paths. `content`: `<path>:<line>:<text>`. `count`: `<path>:<n>`. A `glob` without `/` matches the file name, with `/` the path relative to `path`. Binary files are skipped. No match: `No matches found` (not an error). An invalid pattern is an error carrying the SyntaxError message. Cut output ends with `[clodent: showing the first <limit> of <n> lines; raise head_limit to see more]`. |
| `Glob` | read | `pattern`; `path` (directory, default cwd) | Paths whose path relative to `path` matches: `*` and `?` never cross `/`, `**` spans directories, `{a,b}` and `[abc]` / `[!abc]` are supported. Newest mtime first, at most 1000, followed by `[clodent: showing the 1000 newest of <n> matches; narrow the pattern]` when cut. No match: `No files matched` (not an error). |

Grep and Glob list files with `git ls-files --cached --others --exclude-standard` inside a git work tree, so `.gitignore` is respected; elsewhere they walk the directory, skipping `.git` and `node_modules`. A `path` that is itself git-ignored (such as `node_modules/pkg` or `dist`) is walked instead, so its files are listed. Both git calls, `git ls-files` and `git check-ignore`, run with `-c core.fsmonitor=` (empty, which every git with fsmonitor reads as off), so a repository's `.git/config` cannot make them run a program, and in clodent's environment minus `ANTHROPIC_API_KEY` and each deny `credentials.envVars` name, as a Bash command does. A malformed glob is an error, `Invalid glob <glob>: <message>`.

A Bash command's environment is clodent's, with the settings `env` applied, minus `ANTHROPIC_API_KEY` and minus each deny `credentials.envVars` name (see [Permission rules](#permission-rules)); the key is removed from the Bash tool's environment also when it comes from settings `env`, but a command can still read clodent's own startup environment, for example with `ps eww $PPID` on macOS (see the `credentials.envVars` limit in [Permission rules](#permission-rules)). API requests still send the key; hooks and the statusLine command run without it and without those names too (see [Hooks](#hooks)).

A Bash call returns once bash has exited and its stdout and stderr are closed. A background process that keeps them open (`server &`) holds the call until the timeout, which then ends it with the timed-out trailer even when bash exited 0. A descendant that has left the process group is not killed; 2 s after the SIGTERM clodent closes its end of the pipes and returns.

When clodent exits, in either mode and on every exit path after startup, every process group of a tool, hook or statusLine command that got SIGTERM and is still waiting for its SIGKILL gets the SIGKILL at once, so a process that ignores SIGTERM does not outlive clodent.

Every tool result is capped at 32768 bytes (UTF-8). A longer result keeps its first 16384 and last 16384 bytes, cut back to whole characters, joined by:

```
\n[clodent: truncated <n> bytes]\n
```

where `<n>` is the exact number of bytes removed.

### Read-only Bash

Under the default and `acceptEdits` modes and `--read-only`, a `Bash` call whose command is read-only runs without asking. Any other command gets the default mode's refusal, or under `--read-only`:

```
--read-only: Bash command is not read-only (<reason>)
```

`<reason>` names the first offending part, such as `rm is not a read-only command`, `output redirection`, `command substitution`, `find -delete` or `git -c`.

In `acceptEdits`, a `Write` or `Edit` runs without asking only when its `file_path`, resolved against the working directory, is the working directory, an `--add-dir`, `trustedDirectories` or `permissions.additionalDirectories` dir, or below one of them, compared on whole path segments (`/work-other` is not below `/work`). Otherwise it asks as in the default mode, and `-p` refuses it: a path outside those dirs (`../x`), a path with a `.git`, `.clodent` or `.claude` component in any case (`.git/config`, `sub/.GIT/hooks/x`, `.claude/settings.json`, `.git` itself), and, in any case and either Unicode normal form (NFC or NFD), a file a hook or `statusLine` command names. Those files are all the words of each command, split as a shell would and as the conservative reading of [Permission rules](#permission-rules) splits them, once a leading `~`, `$HOME`, `$CLODENT_PROJECT_DIR`, `$CLAUDE_PROJECT_DIR` or `$PWD` (or its `${…}` form) is expanded as the hook's environment has it, resolved against the working directory, so `bash pre.sh` names `bash` and `pre.sh` in the working directory. `$PWD` is the working directory, a variable that environment lacks, such as `HOME` when a deny `credentials.envVars` names it, is empty, and `~` is then the user's home directory. A repository's config and hooks name programs that git commands run, and settings and hook scripts name programs clodent runs. The checks are by name only, so a path through a symlink gets past them.

clodent splits the command into simple commands on `|`, `||`, `&&`, `;` and newlines, honouring single quotes, double quotes, backslash escapes and `#` comments. The command is read-only when every simple command is. Blank lines, a trailing `;` and a newline right after `|`, `||` or `&&` are fine; any other empty command (`;;`, a leading `|`, a trailing `&&`, an empty or comment-only string), and a simple command made only of redirections, is not read-only.

Each simple command must start with one of these names, with no `/` and no expansion, glob or brace expansion in it (quoting it is fine):

`cat` `head` `tail` `wc` `ls` `pwd` `echo` `printf` `true` `false` `grep` `egrep` `fgrep` `rg` `file` `stat` `du` `df` `which` `type` `whoami` `id` `uname` `date` `basename` `dirname` `realpath` `readlink` `sort` `uniq` `cut` `tr` `diff` `cmp` `comm` `tree` `jq` `od` `hexdump` `xxd` `strings` `column` `nl` `fold` `paste` `seq` `test` `[` `cd` `sha256sum` `sha1sum` `shasum` `md5` `md5sum` `cksum` `find` `sed` `git`

No command that dumps the environment (`env`, `printenv`, `set`, `export`, `declare`, `typeset`, `compgen`) or runs a program that can read it (`awk`, `perl`, `python`) is in the list.

Arguments may expand only these variables, as `$NAME` or `${NAME}`: `HOME`, `PWD`, `OLDPWD`, `USER`, `LOGNAME`, `SHELL`, `PATH` and `TMPDIR`. `<file` is allowed. Output redirection (`>`, `>>`, `>|`, `&>`, `&>>`, `n>`, `n>>`, `>&file`) is allowed only to `/dev/null`, written out, or as an fd duplication (`2>&1`, `>&2`, `n>&m`); anything else is `output redirection`.

These make the command not read-only wherever they appear outside single quotes, double quotes included:

- `$(…)`, `$((…))`, a backtick (escaped or not), `<(…)`, `>(…)`;
- `${…}` other than `${NAME}`, `$[…]`, and the `$'…'` and `$"…"` quotings;
- `$NAME` or `${NAME}` with a name outside that set, such as `$ANTHROPIC_API_KEY` or `$PPID`, and the special parameters `$0`–`$9`, `$@`, `$*`, `$#`, `$?`, `$-`, `$$`, `$!` and `$_` (reason `$<name> expansion`);
- a lone `&`; `(` or `)`; `{` or `}` as a word;
- `<<`, `<<<`, `<>` and `<&`;
- a leading `NAME=value` assignment;
- a word in braces right before `<` or `>`, such as `{fd}>/dev/null` (bash assigns the fd to that variable);
- an unterminated quote or a trailing backslash;
- a line continuation;
- a control character: U+0000–U+001F other than tab and newline, and U+007F–U+009F.

`/proc` is never read-only. An argument or redirection target that may name `/proc` or a path under it makes the command not read-only (`<word> may reach /proc`). clodent checks the word without its quotes, the part after each `=`, and for a word starting with a single `-`, each part after its option letters (`-f/proc/1/environ`). It resolves `.`, `..` and repeated `/` by name; the word may reach `/proc` when a segment that may sit at `/` may be `proc` or a glob or brace expansion matching it (`/p*`, `/[p]roc`, `{/,}proc`), or when it climbs out of `/dev/fd` (`/dev/fd/..` is `/proc/self` on Linux). A segment sits at `/` after a leading `/`, after a `..` that climbs out of the working directory, `~`, or an expanded variable, and after a `~user`, `~-` or `~+` prefix. A segment starting with `.` that may expand to `..` (`.*`) counts as `..`, and a brace expansion or expanded variable may be anything, `..` and `/` included. Once a `cd` may have reached `/` (`cd /`, `cd ..`, `cd -`, `cd "$HOME"`), relative words count from `/` for the rest of the command, and from the start in a session whose working directory is `/`; the target of `cd name` counts from `/` itself, since `CDPATH` may hold `/`.

These checks read the command text only, so they cannot see a symlink into `/proc`, nor the file names a command reads from a file's contents. `--files0-from` on `sort`, `wc` and `du`, which reads them that way, is not read-only (see the table below).

A search that may start at `/` also reads `/proc`. `rg`, `diff` with a short option cluster holding `r` or `--recursive`, and `grep`, `egrep` or `fgrep` with a short option cluster holding `r` or `R`, `--recursive`, `--dereference-recursive` or an argument holding `recurse`, are not read-only (`<command> may search /proc`) when an argument may be `/` itself (`/`, `..`, `~/..`), such a `cd` came first, or the session's working directory is `/`.

Per-command rules. Any match makes the command not read-only. For every command in this table, so does an argument holding an expansion (`$NAME`), a glob (`*`, `?`, `[…]`) or a brace expansion (`{a,b}`, `{1..3}`), since its value cannot be checked. A long option `--name` in these rules also matches its abbreviations (`--outp`), its extensions (`--output-x`) and any of them with `=value`, unless the rule says exactly.

| command | not read-only when an argument is |
|---|---|
| `find` | `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`, `-fprintf` or `-fls` |
| `sort` | a short option cluster holding `o`, `--output`, `--compress-program` or `--files0-from` |
| `wc`, `du` | `--files0-from` |
| `tree` | a short option cluster holding `o` or `R` |
| `rg` | `--pre` or `--hostname-bin`, exactly or with `=value` |
| `date` | a short option cluster holding `s`, `--set`, or digits with an optional `.` and more digits (a time to set) |
| `file` | a short option cluster holding `C`, or `--compile` |
| `printf` | `-v`, or `-v` with a name attached (`-vNAME`) |
| `jq` | one holding `env`, `ENV` (as in `$ENV`), `import` or `include` as a word, a short option cluster holding `f` or `L`, `--from-file` or `--library-path`. jq still sources `~/.jq` when that file exists, which clodent does not read |
| `test`, `[` | `-v` or `-R`, exactly |
| `uniq`, `xxd` | a second operand (an output file); `-`, every argument after `--` and every argument after the first operand count as operands |
| `sed` | see below |
| `git` | see below |

`sed`: every option comes before the first operand and is `-n`, `-E`, `-r`, `-s`, `-u` or `-z` (clustered or not), `-e <script>`, `--regexp-extended`, `--separate`, `--null-data`, `--unbuffered`, `--debug` or `--sandbox`. An option holding `i` or `I` (`-i`, `-I`, `--in-place`) is not read-only. The script, each `-e` value or else the first operand, is commands separated by `;`. Each command is an optional address (`N`, `$`, `/re/`, or two of them joined by `,`) and then `p`, `d`, `=`, `q`, or `s/re/replacement/` with flags only from `g`, `p`, `I`, `i` and digits. A regex may not hold an unescaped `[`, because GNU and BSD sed disagree on where a bracket expression ends. Any other script, with `w`, `r` or `e` among them, is not read-only.

`git`: optional `-C <dir>` and `--no-pager`, then a subcommand. Any other global option, `-c` and `--git-dir` included, is not read-only.

- `rev-parse` `ls-tree` `describe` `merge-base` take any arguments, except `describe` with `--dirty` or `--broken`, which refresh the index.
- `status` `diff` `log` `show` `blame` `grep` `ls-files` `cat-file` `shortlog` `rev-list` are not read-only: a repository or user config can make them run a program (`core.fsmonitor`, `diff.external`, a textconv or clean filter driver, `log.showSignature` with `gpg.program`, a `%G` format).
- `branch`, `tag` and `remote` take only these flags and no operand: `branch` `-a` `-r` `-v` `-vv` `--list` `--show-current` `--contains` `--merged` `--no-merged`; `tag` `-l` `--list`; `remote` `-v`.
- `config` needs `--get`, `--get-all`, `--list` or `-l`, and takes no other option.
- Any other subcommand is not read-only.

### Events

Internal; [Stream JSON](#stream-json) writes its lines from them. The agent loop reports everything through typed events, each `{type, ...fields}`; the terminal renderer and the session recorder consume them.

| type | fields | emitted |
|---|---|---|
| `session_start` | `model`, `cwd`, `tools` (names), `permission` (`ask`, `yolo` or `read-only`) | once, when the agent is created |
| `request_start` | `attempt` (1-based; a mid-stream re-send counts up) | before each request the loop sends; streamMessage's pre-stream retries are not announced |
| `text_delta` | `text`, `index` (content block index) | as text streams in; never for a compact's summary request |
| `thinking_delta` | `text`, `index` | as thinking streams in; never for a compact's summary request |
| `assistant_message` | `message` (the assembled API message), `requestId`, `durationMs`, `usd`, `priced` | when a response completes |
| `message_append` | `role`, `content` (the blocks just added to the history), `kind` (`prompt`, `tool_results`, `assistant` or `partial`), `meta` (`message`, `requestId`, `durationMs`, `usd` for `assistant`; `{}` otherwise) | each time blocks join the history; for a response, just before `assistant_message`, even when its content is empty |
| `tool_use` | `id`, `name`, `input`, `summary` | before each tool call, and before the result made up for a call that never ran |
| `permission_request` | `id`, `name`, `input`, `summary` | after `tool_use`, when the mode would ask about the call (see [REPL](#repl) and [Permission rules](#permission-rules)) and the agent has an asker (the REPL, or [Stream JSON](#stream-json) with `--permission-prompt-tool stdio`); before the `Notification` hook and the ask |
| `permission` | `id`, `name`, `decision` (`allow` or `deny`), `reason` (on deny) | after `tool_use`, for a known tool, unless the turn was interrupted before the decision |
| `tool_result` | `id`, `name`, `content`, `isError`, `durationMs` | after each tool call, including refused, unknown and interrupted calls |
| `turn_end` | `stopReason`, `turn` (the turn's cost aggregate) | last, once per turn |
| `budget_stop` | `result` (the budget check that failed) | instead of a request the budget does not cover |
| `warning` | `message`; `hookContext` (`{event, scope, bytes, limit}`) for a hook context cut | |
| `error` | `message`, `errorType`, `status` (HTTP status, or null mid-stream) | when the turn ends on an error |
| `interrupted` | none | when the turn's signal aborts |
| `compacted` | `trigger`, `summary` (the summary text), `message` (the history's new user message: the summary block, then one block per reloaded file), `reloaded` (`[{path, bytes}]`: each reloaded file's absolute path and the byte length of its `Read` output), `skipped` (`[{path, reason}]`), `preTokens`, `postTokens`, `turn` (the summary request's cost aggregate) | when a compact replaced the history, before the `SessionStart` (`compact`) hook; a compact emits no `turn_end` |
| `session_end` | `session` (the session's cost aggregate) | once, on exit |

`stopReason` is the API's `stop_reason` (`end_turn`, `stop_sequence`, `max_tokens`, `refusal`, or another value other than `pause_turn`, which the loop re-sends), or one of `budget`, `interrupted`, `error` and `unknown` (the response carried no `stop_reason`).

When a response that does not stop for `tool_use` still holds `tool_use` blocks, none of them runs: each gets a `tool_use` event and an error result `interrupted by user`, so the next request stays valid. A turn that starts on a history ending in an assistant message with `tool_use` blocks (a resumed session that was killed while a tool ran) does the same for those blocks before it adds the prompt.

### Sessions

Every run, `-p` or REPL, records its session as a JSONL transcript, one record per line, at `$CLODENT_HOME/projects/<slug>/<session-id>.jsonl` (see [Environment](#environment) for `CLODENT_HOME`).

- `<slug>` is the working directory with every `/` and `.` replaced by `-`, and no other character changed: `/Users/a/my.proj/x_y` becomes `-Users-a-my-proj-x_y`.
- Directories are created mode 0700, the file mode 0600. The file appears with the first record.
- Each record is appended with one synchronous write, ending in `\n`, the moment it exists: every record of a request is on disk before the next request is sent, and the turn's last assistant record and `turn_duration` record are on disk when the turn ends.

Session id:

- `[clodent:session] <session-id>` is printed at start, once the arguments, the API key and the session check out. In print mode it is the first line on stderr; in the REPL, the first line on stdout, and `/clear` prints a new one.
- Without `--session-id`, clodent mints a random UUID.
- `--session-id <uuid>` uses that id, lowercased. When a transcript with that id exists under any project dir, as `--resume` would find it, clodent prints `clodent: session <id> already exists; use --resume` and exits 2.
- `--resume <id>` lowercases a UUID-shaped id and keeps any other id as given. It looks for `$CLODENT_HOME/projects/<slug of cwd>/<id>.jsonl`, then for `$CLODENT_HOME/projects/*/<id>.jsonl` in sorted dir order. With no such file, or an id that is not made of letters, digits, `_` and `-`, clodent prints `clodent: no session <id>` and exits 2. Otherwise it loads the history and appends to that same file under the same id; the first new record's `parentUuid` is the `uuid` of the file's last record.
- `--fork-session` (with `--resume`) records into a new file under a new id: the `--session-id` if given, else a minted one; an existing `--session-id` transcript exits 2 as above. It first copies every record of the source with `sessionId` set to the new id and every other field, `uuid` and `parentUuid` included, unchanged; then it continues. The source file is never written.
- `-p` with `--resume` loads the session, then runs the one prompt.

Loading a transcript:

- User and assistant records that carry neither `isMeta: true` nor `isVisibleInTranscriptOnly: true` are replayed in file order into the history, consecutive records of one role joining one message, exactly as the live history merged them. Other record types and records with either flag are skipped, apart from the compact records below.
- A last line without its `\n` is a write cut short by a crash. clodent prints `clodent: <path>: ignoring a truncated last line` right after the `[clodent:session]` line; when resuming in place, it cuts the file back to its last complete line before appending.
- Any other line that is not a JSON object, or a user or assistant record that would be replayed but has no `message.content` array, prints `clodent: <path>: line <n> is not valid JSON`, `… is not a record` or `… has no message content` and exits 2.
- A `system` record with `subtype: "compact_boundary"` empties the history built so far, and a user record with `isCompactSummary: true` is replayed even though it is `isVisibleInTranscriptOnly`. `--resume` and `--fork-session` of a compacted session therefore start from the summary message, its reloaded file blocks included as recorded (the files are not re-read); `--fork-session` still copies every record.
- When the last user record is the interrupt record, the next prompt goes to the API prefixed with the text block `[clodent: previous turn interrupted by the user]`, as it would have in the interrupted run.
- When the history ends in an assistant record with `tool_use` blocks and no results (clodent was killed while a tool ran), the next turn first writes a tool results record giving each of them the error result `interrupted by user`, then the prompt, prefixed with that same text block.

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
| `version` | clodent's version |
| `entrypoint` | `clodent` |
| `userType` | `external` |
| `gitBranch` | the working directory's git branch: from `.git/HEAD` at the git root (a `.git` file's `gitdir:` is followed, as in a worktree), `ref: refs/heads/<b>` gives `<b>`, any other HEAD gives `HEAD`, and no repository or an unreadable HEAD gives `""`. Read without a subprocess at session start and again before the first record of each turn |

Record kinds, in the order a turn writes them:

| kind | fields besides the common ones |
|---|---|
| prompt | `type: "user"`, `message: {role: "user", content: [text blocks]}`: the `[clodent: previous turn interrupted by the user]` block after an interrupted turn, then any `SessionStart` context block, the prompt, then any `UserPromptSubmit` context block (see [Hooks](#hooks)) |
| assistant | `type: "assistant"`, `message` (the API message: `id`, `model`, `role`, `content`, `stop_reason`, `stop_sequence`, `usage` as the API reported it), `requestId` (the `request-id` response header, or null), `costUsd` (this request's cost; 0 for an unpriced model), `durationMs` (this request's duration in whole milliseconds). A response with empty content is recorded too. |
| tool results | `type: "user"`, `message: {role: "user", content: [tool_result blocks, then any PostToolUse and PostToolUseFailure context blocks]}`, `toolUseResult: {name, isError, input}` describing the first block; `input` is the input the tool ran with, after any hook `updatedInput` |
| partial assistant | `type: "assistant"`, `message: {role: "assistant", content: [the completed text blocks], stop_reason: null}`; written on an interrupt that kept text |
| interrupt | `type: "user"`, `message: {role: "user", content: [{type: "text", text: "[Request interrupted by user]"}]}`, `isVisibleInTranscriptOnly: true`; no `isMeta` |
| compact boundary | `type: "system"`, `subtype: "compact_boundary"`, `content: "Conversation compacted"`, `level: "info"`, `parentUuid: null`, `logicalParentUuid` (the previous record's `uuid`), `compactMetadata: {trigger, preTokens, postTokens, reloadedFiles}`, where `reloadedFiles` lists the absolute paths of the files reloaded into the summary message (`[]` when none); written by `/compact` (see [REPL](#repl) or [Stream JSON](#stream-json) stdin), outside any turn |
| compact summary | `type: "user"`, `message: {role: "user", content: [{type: "text", text: "This session continues an earlier conversation that was compacted. Summary of it:\n\n<summary>"}, then one text block per reloaded file]}`, exactly the history's new message (see [REPL](#repl)), `isVisibleInTranscriptOnly: true`, `isCompactSummary: true`; right after the boundary. The summary request's own response is not recorded |
| turn end | `type: "system"`, `subtype: "turn_duration"`, `durationMs` (the turn's duration in whole milliseconds), `messageCount` (the user and assistant records written since the previous `turn_duration` record, the interrupt record included and the compact records not); after the turn's last record |

A turn the model ended has `stop_reason: "end_turn"` on its last assistant record.

### Settings

clodent loads settings before anything else runs, in `-p` and the REPL alike. The file shape follows the settings files Clodex writes for Claude Code, so those load unchanged.

Sources, in this order:

1. `<CLODENT_HOME>/settings.json`, where `CLODENT_HOME` defaults to `~/.clodent`. A missing file counts as empty.
2. Each `--settings <file>`, in argv order; a relative path resolves against the working directory. A missing one is an error: `settings file not found: <path>`.

A file that is not valid JSON, or whose top level is not an object, is an error: `invalid settings file <path>: <reason>`. Any other read failure is `cannot read settings file <path>: <reason>`. A malformed permission rule list, a malformed `sandbox` block under `enabled: true`, a `compactReloadFiles` value that is not an integer from 0 to 20, and a malformed `hookContextMaxBytes` are errors too, `settings <path>: <message>` (see [Permission rules](#permission-rules)). An error prints `clodent: <error>` and exits 2 before any request.

Honored keys and how they merge across sources; later sources win unless the row says otherwise:

| key | merge |
|---|---|
| `hooks` | per event name, the matcher-group arrays are concatenated in source order |
| `statusLine` | `{"type": "command", "command": "<cmd>"}`; the last one wins |
| `env` | shallow merge of string values; a non-string value is dropped with a warning. Laid over the process environment for the API key, `ANTHROPIC_BASE_URL`, tools and hooks (see [Environment](#environment)) |
| `trustedDirectories`, `permissions.additionalDirectories` | concatenated in source order (within a file, `trustedDirectories` first) and deduplicated, as one list of extra directories; listed in the system prompt after the `--add-dir` paths |
| `effortLevel` | `low`, `medium`, `high`, `xhigh` or `max`; the last valid one wins; any other value is ignored with a warning. The effort when `--effort` is absent |
| `cacheTtl` | `5m` or `1h`; the last valid one wins; any other value is ignored with a warning. The cache TTL when `--cache-ttl` is absent |
| `model` | the last one wins, less one trailing bracketed suffix such as `[1m]`. The model when `--model` is absent |
| `compactReloadFiles` | an integer from 0 to 20, default 5; the last one wins; any other value is an error, `compactReloadFiles <value> is not an integer from 0 to 20`. How many files `/compact` re-reads into the summary message (see [REPL](#repl)); 0 turns the reload off, and so does a bare-name `Read` deny, which removes the `Read` tool |
| `hookContextMaxBytes` | an object with `perHook` and `perEvent`, each optional, an integer from 1024 to 16777216; defaults `65536` and `262144`. Each key merges on its own: the last source that sets it wins. A value that is not an object is an error, `hookContextMaxBytes <value> is not an object {perHook, perEvent}`; any other key, `hookContextMaxBytes.<key> is not perHook or perEvent`; a bad number, `hookContextMaxBytes.<key> <value> is not an integer from 1024 to 16777216`. The caps on hook context, in UTF-8 bytes (see [Hooks](#hooks)) |
| `permissions.deny`, `permissions.ask` | rule lists, concatenated in source order; see [Permission rules](#permission-rules). A malformed list or rule is an error |
| `sandbox` | per source, with `enabled: true`: `filesystem.denyRead`, `filesystem.denyWrite` and `credentials.files` become deny rules and `credentials.envVars` names leave the environment of the Bash tool, Grep and Glob's git calls, hooks and the statusLine command, joined across sources; see [Permission rules](#permission-rules). Without `enabled: true` the block is ignored silently |

Every other key, such as `voice`, `voiceEnabled`, `skillOverrides`, `permissions.allow` or `permissions.defaultMode`, is ignored silently. A malformed value of an honored key is dropped with a warning `settings <path>: <what was dropped>`, and loading continues. A hook entry whose `type` is not `"command"` is dropped with such a warning.

### Permission rules

`permissions.deny` and `permissions.ask` in settings hold rules in Claude Code's syntax, so the lists Clodex writes for a seat load unchanged. clodent enforces them on its six tools; `permissions.allow` and `permissions.defaultMode` are ignored.

A rule is `Tool` or `Tool(specifier)`:

| rule | matches |
|---|---|
| `Read`, `Write`, `Edit`, `Bash`, `Grep` or `Glob`, bare | every call of that tool |
| `Read(<path>)` | `Read` (`file_path`), `Edit` (`file_path`, since an edit reveals the file), `Grep` and `Glob` (`path`, default the working directory); a `Bash` command that mentions the path |
| `Edit(<path>)` | `Edit` and `Write` (`file_path`); a `Bash` command that mentions the path, unless it is read-only |
| `Write(<path>)` | `Write` (`file_path`); a `Bash` command that mentions the path, unless it is read-only |
| `Grep(<path>)`, `Glob(<path>)` | that tool's `path` |
| `Bash(<command>)` | a `Bash` command, see below |
| any other name, bare or with a specifier (`WebFetch`, `Agent(x)`, `mcp__…`, `NotebookEdit`, `Skill`, …) | nothing; ignored silently |

Names are case-sensitive. A name that differs from a clodent tool name only in letter case or by a space before `(` (`read(x)`, `Read (x)`, `BASH`) is a startup error. A path specifier expands to an absolute pattern:

- `//abs/path` is `/abs/path`.
- `~/p` is `$HOME/p` and `~` is `$HOME`, from the `HOME` environment variable, else the OS home directory.
- `/p` is relative to the directory of the settings file that holds the rule.
- `./p` and a bare `p` are relative to the directory clodent started in.

In a pattern, `*` matches within one path segment and `**` matches zero or more segments; every other character, a space included, is literal. A rule matches a path when it matches the path itself or any ancestor directory, so `Read(~/.ssh)` also matches `~/.ssh/id_rsa`, and `X/**` also matches `X`.

A file tool's path is checked twice, lexically (resolved against the working directory) and after `realpath`, of the path or, when it does not exist, of its deepest existing ancestor with the rest appended. The call matches when either check does, so a symlink into a denied directory is denied too. On macOS, a path that starts with `/System/Volumes/Data/` is also checked, in both checks, with that prefix removed, and a rule whose pattern starts with it also matches the pattern without it.

A rule's leading part, up to its first segment with a `*`, is resolved with `realpath` once, on the first check, the same way. When that changes it (on macOS `/etc` is `/private/etc` and `/tmp` is `/private/tmp`; `$HOME` may sit under a symlink), the rule matches both forms, in file tools, in `Grep` and `Glob` listings and in `Bash` mentions.

`Grep` and `Glob` also drop every file they would list or search that a deny rule for that tool matches, or an ask rule unless the mode is `--yolo`, without a message and without asking. When the REPL asks for the call itself and the user allows it, the ask rules that match the call's `path` hide nothing in that call. Each file is checked on its path under the searched directory and on the same path under the directory's realpath. A listed entry that is a symlink is also checked on its realpath; no other entry is resolved.

`Bash` rules are a best-effort string guard on the command text, not a sandbox:

- `Bash(<prefix>:*)` matches a command whose trimmed text is `<prefix>` or starts with `<prefix>` followed by whitespace. `Bash(<text>)` without `*` matches that exact trimmed text, and any other `*` in the specifier matches any run of characters over the whole text.
- Each rule is tried on the whole trimmed text and on each simple command in it, split at `;`, `&&`, `||`, `|`, `&`, a newline, `(`, `)` and a backtick outside quotes, also inside a `$(…)` or backtick within double quotes, with a `#` that starts a word commenting out the rest of the line. So `Bash(git push:*)` matches `git push origin` and `ls && git push`, but not `git pushx`.
- A command mentions a path rule when its text, with `\ ` read as a space, contains the rule's pattern, in any letter case, with each `*` or `**` standing for a run of characters other than whitespace and quotes. The mention may start anywhere in the text, so `cat ~/.SSH/id_rsa` and `cat /System/Volumes/Data/Users/<u>/.ssh/id_rsa` both mention `Read(~/.ssh)`. The mention must end at the end of the text or before whitespace, a quote, `;`, `|`, `&`, `<`, `>`, `)`, a backtick or `/`, so a rule for `~/.zshrc` does not match `~/.zshrc.bak`. A pattern under `$HOME` is also found written with `~/`, `$HOME/` or `${HOME}/` in place of the home directory.
- A command also mentions a path rule when one of its words matches the rule the way a file tool's path does, without the `realpath` check of the word. The words are split at blanks, `;`, `&`, `|`, `(`, `)`, `<`, `>`, a newline, `$(` and a backtick, so a redirection target is a word too, and a `#` comment gives no words; quotes and backslashes are removed as bash removes them, `$'…'` is decoded as bash decodes it (`\n`, `\t`, `\xHH`, `\NNN` octal, `\uHHHH` and the other escapes, dropping the rest of the quote after a NUL) and `$"…"` reads as `"…"`; a leading `~`, `$HOME` or `${HOME}` followed by `/` or the end of the word becomes the home directory, a leading `~+` or `~0` (also `~+0` or `~-0`, each with any number of zeros) followed by `/` or the end of the word becomes the working directory, and any other leading `~<name>` becomes `<name>` in the home directory's parent; and the word is resolved against the working directory, which collapses `//`, `/./` and `x/..`. A word with an `=` is also tried on the text after its first `=`, as in `--file=<path>`. The match is in any letter case, and a word under `/System/Volumes/Data/` is also tried without that prefix. So `cat ~//.ssh/id_rsa`, `cat ~/x/../.ssh/id_rsa`, `cat ~/'.ssh'/id_rsa`, `cat ~/$'\x2essh'/id_rsa`, `tail -n+1 ~//.ssh/*`, with the home directory `/Users/<u>`, `cat ~<u>/.ssh/id_rsa` and, in the home directory, `cat .ssh/id_rsa` all mention `Read(~/.ssh)`, and `echo x >> ~/./.bashrc` mentions `Edit(~/.bashrc)`.
- A command also mentions a path rule when a word, expanded as bash expands it, matches the rule the same way. Braces expand first, comma lists and `{a..b}` sequences. Then a leading `~`, `$HOME` or `${HOME}` expands as above, `$PWD` and `${PWD}` become each directory the word is resolved against (see `cd` below), and `$USER`, `$LOGNAME`, `$TMPDIR`, `$SHELL` and `$PATH` come from the Bash tool's environment, empty when unset. A `${…}` with an operator after the name, as in `${OLDPWD%/}`, has an unknown value, and the word after `:-`, `:=`, `:+`, `-`, `=` or `+` is also tried in its place, so `cat ${X:-~/.ssh}/id_rsa` mentions `Read(~/.ssh)`. Then a word with an unquoted `*`, `?` or `[…]` is matched on disk segment by segment, as bash matches it without `globstar`: a leading `.` matches only a written `.` (also any pattern once the command runs `shopt` with `dotglob` or has a `GLOBIGNORE=` word anywhere), `.*` also matches `.` and `..` as bash 3.2 does, a word that matches nothing stays literal, and each match is checked. A quoted or backslash-escaped `*`, `?`, `[`, `{`, `}` or `,` is literal, as is a backslash-escaped `$` and a single-quoted `$` not followed by `{`; a single-quoted `${…}` reads as a variable. So `cat ~/.ss[h]/id_rsa`, `cat ~/.{ssh,x}/id_rsa` and `cat ~/.s*/id_rsa` mention `Read(~/.ssh)`, and `cat ~/notes/{a,b}.txt` does not.
- `cd <dir>` and `pushd <dir>`, as a simple command anywhere in the command, also after an assignment, `builtin`, `command`, `time`, `!`, `{` or a keyword such as `if` or `do`, add `<dir>`, expanded as above against each directory added before it and looked up through `CDPATH` from the Bash tool's environment, to the directories relative words are resolved against. A `CDPATH=` word in the same or an earlier simple command (`CDPATH=/x cd y`, `export CDPATH=/x; cd y`) also makes each later `<dir>` that is not `.` or `..` and does not start with `/`, `./` or `../` weakly uncertain. The working directory and each earlier directory stay in that set, since a `cd` can fail or run in a subshell or a pipe, and each directory known for certain holds for every word of the command, also one before the `cd`. An uncertain directory, such as the one `cd -` adds (see below), holds only for the words of the simple commands after the one that added it. When the command has a `do`, `while` or `until` loop or a `trap`, whose body may run after a later `cd`, an uncertain directory holds for every word. A `cd` inside a loop, in a `while` or `until` condition or between a `do` and its matching `done`, ignores order up to the outermost loop's `done`: its `<dir>` is resolved again against every directory added before that `done` but those that `cd` was the first in the command to add, until the set stops growing, and a `CDPATH=` word before that `done` applies to it. Inside a loop, a directory reached by a repeated `cd` counts only if it exists. A `cd` outside a loop, also in a command with a `trap`, keeps the order above. `cd` alone adds the home directory. So `cd ~ && cat .ssh/id_rsa` mentions `Read(~/.ssh)` from any directory, and `for i in 1 2; do cd .ssh; cat id_rsa; cd ~; done` mentions `Read(~/.ssh/id_rsa)`.
- A word the guard cannot resolve is uncertain. It is strongly uncertain through `$OLDPWD`, also with an operator, through `$PWD` resolved against an uncertain directory, `~-` or `~<n>`, over 1024 brace expansions, a glob that reads over 10 000 directory entries, or as a relative word after `cd -`, after a `cd` to a strongly uncertain directory, or once the set holds 64 directories. It is weakly uncertain through any other variable, or any other `${…}` with an operator, or as a relative word after a `cd` to such a word. A command name without a `/`, which the shell looks up in `PATH`, a `builtin`, `command`, `time`, `!`, `{` or keyword before it, and an option word, starting with `-` and without `=`, are never resolved against an uncertain directory; an operand is. An uncertain part that may be `..` (`.$X.`), or a `..` after an uncertain part, leaves no part of the word certain. An uncertain word matches a rule when the rule's leading part, up to its first segment with a `*`, could still match it, segment by segment in any letter case, a glob part not starting with `.` matching no part that starts with `.` unless the command sets `dotglob` as above: an uncertain part stands for any rest that starts with the text written before it. The call then asks, for a deny rule as for an ask rule, as an ask rule match does; under `--yolo`, a strongly uncertain word that matches a deny rule is denied with that rule's reason followed by the doubt in parentheses, as in `denied by settings rule Read(~/.ssh) (/…/id_rsa may name a path Read(~/.ssh) guards)`. So `cat $OLDPWD/id_rsa`, `cd - && cat id_rsa` and `cd - && git status` ask under `Read(~/.ssh)` and are denied under `--yolo`, `cd src && make; cd -` and `cd - && make` do not ask, `cat ~/.s$X/id_rsa` asks and runs under `--yolo`, and `cat ~/notes/$X` does not ask.
- A recursive content search matches a `Read` rule whose leading part is one of its roots or under one: `grep`, `egrep` or `fgrep` with `-r`, `-R`, `--recursive`, `--dereference-recursive`, `-d recurse` or `--directories=recurse`, `rg`, and `diff -r` or `--recursive`, each also after `env` with its `NAME=value` words, `nice`, `nohup`, `timeout` with its duration, `stdbuf` or `xargs`, past their options and the values of those that take one. Its roots are its operands after the pattern, past the values of the short options that take one; every operand is a root when `-e` or `-f` gives the pattern, for `diff`, and for a `grep` or `rg` with a long option without `=`. Each directory of the set above is a root too when no operand is left, or for that long option. It asks like a strongly uncertain word, or like a weakly uncertain one for a root that is. So `grep -r KEY ~` and `timeout 10 grep -r KEY ~` ask under `Read(~/.ssh)` and are denied under `--yolo`, the doubt reading `grep searches /Users/<u> recursively, which may read files Read(~/.ssh) guards; the Grep tool skips denied files`. `find`, `ls -R`, `tree` and `du` list names, not contents, and match only by their words.
- A command that mentions a `Read` rule matches it. One that mentions an `Edit` or `Write` rule matches it unless it is read-only by the rules of [Read-only Bash](#read-only-bash): `cat ~/.clodex/messages/x` passes an `Edit` rule for that directory, `rm ~/.clodex/messages/x` does not.
- It cannot see a path a program builds itself, from a file's contents, in a script or through an alias; a path assembled from variables other than those above, though a literal assignment such as `X=~/.ssh` is itself a mention; a variable whose value holds `..`; nor a symlink the command names, since no word is resolved with `realpath`.
- Each rule is also tried on a conservative reading of the command, which drops quotes and backslashes and splits commands at every `;`, `&`, `|`, newline, `(`, `)`, backtick and `#`, and words also at blanks, `<` and `>`. A rule that matches only there may apply to a command the guard could not parse with certainty, so it asks, and a deny rule denies under `--yolo`, its reason followed by `, which may apply to a command that could not be parsed with certainty`.

Deny rules come first: a call a deny rule matches, other than only through an uncertain word, a recursive search or the conservative reading above, is refused in every mode, `--yolo` included, whatever a `PreToolUse` hook decided apart from its own `deny`, and without an ask, so an interactive `y` never runs it. The model gets `denied by settings rule <rule as written>`, or `denied by built-in rule <rule>` for a built-in deny rule, as an error tool result, and the turn goes on. A call an ask rule matches asks in the REPL's default and `acceptEdits` modes, as a write tool does in the default mode (see [REPL](#repl)), even a read tool's call or one a hook allowed; `-p` and `--read-only` refuse it with `permission required: run clodent without -p to approve it, or pass --yolo`, and `--yolo` runs it. See [Hooks](#hooks) for the full order.

A bare-name deny of a clodent tool also removes the tool from the request's `tools`, so a call of it is an unknown tool (`unknown tool <name>`), and clodent's own system prompt does not name it.

Limits:

- The `Bash` guard reads the command text and directory listings only. It guards against accidental reads, not against a model under `--yolo`, which can read a denied path through a script or a path assembled from variables.
- A hard link to a denied file is not detected.
- The per-file check in `Grep` and `Glob` listings is lexical, except for entries that are symlinks.
- The text checks of [Read-only Bash](#read-only-bash) and the path checks of `acceptEdits` do not resolve symlinks, so a symlink into `/proc`, into a `.git` directory or out of the working directory gets past them.

Startup errors: each of these prints `clodent: settings <path>: <message>` and exits 2, before the `[clodent:session]` line, any hook, any request and the first `\x1b[?2004h`:

- `permissions` that is not an object: `permissions is not an object`.
- `deny` or `ask` that is not an array: `permissions.<list> is not an array`; an entry that is not a string: `permissions.<list>[<i>] is not a string`.
- A malformed rule, `permissions.<list>[<i>] "<rule>": <reason>`, where the reason is `unbalanced parenthesis`, `text after the closing parenthesis`, `no tool name`, `tool name "<name>" is not exactly <Tool>`, `empty () on <Tool>` (for a clodent tool only), or `the path expands to nothing (HOME is not set)`.
- A malformed `sandbox` block under `enabled: true`, see below.

Rules from `--disallowedTools` (see [Flags](#flags)) join the deny list after the settings ones and act exactly as they do.

Built-in deny rules join the deny list last, in every mode, `--yolo` included, and act exactly as the others do: `Read(//<file>)` and `Edit(//<file>)` for each settings file clodent loaded, by absolute path, which is `$CLODENT_HOME/settings.json` (whether or not it exists) and each `--settings` file, then `Read(//proc/*/environ)` and `Read(//proc/*/task/*/environ)`. So `Read`, `Edit`, `Write`, `Grep` and `Glob` of a settings file are refused, as is a `Bash` command that mentions one (`cat ~//.clodent/settings.json`, `cat ~/.clodent/*.json`) or mentions `/proc/<pid>/environ` (`cat /proc/$PPID/environ`); a recursive search of a directory above one (`grep -r KEY ~`) asks, and is denied under `--yolo`. They are path rules, so they never remove a tool from the request's `tools` or the system prompt. A call one of them matches gets, for example, `denied by built-in rule Read(//Users/<u>/.clodent/settings.json)`.

Sandbox block: clodent does not sandbox Bash. A settings source with `sandbox.enabled: true` has its block enforced as deny rules instead, after that source's `permissions.deny`:

- Each `filesystem.denyRead` path becomes a `Read(<path>)` rule and each `filesystem.denyWrite` path an `Edit(<path>)` rule. Each `credentials.files` entry `{path, mode: "deny"}` becomes both.
- A path `/abs` becomes `//abs`, `~` and `~/x` stay home-relative, and any other path is relative to the working directory; `*` and `**` work as above.
- Each `credentials.envVars` entry `{name, mode: "deny"}` removes that variable from the environment of the Bash tool's commands, of Grep and Glob's git calls, and of hooks and the statusLine command, as clodent always does with `ANTHROPIC_API_KEY` (see [Tools](#tools) and [Hooks](#hooks)). clodent's own process keeps it. A Bash command that mentions `/proc/<pid>/environ` is denied by a built-in rule (see above), but a command can still read clodent's startup environment in other ways, for example with `ps eww $PPID` on macOS, so a credential that must stay hidden must not be in clodent's environment at all.
- A `credentials` entry whose `mode` is not `"deny"` is ignored with the warning `settings <path>: sandbox: ignored entry <entry as JSON>`.
- Every other key (`allowWrite`, `network`, `allowUnsandboxedCommands`, `excludedCommands`, …) is ignored. Every source with `enabled: true` prints one warning, `settings <path>: sandbox: clodent does not sandbox Bash; filesystem and credentials entries are enforced as permission rules, other keys ignored`.
- These rules are path rules: they never remove a tool from the request's `tools` or the system prompt.
- Startup errors, `clodent: settings <path>: <message>` and exit 2 as above: `sandbox.<filesystem|credentials> is not an object`; `sandbox.<section>.<list> is not an array`; `sandbox.filesystem.<list>[<i>] is not a string`; `sandbox.credentials.<list>[<i>] is not an object`; `sandbox.credentials.files[<i>].path` or `sandbox.credentials.envVars[<i>].name is not a string`; and `sandbox.filesystem.<list>[<i>]` or `sandbox.credentials.files[<i>].path` followed by `"<path>": <reason>` for a path the rule parser refuses.

### Hooks

`-p` and the REPL run the hooks and the statusLine command from the loaded settings. They follow the Claude Code hook convention, so hook scripts written for Claude Code run unchanged.

Shape, under `hooks` in settings:

```json
{ "<Event>": [ { "matcher": "<regex>", "hooks": [ { "type": "command", "command": "<cmd>", "timeout": 15, "onFailure": "block" } ] } ] }
```

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `PreCompact`, `Stop`. Other event names in settings are kept but never fire. The Claude Code events `SubagentStart`, `SubagentStop`, `SessionEnd` and `PermissionRequest` load silently; any other name adds the startup warning `settings <path>: hooks.<name> is not a known event; it never fires`.

`onFailure` is `"block"` or `"warn"` (the default). Any other value adds the startup warning `settings <path>: hooks.<Event>[<i>].hooks[<j>].onFailure <value as JSON> is not "block" or "warn"; treated as "warn"` and counts as `"warn"`.

When each event fires:

| event | fires |
|---|---|
| `SessionStart` | once, after the `[clodent:session]` line and before the prompt: `source` is `resume` with `--resume`, else `startup`; from the REPL or a stream-json slash command, again after `/clear` with `source` `clear`, and after a successful `/compact` with `source` `compact` |
| `UserPromptSubmit` | before the prompt joins the history |
| `PreToolUse` | before each call of a known tool, before the permission decision, and before each `/compact` file reload, which fires no other hook (see [REPL](#repl)); a call of an unknown tool fires no hook |
| `PostToolUse` | after a tool that ran returns a result that is not an error |
| `PostToolUseFailure` | instead of `PostToolUse`, when that result is an error; a refused call never ran, so neither fires |
| `Stop` | once at the end of the turn, after the `turn_duration` record; its output is ignored apart from warnings |
| `Notification` | when a tool call waits for a permission answer: in the REPL after the `[clodent:permit]` line and `Allow? [y/n] `, while the ask is listening (see [REPL](#repl)); in [Stream JSON](#stream-json) with `--permission-prompt-tool stdio`, after the `can_use_tool` `control_request` line, while it waits for the reply |
| `PreCompact` | from the REPL or a stream-json slash command, at `/compact` on a non-empty history, before the summary request; its output is ignored apart from warnings |

`permission_mode` names the mode as Claude Code does: `default` (the default ask mode), `bypassPermissions` (`--yolo`, `--dangerously-skip-permissions`), `plan` (`--read-only`) or `acceptEdits`; `--permission-mode <mode>` gives `<mode>`.

The permission decision for a tool call goes in this order:

1. A hook `deny` wins: the call does not run and the model gets the hook's reason as an error tool result.
2. A settings deny rule refuses the call in every mode, `--yolo` included, unless it matches only through an uncertain word, a recursive search or the conservative reading (see [Permission rules](#permission-rules)): then the call asks as in step 3, and under `--yolo` it is refused unless the match is only weakly uncertain. A hook `allow` does not override it.
3. A settings ask rule or a hook `ask` asks in the REPL's default and `acceptEdits` modes, for read tools too; `-p` and `--read-only` refuse the call instead, and `--yolo` runs it. A hook `allow` does not skip the ask.
4. `--read-only` refuses write tools and any Bash command that is not read-only; a hook `allow` does not override it.
5. A hook `allow` runs the call without the default or `acceptEdits` mode's ask or refusal.
6. No hook decision leaves it to the mode (see [Print mode](#print-mode)); in the REPL the default and `acceptEdits` modes ask (see [REPL](#repl)).

A hook `updatedInput` replaces the input before the decision and the run, and the `tool_use` event and the `● <Tool> <summary>` line show it. The history sent to the API keeps the model's own `tool_use` block; the transcript's `toolUseResult.input` records the input that ran.

Context, from `additionalContext` or plain stdout (see Results below), reaches the model as one text block per event:

```
<hook-context event="<Event>">
<texts joined by a blank line>
</hook-context>
```

- `SessionStart` context is held and goes into the next user message, before the prompt text and after the `[clodent: previous turn interrupted by the user]` block when that is present. A `SessionStart` that fires again before that prompt, such as after a second `/compact`, replaces the held context.
- `UserPromptSubmit` context goes right after the prompt text.
- `PostToolUse` and `PostToolUseFailure` context goes after every `tool_result` block of that tool round's user message, one block per event in that order, since the API needs the `tool_result` blocks first.
- `PreToolUse`, `PreCompact` and `Stop` context is dropped. No hook can block a prompt or a compact.

Inside each text, every `<hook-context` and `</hook-context`, in any letter case, is written with `&lt;` for its `<`, so a hook cannot close the frame or open another event's.

The context of `SessionStart`, `UserPromptSubmit`, `PostToolUse` and `PostToolUseFailure`, the events whose context reaches the model, is capped in UTF-8 bytes by the settings `hookContextMaxBytes` (see [Settings](#settings)); any other event's context is not cut and adds no warning:

- `perHook` (default 65536): one command's context over it is cut to its first and last bytes around the line `[clodent: hook context of <bytes> bytes truncated to <limit>]`; a cut never splits a character.
- `perEvent` (default 262144): after the per-command cuts, the texts of one firing joined by a blank line, when over it, are cut the same way into one text. `SessionStart` is exempt from `perEvent`, not from `perHook`.
- Each cut adds a warning, `hook <Event> "<first 60 code points of the command>": context of <bytes> bytes truncated to <limit>` for a command and `hook <Event>: context of <bytes> bytes truncated to <limit>` for a firing; [Stream JSON](#stream-json) also writes it to stdout as a `hook_context_truncated` record.

Hook warnings print as `clodent: <warning>` lines. Hooks get the turn's interrupt: a signal kills running hooks, and a hook that would start after it does not run. `Stop` runs even after an interrupt, under its own abort: a second SIGTERM or SIGHUP kills it (in `-p`, any second signal).

Matchers:

- A missing, `""` or `"*"` matcher matches every firing of the event.
- For `PreToolUse`, `PostToolUse` and `PostToolUseFailure` the matcher is a JavaScript regular expression tested whole against `tool_name`, as `^(?:<matcher>)$`: `Bash` does not match `BashOutput`, and `Agent|Task` matches `Task`.
- For `SessionStart` it is tested the same way against `source`, and for `PreCompact` against `trigger`.
- Every other event ignores the matcher.
- An invalid regular expression never matches and adds the warning `hook <Event> matcher "<matcher>": invalid regex; never matches`.

stdin is one JSON object followed by a newline, then closed. Every event sends `session_id`, `transcript_path`, `cwd`, `hook_event_name` and `permission_mode`, plus:

| event | extra fields |
|---|---|
| `SessionStart` | `source`: `startup`, `resume`, `clear` or `compact`; `model`: the session's model id |
| `UserPromptSubmit` | `prompt` |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id`; for a `/compact` file reload, `tool_name` `Read`, `tool_input` `{"file_path": "<absolute path>"}` and `tool_use_id` `compact-reload-<n>`, where `<n>` is the file's place in the reload list, from 1 |
| `PostToolUse` | `tool_name`, `tool_input` (the input that ran), `tool_use_id`, `tool_response`: `{content, isError}` |
| `PostToolUseFailure` | the `PostToolUse` fields, and `error`: the result text |
| `Notification` | a permission prompt sends `notification_type: "permission_prompt"`, `title: "Permission needed"`, `message: "clodent needs your permission to use <Tool>"`, `tool` and `id` |
| `PreCompact` | `trigger`: `manual`; `custom_instructions`: the `/compact` instructions, or `""` |
| `Stop` | `stop_hook_active`: `false` |

`agent_id` is never sent.

Running:

- Each matched command runs as `bash -c <command>` in the working directory, in its own process group. Its environment is clodent's, then the settings `env` on top, less `ANTHROPIC_API_KEY` and each deny `credentials.envVars` name (see [Permission rules](#permission-rules)), also when the settings `env` sets them, then `CLODENT_PROJECT_DIR` set to the working directory.
- In the context, deny reasons and warnings a firing returns, the value of `ANTHROPIC_API_KEY` and of each deny `credentials.envVars` name, read from that environment before the names are removed, is replaced with `[redacted]` when it is 8 or more characters long.
- A hook that runs a file the model can write gives the model that hook's power: `acceptEdits` asks before a `Write` or `Edit` to a file any word of a hook or statusLine command names (see [Read-only Bash](#read-only-bash)), but not to a script that file calls in turn.
- All matched commands of one firing run at the same time. Their results combine in config order (source order, then group order, then entry order), not in the order they finish.
- A command string matched more than once in one firing runs once, at its first config position, with the longest of the entries' timeouts (an unset `timeout` counts as the default) and with `onFailure: "block"` when any of the entries sets it.
- `timeout` is in seconds, default 60. On expiry, or when the turn is interrupted, the process group gets SIGTERM, then SIGKILL 2 s later.
- stdout is read up to 1 MiB and stderr up to 64 KiB; the rest is discarded. Cut stdout adds the warning `stdout over 1 MiB truncated`.

Results, per command:

- Exit 0 with stdout that is a JSON object: clodent reads `hookSpecificOutput.additionalContext` (a string, added to the model's context) on every event. On `PreToolUse` only it also reads `hookSpecificOutput.permissionDecision` (`allow`, `deny` or `ask`), `hookSpecificOutput.permissionDecisionReason` and `hookSpecificOutput.updatedInput` (an object that replaces the tool input); a `permissionDecision` other than those three, compared case-sensitively, and other than `null`, is ignored with the warning `unknown permissionDecision <value as JSON> ignored`, showing only the first 60 code points of that JSON, redacted as above in each string before it is written and in the result, or under `"onFailure": "block"` is a failure (below); and a top-level `"decision": "block"`, Claude's older shape, is a deny whatever `permissionDecision` says, with the top-level `reason` as its reason (`blocked by hook` when that is missing or empty), unless `permissionDecision` is already `deny`, which keeps its `permissionDecisionReason` (`blocked by hook` when that is missing or empty); `"decision": "approve"` is ignored.
- Exit 0 with non-empty stdout that is not a JSON object: on `SessionStart` and `UserPromptSubmit` the text, without trailing whitespace, is added as context. On any other event it is ignored with the warning `invalid JSON ignored`; on `PreToolUse` it is also a failure (below).
- Exit 2: on `PreToolUse` the tool call is denied, with stderr (trimmed) as the reason, or `blocked by hook` when stderr is empty. On any other event it is a warning.
- Any other exit code, death by a signal, a timeout or a failure to start is a failure; on `PreToolUse`, so is exit 0 with stdout cut at 1 MiB, or non-empty and not a JSON object. On `PreToolUse`, an entry with `"onFailure": "block"` turns a failure into a deny with the reason `hook failed: <exit <n>|timeout|aborted|killed by <signal>|<error message>|stdout over 1 MiB truncated|invalid JSON|unknown permissionDecision <value as JSON>>`, with `<value as JSON>` cut to its first 60 characters as above. Otherwise a failure is a warning (for those exit-0 cases, the warnings above) and the turn continues. Only `PreToolUse` can block.

Combining: a deny beats an ask, and an ask beats an allow. The reason comes from the first command, in config order, that gave the winning decision; a JSON deny without a reason reads `blocked by hook`. The last `updatedInput` in config order wins. Context strings keep config order, and empty or whitespace-only ones are dropped.

Warnings are one line each:

```
hook <Event> "<first 60 code points of the command>": <exit <n>|timeout|aborted|killed by <signal>|<error message>|invalid JSON ignored|stdout over 1 MiB truncated|unknown permissionDecision <value as JSON> ignored|context of <bytes> bytes truncated to <limit>>
hook <Event>: context of <bytes> bytes truncated to <limit>
```

statusLine: after each API response other than a compact's summary request, and from the REPL or a stream-json slash command after `/clear` and a successful `/compact` (see [REPL](#repl) and [Stream JSON](#stream-json)), clodent runs the `statusLine` command the same way, with a 5 s timeout, and this JSON on stdin:

```json
{
  "session_id": "<uuid>",
  "transcript_path": "<path>",
  "cwd": "<working directory>",
  "version": "<clodent version>",
  "model": { "id": "<model id>", "display_name": "<model id>" },
  "workspace": { "current_dir": "<working directory>" },
  "context_window": { "used_tokens": 0, "total_input_tokens": 0, "context_window_size": 200000, "used_percentage": 0 },
  "cost": { "total_cost_usd": 0 }
}
```

- `used_tokens` is that response's `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`, and `total_input_tokens` the same sum without `output_tokens`.
- `model.id` is the session's model, and `cost.total_cost_usd` the session's cost so far, this response included.
- `context_window_size` is 200000 for every model.
- `used_percentage` is `used_tokens` over `context_window_size`, as a number from 0 to 100 with at most one decimal.
- At most one statusLine command runs at a time. An update that arrives while one runs replaces any update already waiting, so only the latest runs next.
- stdout is discarded. The first failure prints one warning, `statusLine "<first 60 code points of the command>": <reason>`; later failures are silent.
- Before exit, clodent waits for the running statusLine command and the latest waiting update to finish.
