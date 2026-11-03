# Changelog

## Unreleased

- `clay --version` and `clay --help`.
- Cost ledger: per-model price table and the `[clay:cost]` / `[clay:budget]` line formats.
- `scripts/live-smoke.js`: opt-in check against the real Messages API (needs `ANTHROPIC_API_KEY`).
- Command-line parser for the v0.1 flag set; clay's own system prompt with AGENTS.md discovery.
- Built-in tools Read, Write, Edit, Bash, Grep and Glob; tool results are capped at 32 KiB.
- Grep and Glob search inside git-ignored directories when pointed at one.
