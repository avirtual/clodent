# Changelog

## Unreleased

- `clay --version` and `clay --help`.
- Cost ledger: per-model price table and the `[clay:cost]` / `[clay:budget]` line formats.
- `scripts/live-smoke.js`: opt-in check against the real Messages API (needs `ANTHROPIC_API_KEY`).
- Command-line parser for the v0.1 flag set; clay's own system prompt with AGENTS.md discovery.
- Built-in tools Read, Write, Edit, Bash, Grep and Glob; tool results are capped at 32 KiB.
- `clay -p "<prompt>"` runs the agent loop with tools and prints the final answer; `--model`, `--effort`, `--budget`, `--yolo`, `--read-only`, system-prompt and `--add-dir` flags work.
