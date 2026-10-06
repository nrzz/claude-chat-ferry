---
name: export
description: Hand this session to Cursor or Antigravity: writes the conversation as a Markdown file in the project, secrets redacted.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/claude-chat-ferry.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/claude-chat-ferry.mjs *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-chat-ferry.mjs" export claude:${CLAUDE_SESSION_ID} --to cursor --project "${CLAUDE_PROJECT_DIR}"`

The command's output names the file it wrote. Reply in two lines: the path, and how to continue the chat in Cursor or Antigravity (the output says how).
