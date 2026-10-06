---
name: import
description: Continue the latest Cursor or Antigravity chat here.
disable-model-invocation: true
argument-hint: "[cursor|antigravity] [exchanges]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/claude-chat-ferry.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/claude-chat-ferry.mjs *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-chat-ferry.mjs" skill-import "$ARGUMENTS" --project "${CLAUDE_PROJECT_DIR}"`

The command's output is the conversation from the other tool (or a line saying none was found). In two lines, say where it left off. Then continue it: do what was being asked, or ask what to do next if that is not clear.
