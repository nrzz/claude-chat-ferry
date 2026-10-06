// A Cursor user folder with chats in it, built with node:sqlite the way Cursor 3.x lays it out
// (composerHeaders table, composerData and bubbleId rows, workspace folders), with switches for the
// older layouts (the ItemTable index, the per-workspace index, inline conversations, the
// pre-composer chat tabs). Everything in it is invented.
import fs from "node:fs";
import path from "node:path";

export function fileUri(folder) {
  const s = String(folder).replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(s)) return `file:///${s[0].toLowerCase()}%3A${encodeURI(s.slice(2))}`;
  return `file://${encodeURI(s)}`;
}

function openWritable(file) {
  // eslint-disable-next-line no-undef
  return import("node:sqlite").then(({ DatabaseSync }) => new DatabaseSync(file));
}

/**
 * makeCursorStore(userDir, {
 *   workspaces: [{ id, folder }],
 *   chats: [{ id, workspaceId, name, createdAt (ms), updatedAt (ms), archived, subagent, model,
 *             bubbles: [{ type: 1|2, text, richText, createdAt (ISO), thinking, tool: { name, rawArgs, result }, files: [] }],
 *             inline: false (store bubbles inside composerData.conversation instead of bubbleId rows),
 *             index: "table" | "item" | "workspace" (where the chat is listed; default "table") }],
 *   legacy: [{ workspaceId, tabId, chatTitle, lastSendTime (ms), bubbles: [{ type: "user"|"ai", text }] }],
 * })
 */
export async function makeCursorStore(userDir, { workspaces = [], chats = [], legacy = [] } = {}) {
  const globalDir = path.join(userDir, "globalStorage");
  fs.mkdirSync(globalDir, { recursive: true });
  const db = await openWritable(path.join(globalDir, "state.vscdb"));
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT)");
  const put = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  const putItem = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  const putHeader = db.prepare("INSERT INTO composerHeaders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const blob = (v) => Buffer.from(JSON.stringify(v), "utf8");
  const itemHeaders = [];
  const perWorkspace = new Map();
  for (const chat of chats) {
    const createdAt = chat.createdAt ?? Date.parse("2026-07-12T09:14:00Z");
    const updatedAt = chat.updatedAt ?? createdAt + 60000;
    const bubbles = (chat.bubbles || []).map((b, i) => ({
      _v: 3, type: b.type, bubbleId: b.bubbleId || `${chat.id.slice(0, 8)}-bubble-${String(i + 1).padStart(4, "0")}`,
      text: b.text ?? "", richText: b.richText ?? "", createdAt: b.createdAt || new Date(createdAt + i * 1000).toISOString(),
      tokenCount: { inputTokens: 0, outputTokens: 0 }, unifiedMode: 2, conversationState: "~",
      ...(b.thinking ? { thinking: { text: b.thinking, signature: "", redactedThinking: "", isLastThinkingChunk: true }, thinkingDurationMs: 500 } : {}),
      ...(b.allThinkingBlocks ? { allThinkingBlocks: b.allThinkingBlocks.map((text) => ({ text })) } : {}),
      ...(b.tool ? { toolFormerData: { toolCallId: `call-${i}`, toolIndex: 0, status: "completed", name: b.tool.name, tool: 15, rawArgs: typeof b.tool.rawArgs === "string" ? b.tool.rawArgs : JSON.stringify(b.tool.rawArgs ?? {}), params: "", result: typeof b.tool.result === "string" || b.tool.result === undefined ? b.tool.result ?? "" : JSON.stringify(b.tool.result), additionalData: { status: "completed" } } } : {}),
      ...(b.files ? { attachedCodeChunks: b.files.map((f) => ({ relativeWorkspacePath: f, startLineNumber: 1, lines: ["x"], languageIdentifier: "ts", intent: "default" })) } : {}),
      ...(b.modelInfo ? { modelInfo: b.modelInfo } : {}),
      capabilityType: b.type === 2 ? 30 : undefined,
    }));
    const headers = bubbles.map((b) => ({ bubbleId: b.bubbleId, type: b.type, serverBubbleId: b.bubbleId, grouping: { isRenderable: true, hasText: !!b.text }, createdAt: b.createdAt }));
    const data = {
      _v: 17, composerId: chat.id, name: chat.name ?? "", richText: "", hasLoaded: true, text: "",
      fullConversationHeadersOnly: chat.inline ? [] : headers, conversationMap: {}, status: "completed",
      createdAt, lastUpdatedAt: updatedAt, unifiedMode: "agent", forceMode: "edit", isAgentic: true,
      modelConfig: { modelName: chat.model || "fake-model-1", maxMode: false }, contextUsagePercent: 10,
      ...(chat.inline ? { conversation: bubbles } : {}),
    };
    if (chat.missing !== true) put.run(`composerData:${chat.id}`, blob(data));
    if (!chat.inline) for (const b of bubbles) put.run(`bubbleId:${chat.id}:${b.bubbleId}`, blob(b));
    const ws = workspaces.find((w) => w.id === chat.workspaceId);
    const head = { type: "head", composerId: chat.id, name: chat.name ?? "", createdAt, lastUpdatedAt: updatedAt, unifiedMode: "agent", forceMode: "edit", hasUnreadMessages: false, subtitle: "", isDraft: false, workspaceIdentifier: ws ? { id: ws.id, uri: { fsPath: ws.folder, scheme: "file" } } : undefined };
    const index = chat.index || "table";
    if (index === "table") putHeader.run(chat.id, chat.workspaceId || "", createdAt, updatedAt, chat.archived ? 1 : 0, chat.subagent ? 1 : 0, updatedAt, 0, JSON.stringify(head));
    else if (index === "item") itemHeaders.push({ ...head, isSubagent: !!chat.subagent });
    else if (index === "workspace") { const list = perWorkspace.get(chat.workspaceId) || []; list.push({ type: "head", composerId: chat.id, createdAt, lastUpdatedAt: updatedAt, unifiedMode: "agent", forceMode: "edit", hasUnreadMessages: false, name: chat.name ?? "" }); perWorkspace.set(chat.workspaceId, list); }
  }
  putItem.run("composer.composerHeaders.migratedToTable", blob(true));
  if (itemHeaders.length) putItem.run("composer.composerHeaders", blob({ allComposers: itemHeaders }));
  db.close();
  for (const w of workspaces) {
    const dir = path.join(userDir, "workspaceStorage", w.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "workspace.json"), JSON.stringify({ folder: fileUri(w.folder) }, null, 2));
    const wdb = await openWritable(path.join(dir, "state.vscdb"));
    wdb.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    const putW = wdb.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    putW.run("composer.composerData", blob({ allComposers: perWorkspace.get(w.id) || [], selectedComposerIds: [] }));
    const tabs = legacy.filter((l) => l.workspaceId === w.id).map((l) => ({ tabId: l.tabId, chatTitle: l.chatTitle, lastSendTime: l.lastSendTime ?? Date.parse("2024-06-01T10:00:00Z"), bubbles: l.bubbles.map((b, i) => ({ type: b.type, id: `${l.tabId}-${i}`, text: b.text, rawText: b.text, modelType: "gpt-4" })) }));
    if (tabs.length) putW.run("workbench.panel.aichat.view.aichat.chatdata", blob({ tabs }));
    wdb.close();
  }
  return userDir;
}

// A handful of chats for the tests: two for one project, one for another, one archived, a subagent
// and an empty "New chat".
export const CHATS_PROJECT = "D:\\Projects\\webapp";
export const CHATS_OTHER = "D:\\Projects\\other";
export function sampleChats(projectFolder = CHATS_PROJECT, otherFolder = CHATS_OTHER) {
  const t = (iso) => Date.parse(iso);
  return {
    workspaces: [{ id: "a".repeat(32), folder: projectFolder }, { id: "b".repeat(32), folder: otherFolder }],
    chats: [
      {
        id: "11111111-aaaa-4aaa-8aaa-111111111111", workspaceId: "a".repeat(32), name: "Fix the carousel on mobile", createdAt: t("2026-07-12T09:14:00Z"), updatedAt: t("2026-07-12T10:00:00Z"), model: "fake-model-1",
        bubbles: [
          { type: 1, text: "The carousel arrows do not advance on mobile. See Gallery.tsx", files: ["src/Gallery.tsx"] },
          { type: 2, thinking: "Probably the touch handler." },
          { type: 2, tool: { name: "read_file_v2", rawArgs: { relativeWorkspacePath: "src/Gallery.tsx" }, result: { contents: "export const Gallery = () => null;" } } },
          { type: 2, text: "The touch handler calls preventDefault before the click fires, so taps never reach the arrows." },
          { type: 1, text: "What is the smallest fix?" },
          { type: 2, tool: { name: "run_terminal_command_v2", rawArgs: { command: "npm test" }, result: { output: "12 passing" } } },
          { type: 2, text: "Only call preventDefault after a real swipe (more than 10 px). Tests pass." },
        ],
      },
      {
        id: "22222222-bbbb-4bbb-8bbb-222222222222", workspaceId: "a".repeat(32), name: "", createdAt: t("2026-07-01T08:00:00Z"), updatedAt: t("2026-07-01T08:30:00Z"),
        bubbles: [{ type: 1, text: "", richText: JSON.stringify({ root: { children: [{ children: [{ text: "Rename the " }, { type: "mention", mentionName: "Button" }, { text: " component" }] }] } }) }, { type: 2, text: "Done: Button is now ActionButton." }],
      },
      {
        id: "33333333-cccc-4ccc-8ccc-333333333333", workspaceId: "b".repeat(32), name: "Other project chat", createdAt: t("2026-08-01T08:00:00Z"), updatedAt: t("2026-08-01T08:30:00Z"), index: "item",
        bubbles: [{ type: 1, text: "Hello other" }, { type: 2, text: "Hi" }],
      },
      {
        id: "44444444-dddd-4ddd-8ddd-444444444444", workspaceId: "a".repeat(32), name: "Archived chat", createdAt: t("2026-06-01T08:00:00Z"), updatedAt: t("2026-06-01T08:30:00Z"), archived: true, inline: true, index: "workspace",
        bubbles: [{ type: 1, text: "Old inline chat" }, { type: 2, text: "Old inline answer" }],
      },
      { id: "55555555-eeee-4eee-8eee-555555555555", workspaceId: "a".repeat(32), name: "A subagent", createdAt: t("2026-07-13T08:00:00Z"), updatedAt: t("2026-07-13T08:30:00Z"), subagent: true, bubbles: [{ type: 1, text: "sub" }, { type: 2, text: "agent" }] },
      { id: "66666666-ffff-4fff-8fff-666666666666", workspaceId: "a".repeat(32), name: "", createdAt: t("2026-09-09T18:00:00Z"), updatedAt: t("2026-09-09T18:00:00Z"), bubbles: [] },
      { id: "77777777-0000-4000-8000-777777777777", workspaceId: "a".repeat(32), name: "Deleted chat", createdAt: t("2026-09-01T18:00:00Z"), updatedAt: t("2026-09-01T18:00:00Z"), missing: true, bubbles: [{ type: 1, text: "gone" }] },
    ],
    legacy: [{ workspaceId: "b".repeat(32), tabId: "88888888-1111-4111-8111-888888888888", chatTitle: "Legacy tab", lastSendTime: t("2024-06-01T10:00:00Z"), bubbles: [{ type: "user", text: "Old style question" }, { type: "ai", text: "Old style answer" }] }],
  };
}
