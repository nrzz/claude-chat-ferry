// Claude Code's sessions: where they are, how to read one into a conversation, how to list them,
// and how to write one that `claude --resume <id>` continues.
//
// <configDir>/projects/<slug>/<sessionId>.jsonl   one session, one JSON record per line
// configDir is $CLAUDE_CONFIG_DIR, or ~/.claude. The slug is the working directory with every
// character that is not a letter or digit replaced by "-".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendText, conversation, finish, toolLine, toolName, turn } from "./model.mjs";
import { capText, cmp, firstLine, forEachLine, isInside, listDir, mtimeIso, oneLine, tryParse, utcDay, writeFileAtomic } from "./util.mjs";

const IS_WIN = process.platform === "win32";

export function homeDir(env = process.env) {
  const fromEnv = IS_WIN ? env.USERPROFILE || env.HOME : env.HOME;
  return fromEnv || os.homedir();
}
export function claudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(homeDir(env), ".claude");
}
export const projectsDir = (env = process.env) => path.join(claudeDir(env), "projects");

// The folder name Claude Code uses under projects/ for a working directory (Claude Code 2.1.x).
export function projectSlug(p) {
  const s = String(p).replace(/[^a-zA-Z0-9]/g, "-");
  if (s.length <= 200) return s;
  let h = 0;
  for (let i = 0; i < p.length; i++) h = ((h << 5) - h + p.charCodeAt(i)) | 0;
  return `${s.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}
// The folder a session of `cwd` goes in: Claude Code 2.1.234 and newer let CLAUDE_CODE_PROJECT_DIR_NAME
// name it; otherwise it is the slug.
export const projectDirName = (cwd, env = process.env) => (env.CLAUDE_CODE_PROJECT_DIR_NAME ? String(env.CLAUDE_CODE_PROJECT_DIR_NAME) : projectSlug(cwd));

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
// One injected element such as <ide_opened_file>...</ide_opened_file>: nothing the person typed.
const WRAPPER = /^<([a-z][a-z0-9]*[-_][a-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/;

// What a user text block says, as the person said it: "/name args" for a slash command, "! cmd"
// for a shell command, "" for everything Claude Code wrote in their name.
export function promptText(raw) {
  const t = String(raw ?? "").replace(REMINDER, "").trim();
  if (!t) return "";
  let m;
  if ((m = t.match(/^(?:<command-message>[\s\S]*?<\/command-message>\s*)?<command-name>\s*([^<]*?)\s*<\/command-name>/))) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const a = args ? args[1].trim() : "";
    return `${m[1]}${a ? ` ${a}` : ""}`;
  }
  if ((m = t.match(/^<bash-input>([\s\S]*?)<\/bash-input>$/))) return `! ${m[1].trim()}`;
  if (/^<(?:bash-std|local-command-)/.test(t) || WRAPPER.test(t) || /^Caveat:/.test(t) || /^\[Request interrupted/.test(t)) return "";
  return t;
}

export function titleOf(rec) {
  if (rec.type === "custom-title" && rec.customTitle) return { custom: String(rec.customTitle) };
  if (rec.type === "ai-title" && rec.aiTitle) return { ai: String(rec.aiTitle) };
  if (rec.type === "summary" && typeof rec.summary === "string" && rec.summary.length <= 160) return { summary: rec.summary };
  return null;
}
const pickTitle = (t) => t.custom || t.ai || t.summary || "";

// Reads one session file into a conversation. Subagent transcripts, hook context and the records
// Claude Code keeps beside the conversation are left out; a compaction summary stays, as a user
// turn, because it is what the model knew from then on.
export function readSession(file) {
  const conv = conversation({ tool: "claude-code", id: path.basename(file, ".jsonl"), source: file });
  const titles = {};
  const pending = new Map(); // tool_use id -> tool entry waiting for its result
  let current = null; // the assistant turn being built
  let first = "";
  let last = "";
  forEachLine(file, (line) => {
    const rec = tryParse(line);
    if (!rec || typeof rec !== "object") return;
    const t = titleOf(rec);
    if (t) Object.assign(titles, t);
    if (rec.isSidechain) return;
    if (!conv.project && typeof rec.cwd === "string") conv.project = rec.cwd;
    if (rec.timestamp) { if (!first) first = rec.timestamp; last = rec.timestamp; }
    if (rec.type === "user") {
      const content = rec.message?.content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      if (rec.isCompactSummary) {
        const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim();
        if (text) { conv.turns.push(turn("user", { at: rec.timestamp || "", text })); current = null; }
        return;
      }
      if (rec.isMeta) return;
      const texts = [];
      let images = 0;
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "tool_result") {
          const entry = pending.get(b.tool_use_id);
          if (entry) { entry.output = resultText(b.content); pending.delete(b.tool_use_id); }
        } else if (b.type === "image" || b.type === "document") images++;
        else if (b.type === "text") { const s = promptText(b.text); if (s) texts.push(s); }
      }
      if (images) texts.push(`[${images} image${images === 1 ? "" : "s"} attached]`);
      if (texts.length) { conv.turns.push(turn("user", { at: rec.timestamp || "", text: texts.join("\n\n") })); current = null; }
    } else if (rec.type === "assistant") {
      const blocks = Array.isArray(rec.message?.content) ? rec.message.content : [];
      if (!current) { current = turn("assistant", { at: rec.timestamp || "" }); conv.turns.push(current); }
      if (!conv.model && typeof rec.message?.model === "string") conv.model = rec.message.model;
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text") appendText(current, b.text);
        else if (b.type === "thinking" && typeof b.thinking === "string") current.thinking = current.thinking ? `${current.thinking}\n\n${b.thinking}` : b.thinking;
        else if (b.type === "tool_use") { const entry = { name: String(b.name || "tool"), input: b.input ?? {}, output: "" }; current.tools.push(entry); if (b.id) pending.set(b.id, entry); }
      }
    }
  });
  conv.title = pickTitle(titles);
  conv.startedAt = first;
  conv.endedAt = last;
  return finish(conv);
}

// The text of a tool result: a string, or the text blocks of a list.
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
  return "";
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

// Title, first prompt, prompt count and working directory, by reading the file once and parsing
// only the lines that can matter.
export function scanSession(file) {
  const info = { title: "", firstPrompt: "", prompts: 0, cwd: "", started: "" };
  const titles = {};
  let head = 0;
  forEachLine(file, (line) => {
    if (line.includes('"isSidechain":true')) return;
    const needHead = head < 40 && !(info.cwd && info.started);
    const isTitle = line.includes('-title"') || line.includes('"type":"summary"');
    const isUser = line.includes('"type":"user"') && !line.includes('"tool_result"');
    if (!(needHead || isTitle || isUser)) return;
    if (needHead) head++;
    const rec = tryParse(line);
    if (!rec || typeof rec !== "object") return;
    if (!info.cwd && typeof rec.cwd === "string") info.cwd = rec.cwd;
    if (!info.started && rec.cwd && rec.timestamp) info.started = rec.timestamp;
    const t = titleOf(rec);
    if (t) Object.assign(titles, t);
    if (rec.type === "user" && !rec.isMeta && !rec.isCompactSummary) {
      const content = rec.message?.content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      const text = blocks.filter((b) => b?.type === "text").map((b) => promptText(b.text)).filter(Boolean).join(" ");
      if (text) { info.prompts++; if (!info.firstPrompt) info.firstPrompt = text; }
    }
  });
  info.title = pickTitle(titles) || firstLine(info.firstPrompt, 70) || "(untitled)";
  return info;
}

const isSessionFile = (name) => /^[0-9a-f-]{36}\.jsonl$/i.test(name);

// Every session: { tool, id, file, slug, updatedAt }, newest first. With `project`, only the
// sessions of that folder (and of folders inside it); `all` lists every project.
export function sessionFiles({ env = process.env, project = "", all = false } = {}) {
  const root = projectsDir(env);
  const out = [];
  for (const d of listDir(root)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    for (const f of listDir(dir)) {
      if (!f.isFile() || !isSessionFile(f.name)) continue;
      const file = path.join(dir, f.name);
      out.push({ tool: "claude-code", id: f.name.slice(0, -6), file, slug: d.name, updatedAt: mtimeIso(file) });
    }
  }
  out.sort((a, b) => cmp(b.updatedAt, a.updatedAt) || cmp(a.id, b.id));
  if (all || !project) return out;
  // The slug is cheap to compare; the recorded cwd settles folders inside the project.
  const mine = projectSlug(project);
  const named = projectDirName(project, env);
  return out.filter((s) => s.slug === mine || s.slug === named || (s.slug.startsWith(mine + "-") && isInside(project, quickCwd(s.file))));
}
function quickCwd(file) {
  let cwd = "";
  let n = 0;
  forEachLine(file, (line) => { const rec = tryParse(line); if (rec && typeof rec.cwd === "string") { cwd = rec.cwd; return false; } return ++n < 40; });
  return cwd;
}

// The sessions `list` shows: the newest `limit` with their title and size.
export function listSessions({ env = process.env, project = "", all = false, limit = 20 } = {}) {
  return sessionFiles({ env, project, all }).slice(0, limit).map((s) => {
    const info = scanSession(s.file);
    return { ...s, title: info.title, prompts: info.prompts, project: info.cwd, startedAt: info.started };
  });
}

// "latest", or the start of a session id: the matching session file, or null.
export function findSession(ref, { env = process.env, project = "", all = false } = {}) {
  const files = sessionFiles({ env, project, all: all || ref !== "latest" });
  if (ref === "latest") return files.find((s) => s.prompts === undefined ? scanSession(s.file).prompts > 0 : true) || null;
  const needle = ref.toLowerCase();
  const hits = files.filter((s) => s.id.toLowerCase().startsWith(needle));
  if (hits.length > 1 && !files.some((s) => s.id.toLowerCase() === needle)) {
    throw new Error(`"${ref}" matches ${hits.length} sessions; give more of the id`);
  }
  return hits.find((s) => s.id.toLowerCase() === needle) || hits[0] || null;
}

// ---------------------------------------------------------------------------------------------
// Writing: a session file Claude Code continues
// ---------------------------------------------------------------------------------------------

// The text of an assistant turn as the model should see it again: the answer, then one line per
// tool call ("brief"), with the tool's output in a block ("full"), or the answer alone ("none").
export function renderAssistant(t, { tools = "brief", thinking = false, outputMax = 2000 } = {}) {
  const parts = [];
  if (thinking && t.thinking) parts.push(`(Thinking: ${t.thinking.trim()})`);
  if (t.text) parts.push(t.text);
  if (tools !== "none" && t.tools.length) {
    const lines = t.tools.map((tool) => {
      const line = `(Used ${toolLine(tool)})`;
      if (tools === "full" && tool.output) return `${line}\n\`\`\`\n${capText(String(tool.output), outputMax)}\n\`\`\``;
      return line;
    });
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n").trim();
}

// The records of a session file for a conversation. Turns of one role are joined, the first
// record is a user record (a banner says where the chat came from), and every timestamp is later
// than the one before it.
export function sessionRecords(conv, { id, cwd, title, tools = "brief", thinking = false, banner = true, model = "", now = new Date() } = {}) {
  const sessionId = id || randomUUID();
  const texts = [];
  for (const t of conv.turns) {
    const text = t.role === "assistant" ? renderAssistant(t, { tools, thinking }) : String(t.text || "").trim();
    if (!text) continue;
    const last = texts[texts.length - 1];
    if (last && last.role === t.role) { last.text += `\n\n${text}`; continue; }
    texts.push({ role: t.role, text, at: t.at || "" });
  }
  const from = `${toolName(conv.tool)}${conv.title && conv.title !== "(untitled)" ? ` chat "${oneLine(conv.title, 80)}"` : ""}${conv.startedAt ? `, ${utcDay(conv.startedAt)}` : ""}`;
  const bannerText = `[Conversation imported from ${from} by claude-chat-ferry. It continues from here.]`;
  if (banner) {
    if (texts.length && texts[0].role === "user") texts[0].text = `${bannerText}\n\n${texts[0].text}`;
    else texts.unshift({ role: "user", text: bannerText, at: "" });
  } else if (!texts.length || texts[0].role !== "user") {
    texts.unshift({ role: "user", text: "(The conversation below was imported; it begins with the assistant.)", at: "" });
  }
  // Times: the original ones when they are in order, otherwise one second apart, ending now.
  let stamp = (Date.parse(conv.startedAt) || now.getTime() - (texts.length - 1) * 1000) - 1000;
  const records = [];
  let parent = null;
  const uuids = [];
  const finalTitle = oneLine(title || conv.title || "Imported conversation", 120);
  records.push({ type: "custom-title", customTitle: finalTitle, sessionId });
  texts.forEach((m, i) => {
    const own = Date.parse(m.at);
    stamp = Number.isFinite(own) && own > stamp ? own : stamp + 1000;
    const uuid = randomUUID();
    uuids.push(uuid);
    const base = { parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId, uuid, timestamp: new Date(stamp).toISOString() };
    if (m.role === "user") {
      records.push({ ...base, type: "user", message: { role: "user", content: [{ type: "text", text: m.text }] } });
    } else {
      records.push({
        ...base, type: "assistant", requestId: `req_import_${i + 1}`,
        message: { id: `msg_import_${i + 1}`, type: "message", role: "assistant", model: model || conv.model || "imported", content: [{ type: "text", text: m.text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      });
    }
    parent = uuid;
  });
  records.splice(1, 0, { type: "summary", summary: finalTitle, leafUuid: uuids[uuids.length - 1] || null });
  return { sessionId, records, title: finalTitle, messages: texts.length };
}

// Writes <configDir>/projects/<slug of cwd>/<id>.jsonl and returns { id, file, title, messages }.
// A session id is never reused: an existing file with that name is an error.
export function writeSession(conv, { env = process.env, cwd, ...opts } = {}) {
  const dir = path.join(projectsDir(env), projectDirName(cwd, env));
  const { sessionId, records, title, messages } = sessionRecords(conv, { ...opts, cwd });
  const file = path.join(dir, `${sessionId}.jsonl`);
  if (fs.existsSync(file)) throw new Error(`a session ${sessionId} already exists`);
  writeFileAtomic(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { id: sessionId, file, title, messages };
}
