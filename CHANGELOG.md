# Changelog

All notable changes to Claude chat ferry are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-06

- First release: `import` writes a Claude Code session from a Cursor chat, an Antigravity conversation, a Codex CLI session, a claude.ai or ChatGPT export, a Markdown chat or a list of messages, and prints the `claude --resume` line; `export` writes a Claude Code session (or any of those) as Markdown or JSON, into the project's `.ai-chats/` folder for Cursor and Antigravity; `list` and `show`; `--last`, `--tools`, `--thinking`, `--redact`; the `/chat-ferry:import` and `/chat-ferry:export` skills.
- Verified by resuming imported sessions with Claude Code 2.1.289 against a fake API, and against Cursor 3.19.19 and Antigravity on 2026-10-06.

[1.0.0]: https://github.com/nrzz/claude-chat-ferry/releases/tag/v1.0.0
