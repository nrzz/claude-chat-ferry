# Claude chat ferry

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg) ![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg) [![part of the Claude Code toolkit](https://img.shields.io/badge/Claude%20Code-toolkit-d97757.svg)](https://github.com/nrzz/claude-code-toolkit)

Move a chat between Claude Code, Cursor and Antigravity. Continue this project's latest Cursor or Antigravity chat in Claude Code, hand a Claude Code session to Cursor or Antigravity, or turn any of them into Markdown or JSON. It also reads Codex CLI sessions, claude.ai and ChatGPT data exports, plain Markdown chats and lists of messages.

| You want to | Run | What you get |
| --- | --- | --- |
| Continue a Cursor chat in Claude Code | `claude-chat-ferry import cursor:latest` | a Claude Code session; `claude --resume <id>` opens it with the whole chat as history |
| Continue an Antigravity chat in Claude Code | `claude-chat-ferry import antigravity:latest` | the same |
| Continue a Claude Code session in Cursor or Antigravity | `claude-chat-ferry export claude:latest --to cursor` | a Markdown file in the project (`.ai-chats/`); mention it with `@` in their chat |
| Keep or share a chat | `... --to markdown` or `--to json`, from any source | one file, secrets replaced |
| See what there is | `claude-chat-ferry list` | this project's chats in every tool |

Inside Claude Code the plugin adds `/chat-ferry:import` (bring the latest Cursor or Antigravity chat into this conversation) and `/chat-ferry:export` (write this session for them). No dependencies: Node 18 or newer, and Node 22.13 or newer to read Cursor's store (it uses Node's built-in SQLite).

## What it costs in tokens

| Where | Tokens |
| --- | --- |
| The `claude-chat-ferry` command | 0: it runs outside Claude |
| `/chat-ferry:export` | about 150 per use: the skill's text (about 70 by Claude Code's estimate), the command it runs, the file name it prints, and a two-line reply |
| `/chat-ferry:import` | the chat it brings in, plus about 100 (the skill's text is about 90 by Claude Code's estimate): by default the last 10 exchanges of the other tool's chat enter this conversation as a tool result. `claude-chat-ferry show cursor:latest` says how big the whole chat is before you ask for more |
| A session written by `import` | nothing until you resume it. Then its turns are the session's history, sent with every prompt like any session's; the import prints the size, and `--last 20` keeps only the newest 20 exchanges |

Both skills are user-only (`disable-model-invocation: true`): Claude never sees them until you type them, so an installed plugin adds nothing to a session that does not use it. `claude plugin details` still estimates about 38 always-on tokens for the plugin, because it counts the two skills' descriptions; Claude Code leaves user-only skills out of the list it gives the model.

## Install

No install, from any project folder:

```bash
npx -y github:nrzz/claude-chat-ferry list
```

As a Claude Code plugin, for the two skills:

```text
/plugin marketplace add nrzz/claude-chat-ferry
/plugin install chat-ferry@claude-chat-ferry
```

The plugin's skills call the same command from the plugin's own folder, so the plugin alone is enough. For a shorter command, `npm install -g github:nrzz/claude-chat-ferry` gives you `claude-chat-ferry`.

## Use

### See this project's chats

```bash
claude-chat-ferry list
```

```text
Cursor  4 chats, D:\Projects\webapp
  2026-07-12 10:00 11111111  Fix the carousel on mobile                    2 prompts
  2026-07-01 08:30 22222222  Rename the @Button component                  1 prompts
  ...
Antigravity  2 chats, every project: Antigravity does not record one
  2026-09-30 10:03 a4637e82  Retry loop in the client
Claude Code  1 session, D:\Projects\webapp
  2026-10-01 12:06 cbdcc4b9  Fix login redirect loop                       5 prompts
```

`list` looks at the current folder's chats; `--project <dir>` picks another project and `--all` shows every project. `--from cursor` limits it to one tool, `--limit 50` shows more, `--json` prints the same for scripts. A chat about a parent folder (a monorepo) counts for the project too, but a chat from a Cursor window opened on your home folder does not count for everything under it.

### Continue a Cursor or Antigravity chat in Claude Code

```bash
claude-chat-ferry import cursor:latest
```

```text
Imported Fix the carousel on mobile from Cursor into Claude Code: 4 messages, about 1,200 tokens of context.
Next, in D:\Projects\webapp:
  claude --resume 56b6c5e1-4a3a-41a4-861e-8aa01d797a95
```

`cursor:latest` is this project's newest Cursor chat that has messages (Cursor keeps an empty chat for every "New chat"; those are skipped). `cursor:3f2a` takes the chat whose id starts with that, from any project; `antigravity:latest` and `antigravity:<id>` do the same for Antigravity, `codex:latest` for Codex CLI. `claude --resume <id>` then opens the session with the whole chat as its history. Run it in the project folder; Claude Code 2.1.289 also finds the id from any folder when only one project holds it.

What the session holds, and the options that change it:

- The first message starts with one line saying where the chat came from: `[Conversation imported from Cursor chat "Fix the carousel on mobile", 2026-07-12 by claude-chat-ferry. It continues from here.]`. `--no-banner` leaves it out.
- Every prompt and every answer, as text. Consecutive messages of one side are joined into one turn, so the history alternates the way Claude Code expects.
- Tool calls as one line each in the answer that made them: `(Used read_file_v2: src/Gallery.tsx)`. `--tools full` adds each tool's output (cut to about 2,000 characters), `--tools none` leaves the calls out.
- The model's reasoning is left out unless you add `--thinking`.
- `--last 20` imports only the newest 20 exchanges (a prompt and its answers). A chat of 100 exchanges can cost 50,000 tokens on every prompt once resumed; the import says how many, and warns above 40,000.
- `--title "..."` names the session (the `/resume` picker shows it); otherwise the chat's own name is used. `--redact` replaces secrets before writing (off by default for an import, since the session stays on your machine). `--dry-run` says what would be written.

Which Claude Code project the session joins is the current folder, or `--project <dir>`.

### Hand a Claude Code session to Cursor or Antigravity

```bash
claude-chat-ferry export claude:latest --to cursor
```

```text
Wrote .ai-chats/2026-10-01-fix-login-redirect-loop.md
  Fix login redirect loop from Claude Code: 3 exchanges, about 1,400 tokens; replaced 1 secret (github-token 1); rewrote 2 paths
Next, in Cursor's chat for D:\Projects\webapp: type @.ai-chats/2026-10-01-fix-login-redirect-loop.md and say "continue this conversation".
```

Cursor and Antigravity have no way to take another tool's chat into their history, so the export is a Markdown file in the project's `.ai-chats/` folder, which their chat reads when you mention it with `@` (in Cursor, `@` then the file name; in Antigravity, `@` or drag the file in). `--to antigravity` writes the same file and prints that tool's step. `claude:latest` is this project's newest Claude Code session with a prompt; `claude:<id>` takes one by the start of its id. Inside Claude Code, `/chat-ferry:export` does this for the running session.

Exports replace secrets by default (see Privacy) and show the project's folder as `.` and your home folder as `~`; `--no-redact` keeps everything. `--out <path>` chooses the file (`--out -` prints it), `--force` overwrites one that exists (otherwise a `-2` is added), `--last`, `--tools` and `--thinking` work as for an import, and `--title` sets the heading.

### Markdown and JSON, from any source

```bash
claude-chat-ferry export antigravity:latest --to markdown --out notes/retry-loop.md
claude-chat-ferry export cursor:latest --to json
```

The Markdown file has a front matter block (title, tool, id, project, model, start and end time) and one `## User` or `## Assistant` heading per turn, with tool calls as `> **Tool** name: what it did` lines. The JSON is this tool's own shape (`format: "claude-chat-ferry/1"`): `{ tool, id, title, project, model, startedAt, endedAt, turns: [{ role, at, text, thinking, tools: [{ name, input, output }] }] }`. Both read back in: `import notes/retry-loop.md` makes a Claude Code session from the file.

### Other sources: Codex CLI, claude.ai, ChatGPT, Markdown, lists of messages

| Source | Spelling | Notes |
| --- | --- | --- |
| Codex CLI | `codex:latest`, `codex:<id>` | its sessions under `~/.codex/sessions` (`CODEX_HOME` moves them); this project's by default |
| claude.ai data export | `conversations.json` | Settings, Privacy, Export data. `list conversations.json` numbers the conversations; `--pick 12`, `--pick <id start>` or `--pick "login bug"` chooses one |
| ChatGPT data export | `conversations.json` | Settings, Data controls, Export data. The same `--pick`; the branch you last saw is the one taken |
| A Markdown chat | `chat.md` | this tool's own files, and hand-written ones with `## User` / `## Assistant`, `**User:**`, `User:` or `### Human` markers; a file without markers is one prompt |
| A list of messages | `messages.json` | `[{ role, content }, ...]` as the Anthropic and OpenAI APIs take it, Cline's `api_conversation_history.json`, or `{ messages: [...] }` |
| A Claude Code session file | `<id>.jsonl` | any session file, from any config folder |

`show <source>` prints a chat's size, dates, first and last prompt before you move it, for every source above.

### Inside Claude Code

- `/chat-ferry:import` brings this project's latest Cursor chat into the conversation: Claude runs `claude-chat-ferry skill-import`, reads the last 10 exchanges, says where the chat left off and continues it. `/chat-ferry:import antigravity` takes Antigravity's, `/chat-ferry:import cursor 25` takes the last 25 exchanges.
- `/chat-ferry:export` writes this session as `.ai-chats/<date>-<title>.md`, secrets replaced, and tells you how to open it in Cursor or Antigravity.

Both run only the plugin's own command (`node .../bin/claude-chat-ferry.mjs ...`), which their `allowed-tools` pre-approves; nothing else is approved.

## Where each tool keeps its chats

| Tool | Read from | Checked against |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<folder>/<id>.jsonl` (`CLAUDE_CONFIG_DIR`); written there too | Claude Code 2.1.289 |
| Cursor | `state.vscdb` under `%APPDATA%\Cursor\User` (Windows), `~/Library/Application Support/Cursor/User` (macOS), `~/.config/Cursor/User` (Linux): the `composerHeaders` table, `composerData:` and `bubbleId:` rows, the older `composer.composerHeaders` and per-workspace indexes, and the pre-composer `aichat.chatdata` tabs. `CURSOR_USER_DIR` overrides the folder | Cursor 3.19.19 |
| Antigravity | `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl` (`transcript_full.jsonl` when present), titles from `agyhub_summaries_proto.pb`; the `antigravity-ide` and `antigravity-cli` folders too. `ANTIGRAVITY_DIR` overrides them | Antigravity (June 2026 build) |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`CODEX_HOME`) | the format others have documented; no install was at hand |

These are the tools' own files and formats, none of them documented by their makers; a tool's update can change them. The reader of each is in one file (see Files), tested against synthetic copies of the layouts, and checked by hand against the versions above. If your version keeps chats somewhere else, `list --json` and an issue with the field names you see are the quickest way to a fix.

## Limits

- Nothing is written into Cursor's or Antigravity's stores: they have no import, and writing into another program's database is not a thing to do to someone's chats. The export is a file they read.
- Images and attachments are noted (`[1 image attached]`, `(Attached: src/Gallery.tsx)`), not copied.
- Antigravity does not record which project a conversation was about, so `antigravity:latest` is the newest conversation overall, and `list` shows them all.
- A chat is text: the "edit this file" calls Cursor and Antigravity made are listed, not replayed.
- Claude Code's session format is its own and undocumented. The import writes the same records Claude Code 2.1.x writes (checked by resuming one with the real binary: see below); a future version could read it differently.

## Privacy and redaction

Everything runs on your machine and sends nothing anywhere. `list` and `show` read the stores above; `import` writes one file under your Claude Code config folder; `export` writes one file where you say. No index, cache or log is kept. The one exception is what you choose to move: a session you import is sent to Claude as that session's history, and a file you export may be committed or shared.

Exports (`--to cursor`, `antigravity`, `markdown`, `json`) replace secrets by default: API keys of common shapes (Anthropic, OpenAI, GitHub, GitLab, Slack, AWS, Google, npm, Hugging Face, SendGrid, Stripe), private keys, JWTs, bearer tokens, URL passwords, `KEY=value` lines and `password: "..."` assignments, each shown as `[REDACTED:kind]`. The message says what was replaced. It is best effort: it catches the common shapes, not every secret, so read a file before you share it. Imports keep everything unless you add `--redact`. Control characters and text-direction overrides are removed from everything printed or written, so a crafted chat title cannot drive your terminal.

## How it works

Every reader turns a tool's own records into one shape, a conversation of turns (`src/model.mjs`), and every writer takes that shape. The Claude Code writer (`src/claude-code.mjs`) builds the records a session file holds: a `custom-title` and a `summary` record, then one record per turn with `uuid`, `parentUuid`, `sessionId`, `cwd` and a rising `timestamp`, user messages as text blocks and assistant messages with a model name (`imported` when the chat does not say), `stop_reason` and zero usage. Cursor's store is read with Node's built-in `node:sqlite`, opened read-only, loaded only when a Cursor chat is asked for.

## What was verified, and how

- **Claude Code continues an imported session.** On 2026-10-06, sessions written by this tool (a real Cursor chat of 16 messages, and synthetic ones with the barest records, an unknown model name, title records, and resumed from a different folder) were opened with Claude Code 2.1.289's `claude -p --resume <id>` against a fake API on localhost. Every imported turn arrived in the request, the banner first, the new prompt last. `test/e2e-claude.test.mjs` repeats this whenever a `claude` binary is on the PATH (or in `E2E_CLAUDE`); without one it is skipped, as in CI.
- **The skills reach the command.** `claude -p --plugin-dir . "/chat-ferry:import antigravity 2"` through the same fake API showed Claude Code filling in `$ARGUMENTS`, `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` and asking the model to run the pre-approved command; the same for `/chat-ferry:export`.
- **Cursor 3.19.19 on Windows, 2026-10-06:** `list --all` listed 134 chats from a 2.3 GB store in about a quarter of a second; the newest chat read as 7 exchanges with alternating roles, a chat of 136 turns and 2,220 tool calls read, exported to Markdown and read back with the same turns and tools, and became a session file that read back with the same turns. The pre-composer `aichat.chatdata` layout and the per-workspace index are covered by the tests only; this install had neither.
- **Antigravity, 2026-10-06:** both conversations on the machine listed with their titles from `agyhub_summaries_proto.pb`, and read as one prompt and one answer each, with the `<USER_REQUEST>` wrapper removed and the reasoning kept. The tool steps (`RUN_COMMAND`, `VIEW_FILE`) are covered by the tests from the transcripts others have published.
- **Codex CLI, claude.ai and ChatGPT** readers run against synthetic files in the documented shapes; no live install or export was at hand. The ChatGPT reader follows `current_node` up to the root, so a regenerated answer gives the branch you last saw.
- **325 automated tests** (`npm test`), all in throwaway folders: synthetic Claude Code sessions, Cursor stores built with `node:sqlite` in every layout above, Antigravity folders with a hand-encoded titles file, Codex rollouts, claude.ai and ChatGPT exports, Markdown in the hand-written shapes, the redaction rules, and the command's every option and error. CI runs them on Windows, macOS and Linux with Node 20, 22 and 24, and on Linux with Node 18, where the Cursor tests are skipped and the command explains which Node it needs.
- **Not verified:** macOS and Linux paths of Cursor and Antigravity beyond their documented locations; Antigravity's project folder (not recorded); a Codex CLI install; `/resume` picker titles (the title records are the ones Claude Code 2.1.x writes).

## Files

| File | What it is |
| --- | --- |
| `bin/claude-chat-ferry.mjs`, `src/cli.mjs` | the command: list, show, import, export, and the skills' `skill-import` |
| `src/model.mjs` | the one conversation shape, turn selection, sizes, tool-call summaries |
| `src/claude-code.mjs` | Claude Code sessions: where they are, reading one, listing, writing one to resume |
| `src/cursor.mjs`, `src/sqlite.mjs` | Cursor's store, read-only through `node:sqlite` |
| `src/antigravity.mjs` | Antigravity's transcripts and titles |
| `src/codex.mjs` | Codex CLI's rollout files |
| `src/exports.mjs` | claude.ai and ChatGPT exports, lists of messages, this tool's JSON |
| `src/markdown.mjs` | Markdown out and in |
| `src/redact.mjs`, `src/util.mjs` | secrets and paths; text, dates, files |
| `skills/` | `/chat-ferry:import` and `/chat-ferry:export` |
| `.claude-plugin/` | the plugin and its one-plugin marketplace |
| `test/` | the tests, with the fixture builders (`fake-cursor.mjs`, `fake-antigravity.mjs`, `fake-codex.mjs`, `synthetic.mjs`) |

## Contributing

Issues and pull requests are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [good first issues](https://github.com/nrzz/claude-chat-ferry/issues?q=is%3Aopen+label%3A%22good+first+issue%22). Questions go to [Discussions](https://github.com/nrzz/claude-chat-ferry/discussions); security reports go through [SECURITY.md](SECURITY.md).

## Part of the Claude Code toolkit

Small, dependency-free tools that make Claude Code cheaper, safer and easier to share, all in the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit):

- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself
- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers
- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD
- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits
- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes
- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it
- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command
- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings
- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay

Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on.

## License

MIT.
