# Security policy

## Supported versions

Security fixes go into the latest release on `main`.

## Reporting a vulnerability

Please do not report a vulnerability in a public issue. Use GitHub's private reporting: [https://github.com/nrzz/claude-chat-ferry/security/advisories/new](https://github.com/nrzz/claude-chat-ferry/security/advisories/new), or the contact in the [nrzz security policy](https://github.com/nrzz/.github/blob/master/SECURITY.md). You can expect a first answer within 72 hours, and credit in the release notes if you want it.

## What this tool can and cannot protect

Everything stays on your machine: the tool reads the chat stores of Claude Code, Cursor, Antigravity and Codex CLI, writes one session file or one export file, and sends nothing anywhere. It never writes into another tool's store. Exports replace secrets by default; report a secret shape the redaction misses as a bug.
