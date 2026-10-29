# Changelog

All notable changes to Claude chat ferry are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-10-29

- `gemini:latest` and `gemini:<id>` read Gemini CLI sessions (`~/.gemini/tmp/<project>/chats/session-*.jsonl`; `GEMINI_CLI_HOME` moves `.gemini`): the turns, the model, the thoughts, and each tool call with its output or error. `list --from gemini`, and a file from `/chat share` can be shown, imported and exported. The project of a session comes from `projects.json` (or its `directories`), and the `$set`, `$patch` and `$rewindTo` lines of newer logs are applied.
- Verified against Gemini CLI 0.64.0 run offline against a fake API; the files it wrote are in `test/fixtures/gemini-0.64.0`.
- The README's test count is the runner's total (452) less its six helper-file entries: 446.
- Contributed by [@yoreva-01](https://github.com/yoreva-01) in [#2](https://github.com/nrzz/claude-chat-ferry/pull/2), for the good first issue [#1](https://github.com/nrzz/claude-chat-ferry/issues/1).

## [1.0.0] - 2026-10-06

- First release: `import` writes a Claude Code session from a Cursor chat, an Antigravity conversation, a Codex CLI session, a claude.ai or ChatGPT export, a Markdown chat or a list of messages, and prints the `claude --resume` line; `export` writes a Claude Code session (or any of those) as Markdown or JSON, into the project's `.ai-chats/` folder for Cursor and Antigravity; `list` and `show`; `--last`, `--tools`, `--thinking`, `--redact`; the `/chat-ferry:import` and `/chat-ferry:export` skills.
- Verified by resuming imported sessions with Claude Code 2.1.289 against a fake API, and against Cursor 3.19.19 and Antigravity on 2026-10-06.

[1.1.0]: https://github.com/nrzz/claude-chat-ferry/releases/tag/v1.1.0
[1.0.0]: https://github.com/nrzz/claude-chat-ferry/releases/tag/v1.0.0
