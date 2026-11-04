# Changelog

## Unreleased

- `clay --version` and `clay --help`.
- Cost ledger: per-model price table and the `[clay:cost]` / `[clay:budget]` line formats.
- `scripts/live-smoke.js`: opt-in check against the real Messages API (needs `ANTHROPIC_API_KEY`).
- Command-line parser for the v0.1 flag set; clay's own system prompt with AGENTS.md discovery.
- Built-in tools Read, Write, Edit, Bash, Grep and Glob; tool results are capped at 32 KiB.
- Grep and Glob search inside git-ignored directories when pointed at one.
- `clay -p "<prompt>"` runs the agent loop with tools and prints the final answer; `--model`, `--effort`, `--budget`, `--yolo`, `--read-only`, system-prompt and `--add-dir` flags work.
- Sessions: JSONL transcripts under `$CLAY_HOME`, `--session-id`, `--resume` and `--fork-session`.
- Settings files and hooks: `--settings`, `$CLAY_HOME/settings.json`, SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PostToolUseFailure/Stop hooks with context injection, statusLine, and `ANTHROPIC_BASE_URL`.
- Interactive REPL: bracketed paste, Ctrl-C/Ctrl-D, /help /cost /model /clear /quit, and a y/n permission ask with a Notification hook.
