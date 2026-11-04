# Changelog

clodent was named clay up to 0.2.0.

## Unreleased

- Renamed clay to clodent: the clodent command, CLODENT_HOME (default ~/.clodent), CLODENT_PROJECT_DIR, [clodent:*] output lines, clodent: message prefix, user agent clodent/<version>, transcript entrypoint clodent; no aliases for the old names.

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
