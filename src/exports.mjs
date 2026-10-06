// The data exports of claude.ai and ChatGPT (Settings, Export data: a conversations.json), and
// this tool's own JSON. One file can hold many conversations; `pick` chooses one.
import fs from "node:fs";
import path from "node:path";
import { appendText, conversation, finish, turn } from "./model.mjs";
import { cmp, firstLine, isoOf, oneLine, tryParse } from "./util.mjs";

export const JSON_FORMAT = "claude-chat-ferry/1";

export function loadJsonFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { throw new Error(`cannot read ${file}: ${e.message}`); }
  try { return JSON.parse(text.replace(/^﻿/, "")); } catch { throw new Error(`${path.basename(file)} is not JSON`); }
}

// What a JSON file is: "claude-ai", "chatgpt", "ferry" (this tool's JSON), "messages" (a plain
// list of { role, content } messages, as Cline's api_conversation_history.json and many scripts
// write), or "" when unknown.
export function detectJson(data) {
  const first = Array.isArray(data) ? data[0] : data;
  if (!first || typeof first !== "object") return "";
  if (first.format === JSON_FORMAT || (Array.isArray(first.turns) && "tool" in first)) return "ferry";
  if (Array.isArray(first.chat_messages)) return "claude-ai";
  if (first.mapping && typeof first.mapping === "object") return "chatgpt";
  if (Array.isArray(data) && typeof first.role === "string" && "content" in first) return "messages";
  if (Array.isArray(first.messages) && first.messages.length && typeof first.messages[0]?.role === "string") return "messages";
  return "";
}

// --- a plain list of messages ---------------------------------------------------------------------

function messagesConversation(data, file) {
  const list = Array.isArray(data) ? data : data.messages;
  const conv = conversation({ tool: "json", id: String((!Array.isArray(data) && (data.id || data.conversation_id)) || ""), title: String((!Array.isArray(data) && (data.title || data.name)) || ""), source: file, model: !Array.isArray(data) && typeof data.model === "string" ? data.model : "" });
  const pending = new Map();
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "user" || m.role === "human" ? "user" : m.role === "assistant" || m.role === "model" || m.role === "ai" ? "assistant" : m.role === "tool" ? "tool" : "";
    const blocks = Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.parts) ? m.parts.map((p) => (typeof p === "string" ? { type: "text", text: p } : p)) : [];
    const at = isoOf(m.created_at || m.timestamp || m.ts || m.time);
    if (role === "tool") {
      const last = conv.turns[conv.turns.length - 1];
      if (last?.role === "assistant" && last.tools.length) { const open = last.tools.find((x) => !x.output) || last.tools[last.tools.length - 1]; open.output = blocks.filter((b) => b?.type === "text" || typeof b?.text === "string").map((b) => b.text).join("\n") || String(m.content ?? ""); }
      continue;
    }
    if (!role) continue;
    const t = turn(role, { at });
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if ((b.type === "text" || b.type === "input_text" || b.type === "output_text") && typeof b.text === "string") appendText(t, b.text);
      else if (b.type === "thinking" && typeof b.thinking === "string") t.thinking = t.thinking ? `${t.thinking}\n\n${b.thinking}` : b.thinking;
      else if (b.type === "tool_use") { const tool = { name: String(b.name || "tool"), input: b.input ?? {}, output: "" }; t.tools.push(tool); if (b.id) pending.set(b.id, tool); }
      else if (b.type === "tool_result") { const tool = pending.get(b.tool_use_id); if (tool) { tool.output = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x) => x?.text || "").join("\n") : ""; pending.delete(b.tool_use_id); } }
      else if (b.type === "image" || b.type === "image_url") appendText(t, "[image]");
    }
    if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) t.tools.push({ name: String(c?.function?.name || c?.name || "tool"), input: tryParse(c?.function?.arguments) ?? c?.function?.arguments ?? c?.args ?? {}, output: "" });
    conv.turns.push(t);
  }
  return finish(conv);
}

// --- claude.ai -----------------------------------------------------------------------------------

function claudeAiConversation(c, file) {
  const conv = conversation({ tool: "claude-ai", id: String(c.uuid || ""), title: String(c.name || ""), startedAt: isoOf(c.created_at), endedAt: isoOf(c.updated_at), source: file, model: typeof c.model === "string" ? c.model : "" });
  for (const m of c.chat_messages || []) {
    const role = m?.sender === "human" ? "user" : m?.sender === "assistant" ? "assistant" : "";
    if (!role) continue;
    const t = turn(role, { at: isoOf(m.created_at) });
    const blocks = Array.isArray(m.content) ? m.content : [];
    const texts = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text);
    appendText(t, texts.length ? texts.join("\n\n") : typeof m.text === "string" ? m.text : "");
    for (const b of blocks) {
      if (b?.type === "tool_use") t.tools.push({ name: String(b.name || "tool"), input: b.input ?? {}, output: "" });
      else if (b?.type === "tool_result" && t.tools.length) { const last = t.tools[t.tools.length - 1]; if (!last.output) last.output = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x) => x?.text || "").join("\n") : ""; }
    }
    const names = [...(m.attachments || []), ...(m.files || [])].map((a) => a?.file_name || a?.name).filter(Boolean);
    if (names.length) appendText(t, `(Attached: ${names.join(", ")})`);
    conv.turns.push(t);
  }
  return finish(conv);
}

// --- ChatGPT -------------------------------------------------------------------------------------

function chatgptConversation(c, file) {
  const conv = conversation({ tool: "chatgpt", id: String(c.id || c.conversation_id || ""), title: String(c.title || ""), startedAt: isoOf(c.create_time), endedAt: isoOf(c.update_time), source: file, model: typeof c.default_model_slug === "string" ? c.default_model_slug : "" });
  const mapping = c.mapping || {};
  // The conversation the person last saw: from current_node up to the root, then reversed.
  let id = c.current_node;
  if (!id || !mapping[id]) {
    // No current node: take the longest chain from the root.
    const roots = Object.values(mapping).filter((n) => !n?.parent);
    let best = [];
    const walk = (n, chain) => { chain = [...chain, n.id]; if (chain.length > best.length) best = chain; for (const ch of n.children || []) if (mapping[ch]) walk(mapping[ch], chain); };
    for (const r of roots) walk(r, []);
    id = best[best.length - 1];
  }
  const chain = [];
  const seen = new Set();
  while (id && mapping[id] && !seen.has(id)) { seen.add(id); chain.push(mapping[id]); id = mapping[id].parent; }
  chain.reverse();
  for (const node of chain) {
    const m = node?.message;
    if (!m) continue;
    const role = m.author?.role === "user" ? "user" : m.author?.role === "assistant" ? "assistant" : "";
    const content = m.content || {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    let text = "";
    if (content.content_type === "code" && typeof content.text === "string") text = `\`\`\`${content.language || ""}\n${content.text}\n\`\`\``;
    else text = parts.map((p) => (typeof p === "string" ? p : p?.text || (p?.content_type?.includes("image") ? "[image]" : ""))).filter(Boolean).join("\n");
    if (!role) {
      // A tool's message: attach as a tool entry of the current assistant turn.
      if (m.author?.role === "tool" && text.trim()) {
        const last = conv.turns[conv.turns.length - 1];
        const t = last && last.role === "assistant" ? last : turn("assistant", { at: isoOf(m.create_time) });
        if (t !== last) conv.turns.push(t);
        t.tools.push({ name: String(m.author?.name || "tool"), input: {}, output: text });
      }
      continue;
    }
    if (!text.trim()) continue;
    if (m.metadata?.is_visually_hidden_from_conversation) continue;
    conv.turns.push(turn(role, { at: isoOf(m.create_time), text }));
    if (!conv.model && typeof m.metadata?.model_slug === "string") conv.model = m.metadata.model_slug;
  }
  return finish(conv);
}

// --- this tool's JSON ----------------------------------------------------------------------------

export function toJson(conv) {
  return JSON.stringify({ format: JSON_FORMAT, ...conv, turns: conv.turns.map((t) => ({ role: t.role, at: t.at, text: t.text, thinking: t.thinking, tools: t.tools })) }, null, 2) + "\n";
}
export function fromJson(data, file = "") {
  const d = Array.isArray(data) ? data[0] : data;
  if (!d || !Array.isArray(d.turns)) throw new Error(`${path.basename(file) || "the JSON"} has no turns`);
  const conv = conversation({ ...d, tool: d.tool || "json", source: file || d.source || "", turns: [] });
  delete conv.format;
  for (const t of d.turns) {
    if (!t || (t.role !== "user" && t.role !== "assistant")) continue;
    conv.turns.push(turn(t.role, { at: isoOf(t.at), text: String(t.text || ""), thinking: String(t.thinking || ""), tools: Array.isArray(t.tools) ? t.tools.map((x) => ({ name: String(x?.name || "tool"), input: x?.input ?? {}, output: typeof x?.output === "string" ? x.output : "" })) : [] }));
  }
  return finish(conv);
}

// --- a file with many conversations ---------------------------------------------------------------

// The conversations in a JSON file: [{ index, tool, id, title, startedAt, updatedAt, messages }].
export function listJsonFile(file) {
  const data = loadJsonFile(file);
  const kind = detectJson(data);
  if (!kind) throw new Error(`${path.basename(file)} is not a claude.ai export, a ChatGPT export, a list of messages or claude-chat-ferry JSON`);
  if (kind === "messages") {
    const c = messagesConversation(data, file);
    return { kind, items: [{ index: 0, tool: "json", id: c.id, title: c.title, startedAt: c.startedAt, updatedAt: c.endedAt, messages: (Array.isArray(data) ? data : data.messages).length }] };
  }
  const items = Array.isArray(data) ? data : [data];
  const out = items.map((c, index) => {
    if (kind === "claude-ai") return { index, tool: "claude-ai", id: String(c.uuid || ""), title: String(c.name || "") || "(untitled)", startedAt: isoOf(c.created_at), updatedAt: isoOf(c.updated_at), messages: (c.chat_messages || []).length };
    if (kind === "chatgpt") return { index, tool: "chatgpt", id: String(c.id || c.conversation_id || ""), title: String(c.title || "") || "(untitled)", startedAt: isoOf(c.create_time), updatedAt: isoOf(c.update_time), messages: Object.values(c.mapping || {}).filter((n) => n?.message?.author?.role === "user" || n?.message?.author?.role === "assistant").length };
    return { index, tool: c.tool || "json", id: String(c.id || ""), title: String(c.title || "") || "(untitled)", startedAt: isoOf(c.startedAt), updatedAt: isoOf(c.endedAt), messages: (c.turns || []).length };
  });
  return { kind, items: out.sort((a, b) => cmp(b.updatedAt, a.updatedAt) || a.index - b.index) };
}

// One conversation of a JSON file. pick: an index (1-based, in the file's order), an id or its
// start, or words of the title; "" when the file holds one conversation, or "latest".
export function readJsonFile(file, pick = "") {
  const data = loadJsonFile(file);
  const kind = detectJson(data);
  if (!kind) throw new Error(`${path.basename(file)} is not a claude.ai export, a ChatGPT export, a list of messages or claude-chat-ferry JSON`);
  if (kind === "messages") return messagesConversation(data, file);
  const items = Array.isArray(data) ? data : [data];
  const { items: listed } = listJsonFile(file);
  let chosen;
  const p = String(pick ?? "").trim();
  if (items.length === 1 && !p) chosen = 0;
  else if (!p || p === "latest") {
    if (!p && items.length > 1) throw new Error(`${path.basename(file)} holds ${items.length} conversations: add --pick <number, id or title words> (see "list ${path.basename(file)}")`);
    chosen = listed[0].index;
  } else if (/^\d+$/.test(p) && Number(p) >= 1 && Number(p) <= items.length) chosen = Number(p) - 1;
  else {
    const needle = p.toLowerCase();
    const byId = listed.filter((x) => x.id.toLowerCase().startsWith(needle));
    const byTitle = listed.filter((x) => x.title.toLowerCase().includes(needle));
    const hits = byId.length ? byId : byTitle;
    if (!hits.length) throw new Error(`no conversation in ${path.basename(file)} matches "${p}"`);
    if (hits.length > 1) throw new Error(`"${p}" matches ${hits.length} conversations in ${path.basename(file)}: ${hits.slice(0, 5).map((h) => `${h.index + 1} ${oneLine(h.title, 40)}`).join("; ")}`);
    chosen = hits[0].index;
  }
  const c = items[chosen];
  const label = `${file}#${chosen + 1}`;
  if (kind === "claude-ai") return claudeAiConversation(c, label);
  if (kind === "chatgpt") return chatgptConversation(c, label);
  return fromJson(c, label);
}

export const titleFromData = (c) => firstLine(c?.title || c?.name || "", 70);
