// Cursor's chats, read from its own store (never written to).
//
// <userDir>/globalStorage/state.vscdb            one SQLite database for everything
//   composerHeaders (table)                      one row per chat since Cursor 2.x: id, workspace,
//                                                times, and a JSON value with the name
//   cursorDiskKV: composerData:<composerId>      the chat: name, times, the list of its messages
//                 bubbleId:<composerId>:<bubbleId>  one message ("bubble"): type 1 the person,
//                                                2 the assistant; text, thinking, a tool call
//   ItemTable: composer.composerHeaders           the older index of chats (allComposers)
// <userDir>/workspaceStorage/<id>/workspace.json  which folder a workspace id is
// <userDir>/workspaceStorage/<id>/state.vscdb     the oldest index (composer.composerData) and
//                                                the pre-composer chats (aichat.chatdata)
// userDir is %APPDATA%\Cursor\User, ~/Library/Application Support/Cursor/User or ~/.config/Cursor/User;
// CURSOR_USER_DIR overrides it. Checked against Cursor 3.19 on 2026-10-06.
import os from "node:os";
import path from "node:path";
import { appendText, conversation, finish, turn } from "./model.mjs";
import { blobJson, hasTable, openReadOnly } from "./sqlite.mjs";
import { cmp, firstLine, isFile, isoOf, listDir, readJson, sameProject, tryParse } from "./util.mjs";

export function cursorUserDir(env = process.env, platform = process.platform) {
  if (env.CURSOR_USER_DIR) return path.resolve(env.CURSOR_USER_DIR);
  const home = (platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME) || os.homedir();
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor", "User");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Cursor", "User");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Cursor", "User");
}
export const globalDb = (userDir) => path.join(userDir, "globalStorage", "state.vscdb");

// "file:///d%3A/Projects/x" -> "d:\Projects\x" on Windows, "file:///home/me/x" -> "/home/me/x".
export function folderOfUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return String(uri || "");
  let p;
  try { p = decodeURIComponent(uri.slice("file://".length)); } catch { p = uri.slice("file://".length); }
  p = p.replace(/^\/+/, "/");
  if (/^\/[a-zA-Z]:\//.test(p)) return p.slice(1).replace(/\//g, "\\");
  if (/^\/[a-zA-Z]:$/.test(p)) return `${p.slice(1)}\\`;
  return p;
}

// Every workspace Cursor has opened: { id, folder, dir }.
export function workspaces(userDir) {
  const out = [];
  for (const d of listDir(path.join(userDir, "workspaceStorage"))) {
    if (!d.isDirectory()) continue;
    const dir = path.join(userDir, "workspaceStorage", d.name);
    const w = readJson(path.join(dir, "workspace.json"));
    const uri = w?.folder || w?.workspace || "";
    out.push({ id: d.name, folder: folderOfUri(uri), dir });
  }
  return out;
}

const bubbleText = (b) => {
  if (typeof b?.text === "string" && b.text.trim()) return b.text;
  return richTextToPlain(b?.richText);
};
// Cursor stores what the person typed as Lexical JSON too; when `text` is empty, read its text nodes.
export function richTextToPlain(richText) {
  const doc = typeof richText === "string" ? tryParse(richText) : richText;
  if (!doc || typeof doc !== "object") return "";
  const lines = [];
  const walk = (node, line) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.text === "string") line.push(node.text);
    if (node.type === "mention" && node.mentionName) line.push(`@${node.mentionName}`);
    for (const c of node.children || []) walk(c, line);
  };
  for (const p of doc.root?.children || []) { const line = []; walk(p, line); lines.push(line.join("")); }
  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

// Every chat Cursor has: { tool: "cursor", id, title, project, workspaceId, startedAt, updatedAt,
// kind, source }, newest first. With `project`, only the chats of that folder; with `all`, every
// folder. Subagent chats (Cursor's own helpers) are left out.
export async function listChats({ env = process.env, project = "", all = false, limit = 0 } = {}) {
  const userDir = cursorUserDir(env);
  const file = globalDb(userDir);
  const ws = workspaces(userDir);
  const folderOf = (id) => ws.find((w) => w.id === id)?.folder || "";
  const byId = new Map();
  const add = (c) => { const prev = byId.get(c.id); byId.set(c.id, prev ? { ...prev, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== "" && v !== undefined)) } : c); };
  if (isFile(file)) {
    const db = await openReadOnly(file);
    try {
      // The header also names the folder (workspaceIdentifier.uri), for a workspace whose storage is gone.
      const folderOfHeader = (v) => { const u = v?.workspaceIdentifier?.uri; return typeof u?.fsPath === "string" ? u.fsPath : typeof u?.path === "string" && u.scheme === "file" ? folderOfUri(`file://${u.path}`) : typeof u === "string" ? folderOfUri(u) : ""; };
      if (hasTable(db, "composerHeaders")) {
        for (const r of db.prepare("select composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, value from composerHeaders").all()) {
          if (r.isSubagent) continue;
          const v = blobJson(r.value) || {};
          add({ tool: "cursor", id: r.composerId, title: String(v.name || ""), workspaceId: r.workspaceId || v.workspaceIdentifier?.id || "", folder: folderOfHeader(v), startedAt: isoOf(r.createdAt || v.createdAt), updatedAt: isoOf(r.lastUpdatedAt || v.lastUpdatedAt || r.createdAt), archived: !!r.isArchived, kind: "composer", source: `composerData:${r.composerId}` });
        }
      }
      if (hasTable(db, "ItemTable")) {
        const row = db.prepare("select value from ItemTable where key = 'composer.composerHeaders'").get();
        for (const c of blobJson(row?.value)?.allComposers || []) {
          if (!c?.composerId || c.isSubagent) continue;
          add({ tool: "cursor", id: c.composerId, title: String(c.name || ""), workspaceId: c.workspaceIdentifier?.id || "", folder: folderOfHeader(c), startedAt: isoOf(c.createdAt), updatedAt: isoOf(c.lastUpdatedAt || c.createdAt), kind: "composer", source: `composerData:${c.composerId}` });
        }
      }
    } finally { db.close(); }
  }
  // The oldest index lives in each workspace, as do the pre-composer chats.
  for (const w of ws) {
    const f = path.join(w.dir, "state.vscdb");
    if (!isFile(f)) continue;
    let db;
    try { db = await openReadOnly(f); } catch { continue; }
    try {
      if (!hasTable(db, "ItemTable")) continue;
      const comp = db.prepare("select value from ItemTable where key = 'composer.composerData'").get();
      for (const c of blobJson(comp?.value)?.allComposers || []) {
        if (!c?.composerId) continue;
        add({ tool: "cursor", id: c.composerId, title: String(c.name || ""), workspaceId: w.id, startedAt: isoOf(c.createdAt), updatedAt: isoOf(c.lastUpdatedAt || c.createdAt), kind: "composer", source: `composerData:${c.composerId}` });
      }
      const legacy = db.prepare("select value from ItemTable where key = 'workbench.panel.aichat.view.aichat.chatdata'").get();
      for (const tab of blobJson(legacy?.value)?.tabs || []) {
        if (!tab?.tabId) continue;
        const bubbles = Array.isArray(tab.bubbles) ? tab.bubbles : [];
        const firstUser = bubbles.find((b) => b?.type === "user");
        add({ tool: "cursor", id: tab.tabId, title: String(tab.chatTitle || "") || firstLine(firstUser?.text || firstUser?.rawText || "", 70), workspaceId: w.id, startedAt: "", updatedAt: isoOf(tab.lastSendTime), kind: "legacy", source: `${w.id}/aichat.chatdata`, messages: bubbles.length, prompts: bubbles.filter((b) => b?.type === "user").length });
      }
    } finally { db.close(); }
  }
  let chats = [...byId.values()].map(({ folder, ...c }) => ({ ...c, project: folderOf(c.workspaceId) || folder || "" }));
  if (project && !all) { const home = (process.platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME) || os.homedir(); chats = chats.filter((c) => c.project && sameProject(c.project, project, home)); }
  chats.sort((a, b) => cmp(b.updatedAt, a.updatedAt) || cmp(a.id, b.id));
  // Each chat's record: how many messages it holds, and a name when the index had none. An index
  // entry whose record is gone (a deleted chat) is dropped; a chat with no messages yet (Cursor
  // makes one for every "New chat") is kept but listed last and never "latest".
  const composers = chats.filter((c) => c.kind === "composer");
  if (composers.length && isFile(file)) {
    const db = await openReadOnly(file);
    try {
      const get = db.prepare("select value from cursorDiskKV where key = ?");
      for (const c of composers) {
        const data = blobJson(get.get(`composerData:${c.id}`)?.value);
        if (!data) { c.missing = true; continue; }
        const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
        c.messages = headers.length || (Array.isArray(data.conversation) ? data.conversation.length : 0);
        c.prompts = headers.length ? headers.filter((h) => h?.type === 1).length : (data.conversation || []).filter((b) => b?.type === 1).length;
        if (!c.title) c.title = String(data.name || "") || (c.prompts ? firstLine(firstUserText(db, c.id, data), 70) : "");
        if (!c.startedAt) c.startedAt = isoOf(data.createdAt);
      }
    } finally { db.close(); }
    chats = chats.filter((c) => !c.missing);
  }
  for (const c of chats) { if (c.messages === undefined) c.messages = 0; if (c.prompts === undefined) c.prompts = 0; if (!c.title) c.title = "(untitled)"; }
  chats.sort((a, b) => (b.prompts > 0) - (a.prompts > 0) || cmp(b.updatedAt, a.updatedAt) || cmp(a.id, b.id));
  return limit > 0 ? chats.slice(0, limit) : chats;
}

function firstUserText(db, composerId, data) {
  const get = db.prepare("select value from cursorDiskKV where key = ?");
  const headers = Array.isArray(data?.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
  for (const h of headers) {
    if (h?.type !== 1) continue;
    const b = blobJson(get.get(`bubbleId:${composerId}:${h.bubbleId}`)?.value);
    const text = bubbleText(b);
    if (text) return text;
  }
  for (const b of Array.isArray(data?.conversation) ? data.conversation : []) {
    if (b?.type === 1) { const text = bubbleText(b); if (text) return text; }
  }
  return "";
}

// "latest", or the start of a chat id: the chat's listing entry, or null.
export async function findChat(ref, opts = {}) {
  const chats = await listChats({ ...opts, all: opts.all || ref !== "latest" });
  if (ref === "latest") return chats.find((c) => c.prompts > 0) || null;
  const needle = ref.toLowerCase();
  const hits = chats.filter((c) => c.id.toLowerCase().startsWith(needle));
  if (hits.length > 1 && !chats.some((c) => c.id.toLowerCase() === needle)) throw new Error(`"${ref}" matches ${hits.length} chats; give more of the id`);
  return hits.find((c) => c.id.toLowerCase() === needle) || hits[0] || null;
}

// ---------------------------------------------------------------------------------------------
// Reading one chat
// ---------------------------------------------------------------------------------------------

// A tool call as Cursor stores it: name, the arguments it sent, and the result it got back.
function toolOf(tf) {
  const input = tryParse(tf.rawArgs) ?? tryParse(tf.params) ?? (typeof tf.rawArgs === "string" ? tf.rawArgs : tf.params ?? {});
  let output = "";
  if (typeof tf.result === "string") { const r = tryParse(tf.result); output = r && typeof r === "object" ? (typeof r.output === "string" ? r.output : typeof r.contents === "string" ? r.contents : JSON.stringify(r)) : tf.result; }
  else if (tf.result && typeof tf.result === "object") output = JSON.stringify(tf.result);
  return { name: String(tf.name || `tool-${tf.tool ?? "?"}`), input: input ?? {}, output };
}

// Adds one bubble to the conversation being built.
function addBubble(conv, b, at) {
  if (!b || typeof b !== "object") return;
  const when = isoOf(b.createdAt) || at || "";
  if (b.type === 1 || b.type === "user") {
    const text = bubbleText(b);
    const files = (b.attachedCodeChunks || []).map((c) => c?.relativeWorkspacePath).filter(Boolean);
    const t = turn("user", { at: when, text });
    if (files.length) appendText(t, `(Attached: ${[...new Set(files)].join(", ")})`);
    if (!t.text) return;
    conv.turns.push(t);
    return;
  }
  const last = conv.turns[conv.turns.length - 1];
  const t = last && last.role === "assistant" ? last : turn("assistant", { at: when });
  if (t !== last) conv.turns.push(t);
  if (!t.at) t.at = when;
  const thoughts = [b.thinking?.text, ...(Array.isArray(b.allThinkingBlocks) ? b.allThinkingBlocks.map((x) => x?.text) : [])].filter((s) => typeof s === "string" && s.trim());
  for (const s of thoughts) if (!t.thinking.includes(s)) t.thinking = t.thinking ? `${t.thinking}\n\n${s}` : s;
  if (b.toolFormerData && typeof b.toolFormerData === "object") t.tools.push(toolOf(b.toolFormerData));
  appendText(t, bubbleText(b));
  if (!conv.model && typeof b.modelInfo?.modelName === "string") conv.model = b.modelInfo.modelName;
}

// Reads one chat (a listing entry from listChats or findChat) into a conversation.
export async function readChat(entry, { env = process.env } = {}) {
  const userDir = cursorUserDir(env);
  const conv = conversation({ tool: "cursor", id: entry.id, title: entry.title === "(untitled)" ? "" : entry.title || "", project: entry.project || "", startedAt: entry.startedAt || "", endedAt: entry.updatedAt || "", source: entry.source || "" });
  if (entry.kind === "legacy") {
    const w = workspaces(userDir).find((x) => x.id === entry.workspaceId);
    const db = await openReadOnly(path.join(w?.dir || "", "state.vscdb"));
    try {
      const data = blobJson(db.prepare("select value from ItemTable where key = 'workbench.panel.aichat.view.aichat.chatdata'").get()?.value);
      const tab = (data?.tabs || []).find((x) => x?.tabId === entry.id);
      if (!tab) throw new Error(`chat ${entry.id} is no longer in Cursor's store`);
      conv.title = conv.title || String(tab.chatTitle || "");
      for (const b of tab.bubbles || []) addBubble(conv, b.type === "user" ? { ...b, type: 1, text: b.text || b.rawText } : { ...b, type: 2, text: b.text || b.rawText }, "");
      if (!conv.model && typeof tab.bubbles?.[0]?.modelType === "string") conv.model = tab.bubbles[0].modelType;
    } finally { db.close(); }
    return finish(conv);
  }
  const db = await openReadOnly(globalDb(userDir));
  try {
    const get = db.prepare("select value from cursorDiskKV where key = ?");
    const data = blobJson(get.get(`composerData:${entry.id}`)?.value);
    if (!data) throw new Error(`chat ${entry.id} is no longer in Cursor's store`);
    conv.title = conv.title || String(data.name || "");
    conv.startedAt = conv.startedAt || isoOf(data.createdAt);
    conv.endedAt = conv.endedAt || isoOf(data.lastUpdatedAt);
    if (typeof data.modelConfig?.modelName === "string") conv.model = data.modelConfig.modelName;
    const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
    if (headers.length) {
      for (const h of headers) addBubble(conv, blobJson(get.get(`bubbleId:${entry.id}:${h.bubbleId}`)?.value) || (h.text ? h : null), isoOf(h.createdAt));
    } else {
      for (const b of Array.isArray(data.conversation) ? data.conversation : []) addBubble(conv, b, "");
    }
  } finally { db.close(); }
  return finish(conv);
}
