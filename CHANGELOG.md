# Changelog

clodent was named clay up to 0.2.0.

## Unreleased

- Security: in `acceptEdits`, a `Write` or `Edit` runs without asking only inside the working directory and the `--add-dir`/`trustedDirectories`/`additionalDirectories` dirs; it asks, or is refused under `-p`, for a path under `.git`, `.clodent` or `.claude` and for a file a hook or statusLine command names (avirtual/clodent #6, #7).

## 0.5.1 — 2026-11-04

Security release. Fixes from a cloud security review of 0.5.0 (avirtual/clodent issues #1–#5).

- Security: the REPL, and print mode's stderr lines, write each control byte in model text, tool summaries, tool errors, warnings and compact lines, other than newline and tab in streamed text, as a visible `\u00XX` escape, so a Bash summary can no longer forge the `[clodent:permit …]` line and streamed text can no longer send OSC 52 or turn bracketed paste off.
- Security: each `/compact` file reload fires `PreToolUse` as a model `Read` would (`tool_use_id` `compact-reload-<n>`); a hook deny or ask skips the file as `hook` without asking, and the fallback list leaves out `Read`, `Edit` and `Write` calls whose result was an error, so a file only a hook guards is no longer pulled into context.
- Security: a `PreToolUse` hook `ask` counts as a settings ask rule: the REPL asks, read tools included, `-p` and `--read-only` refuse, and `--yolo` runs the call; a top-level `"decision": "block"` is a deny with its `reason`, unless `permissionDecision` is already `deny`, which keeps its own reason, and `"approve"` is ignored.
- Security: on `PreToolUse`, stdout cut at 1 MiB, or non-empty and not a JSON object, is a hook failure, so an entry with `onFailure: "block"` denies the call.
- The `Files to reload:` parser skips blank lines after a bare heading, falls back to the history when the section is left empty and is not `none`, runs in linear time on long backtick or `*` runs, and reads `` `Files to reload:` `src/a.js` `` as `src/a.js` and `` `**Files to reload:**` none `` as `none`.
- Unlisted in 0.5.0, which added them with the reload: `compactMetadata.reloadedFiles` on the `compact_boundary` record, one text block per reloaded file after the summary in the `isCompactSummary` record, the `compacted` event's `message`, `reloaded` and `skipped` fields, the `clodent: reloaded <n> file(s) after compact: …` and `clodent: not reloaded <path>: <reason>` lines, and exit 2 for a `compactReloadFiles` that is not an integer from 0 to 20.
- The Bash permission guard also matches each word of a command with its quotes removed (`$'…'` decoded as bash decodes it, `$"…"` read as `"…"`), a leading `~`, `$HOME`, `${HOME}` or `~<user>` expanded, a leading `~+`, or `~0`, `~+0` or `~-0` with any number of zeros, read as the working directory, and the path resolved against the working directory (also after `=` and in redirections), so `~//.ssh`, `~/./.ssh`, `~/x/../.ssh`, `~/'.ssh'`, `~/$'\x2essh'`, `~<user>/.ssh`, `~+/../.ssh` from a directory in the home directory and relative spellings no longer slip past a `Read` or `Edit` rule.
- Built-in deny rules, in every mode including `--yolo`: `Read` and `Edit` of every settings file clodent loaded (`$CLODENT_HOME/settings.json`, whether or not it exists, and each `--settings` file) and `Read` of `/proc/*/environ` and `/proc/*/task/*/environ`; the model gets `denied by built-in rule <rule>`.
- The Bash tool's environment never contains `ANTHROPIC_API_KEY`, also when the key comes from settings `env`; requests, hooks and the statusLine still get it.
- Security: Grep and Glob run `git ls-files` and `git check-ignore` with an empty `-c core.fsmonitor=` and without `ANTHROPIC_API_KEY` or the deny `credentials.envVars` names in their environment, so a repository's `.git/config` can no longer make a read tool run a program.
- Security: read-only Bash no longer reads the environment or `/proc`. A variable outside `HOME`, `PWD`, `OLDPWD`, `USER`, `LOGNAME`, `SHELL`, `PATH` and `TMPDIR` (such as `$ANTHROPIC_API_KEY` or `$PPID`), any special parameter (`$1`, `$$`…), `jq` with `env`, `$ENV`, a module or a program file, a word that may reach `/proc` (globs, `..`, `cd /` and `/dev/fd/..` included, and a relative word that may reach it in a session started at `/`), a recursive `grep`, `rg` or `diff -r` that may start at `/`, and `sort`, `wc` or `du` with `--files0-from` now ask, or are refused under `-p` and `--read-only`; `wc` and `du` with a glob or an expansion in an argument ask too, as `sort` already did. Such a command that names a path under an `Edit` or `Write` deny rule is now refused in every mode, `--yolo` included.
- Security: `git status`, `diff`, `log`, `show`, `blame`, `grep`, `ls-files`, `cat-file`, `shortlog`, `rev-list` and `describe --dirty`/`--broken` are no longer read-only, since a repository or user config can make them run a program; one that names a path under an `Edit` or `Write` deny rule is now refused in every mode, `--yolo` included.
- Security: in `acceptEdits`, a `Write` or `Edit` inside a `.git` directory asks, or is refused under `-p`, instead of running.
- Security: the split of a Bash command into simple commands reads `$'…'` quoting as bash does, so an escaped quote inside it no longer hides the commands after it from a `Bash(<prefix>:*)` or exact rule.

## 0.5.0 — 2026-11-04

- `/compact` re-reads the files the summary names under `Files to reload:`, on that line or the lines after it (or else the last files read, edited or written), into the summary message, through the permission screen and within 64 KiB; a Markdown-wrapped heading and a backticked `none` are understood; the settings key `compactReloadFiles` (0–20, default 5) sets how many, and 0 or a bare `Read` deny turns it off.

## 0.4.0 — 2026-11-04

- Requests carry `metadata.user_id` = `{"session_id":"<id>"}` so a proxy such as wirescope can group requests by session.
- Requests carry a fourth cache breakpoint on the settled user turn, so a long turn re-caches only its own messages when the tail misses.
- `--cache-ttl 5m|1h` and the settings key `cacheTtl` choose the prompt-cache TTL: with `1h` the system block, the last tool and the settled pin are cached for an hour while the tail stays 5 minutes; the default stays `5m`.
- Tool definitions are sent sorted by name, so a proxy that sorts `tools[]` (wirescope's SORT_TOOLS) leaves them and their cache breakpoint as sent.
- Stream JSON io: `-p --input-format stream-json --output-format stream-json` reads prompts, interrupts and `set_model` as JSON lines on stdin and writes `init`, `assistant`, `user`, `result` and `control_response` lines on stdout, as Clodex's Claude stream codec expects; `-p "<prompt>" --output-format stream-json` prints one turn the same way.
- Permission prompts over stdio: with `--permission-prompt-tool stdio` a permission ask is a `can_use_tool` control request answered by an allow or deny `control_response`; a deny writes a `permission_denied` line.
- `-p` directly followed by another flag parses as a bare flag with an empty prompt, so `-p --input-format stream-json` works.
- Slash commands over stream-json stdin: a `/compact`, `/clear`, `/cost`, `/model`, `/help`, `/quit` or `/exit` user message runs the REPL's command, never folded into a running turn, and answers with Claude's lines (`status`, `compact_boundary`, `conversation_reset` and a fresh `init`) and one `result` (none for `/quit`/`/exit`); init `slash_commands` lists them.

## 0.3.0 — 2026-11-04

- Renamed clay to clodent: the clodent command, CLODENT_HOME (default ~/.clodent), CLODENT_PROJECT_DIR, [clodent:*] output lines, clodent: message prefix, user agent clodent/<version>, transcript entrypoint clodent; no aliases for the old names.
- Permission rules are harder to evade: Grep and Glob hide files an ask rule matches unless `--yolo`, or the REPL user allowed the call and the rule matches the call's `path`, and symlink entries whose target a rule matches; a rule also matches the realpath of its leading part (macOS `/private/etc`, a symlinked `$HOME`); on macOS `/System/Volumes/Data/…` paths are checked without that prefix; Bash mentions match in any letter case; a rule name that differs from a clodent tool only in case or spaces (`read(x)`, `Read (x)`, `BASH`) is a startup error; and clodent's system prompt no longer names a tool a bare deny removed.
- Claude flag spellings: `--dangerously-skip-permissions` (as `--yolo`) and `--permission-mode default|plan|acceptEdits|bypassPermissions`; permission flags that name different modes are an argument error.
- `--plugin-dir`, `--agents`, `--mcp-config`, `--strict-mcp-config`, `--allowedTools`/`--allowed-tools` and `--dangerously-bypass-hook-trust` are accepted and ignored, each with one `clodent: ignoring --<name>: not supported` line on stderr.
- `--disallowedTools`/`--disallowed-tools <list>` adds deny rules in the settings rule syntax, after the settings ones; a malformed entry exits 2.
- `--permission-mode acceptEdits`: write tools and read-only Bash commands run without asking; any other Bash command asks (refused in `-p`); hooks see `permission_mode: "acceptEdits"`.
- `--effort` and settings `effortLevel` accept `xhigh` and `max`, sent as `output_config.effort` unchanged.
- One trailing bracketed model suffix such as `[1m]` is dropped from `--model`, settings `model` and `/model <id>` before the id reaches the wire, the price table, the prompt, hooks or the statusLine.
- Settings `sandbox.enabled: true` is no longer a startup error: `filesystem.denyRead`/`denyWrite` and deny `credentials.files` become deny rules, deny `credentials.envVars` are removed from the Bash tool's environment, other sandbox keys are ignored with one warning, and a malformed block exits 2.
- Hook and transcript shapes: a permission `Notification` sends `notification_type: "permission_prompt"` with `title` and `message: "clodent needs your permission to use <Tool>"`; `SessionStart` stdin carries `model`; every transcript record carries `userType: "external"` and `gitBranch`.

## 0.2.0 — 2026-11-04

- Settings `permissions.deny` and `permissions.ask` rules (Claude Code syntax) are enforced on Read, Edit, Write, Grep and Glob, with the path checked lexically and after realpath: a deny refuses the call in every mode, `--yolo` and a hook `allow` included, an ask asks in the REPL and refuses in `-p` and `--read-only`, Grep and Glob skip denied files, and a bare-name deny removes the tool from the request.
- Bash is guarded by the same rules as a best-effort string check: `Bash(prefix:*)` and exact rules, a command that mentions a `Read` rule path is denied, and one that mentions an `Edit` or `Write` rule path is denied unless it is read-only.
- A malformed `permissions` rule list and `sandbox.enabled: true` are startup errors: `clay: settings <path>: <message>`, exit 2, before SessionStart and any request.

## 0.1.0 — 2026-11-04

- `clay -p "<prompt>"` runs one turn of the agent loop and prints the final answer; exit 0 when the model ends its turn, 1 on an API error, budget stop or other stop reason, 2 on a startup error, and 130/143/129 on SIGINT/SIGTERM/SIGHUP.
- Interactive REPL for a PTY host: bracketed paste as one prompt, prompt queueing during a turn, Ctrl-C/Ctrl-D, `/help`, `/cost`, `/model`, `/clear`, `/compact [instructions]` and `/quit`/`/exit`.
- Flags: `--model`, `--effort`, `--budget`, `--yolo`, `--read-only`, `--session-id`, `--resume`, `--fork-session`, `--settings`, `--add-dir`, `--system-prompt`/`--system-prompt-file`, `--append-system-prompt`/`--append-system-prompt-file`, `--version` and `--help`.
- Messages API client: streamed SSE with no beta header, `clay/<version>` user agent, adaptive thinking, three cache breakpoints, retries before the first event for 429, 500, 502, 503, 504, 529 and network errors, and up to two re-sends after a mid-stream `overloaded_error` or `api_error`; `ANTHROPIC_BASE_URL` replaces the origin.
- clay's own system prompt with an environment section, `--add-dir` and settings directories, and AGENTS.md files from the git root down to the working directory.
- Built-in tools Read, Write, Edit, Bash, Grep and Glob, each result capped at 32 KiB; Grep and Glob respect `.gitignore` and search inside a git-ignored directory when pointed at one.
- Permissions: the default mode asks before write and exec tools in the REPL (`[clay:permit]` line, y/n, `Notification` hook) and refuses them in `-p`; read-only Bash commands run without asking; `--yolo` asks nothing; `--read-only` refuses write tools and Bash commands that are not read-only.
- Cost: an exact-id price table, a `[clay:cost]` line per turn, a session total on exit, and `--budget <usd>` with `[clay:budget]` stop lines.
- Sessions: JSONL transcripts under `$CLAY_HOME/projects/<slug>/`, with `--session-id`, `--resume` and `--fork-session`; a compacted session resumes from its summary.
- Settings and hooks: `$CLAY_HOME/settings.json` and `--settings` files; `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `PreCompact` and `Stop` hooks with context injection and PreToolUse decisions; a `statusLine` command fed the context window and cost.
- `scripts/live-smoke.js`: opt-in check against the real Messages API (needs `ANTHROPIC_API_KEY`).
