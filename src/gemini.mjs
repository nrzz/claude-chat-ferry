// Google Gemini CLI's sessions, read from its local files (never written to).
//
// <GEMINI_CLI_HOME or the home folder>/.gemini/tmp/<project>/chats/session-<time>-<id>.jsonl
//   (older releases: session-*.json, one JSON document). <project> is a short name that
//   <home>/.gemini/projects.json maps to the project folder (older releases: the SHA-256 of the folder).
// One line per record, as Gemini CLI 0.64.0 wrote them (recorded, see the README):
//   { sessionId, projectHash, startTime, lastUpdated, kind }                         the first line
//   { id, timestamp, type: "user", content: [{ text } | { functionResponse }] }      a message
//   { id, timestamp, type: "gemini", content: "text", thoughts: [{ subject, description }],
//     toolCalls: [{ id, name, args, result: [{ functionResponse: { response: { output | error } } }] }],
//     model }
//   { $set: { lastUpdated, ... } }   { $patch: { updates, orderIds, removeIds } }   { $rewindTo: id }
// A message is written again when it changes; the last record of an id wins. $rewindTo drops that
// message and every later one, $patch replaces a message's content and the results of its tool calls,
// $set merges into the metadata. All four are applied here the way Gemini CLI applies them when it
// resumes a session (packages/core/src/services/chatRecordingService.ts).
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { appendText, conversation, finish, turn } from "./model.mjs";
import { cmp, firstLine, forEachLine, isDir, isoOf, listDir, mtimeIso, readJson, sameProject, tryParse } from "./util.mjs";

// GEMINI_CLI_HOME is the folder in which Gemini CLI makes `.gemini`; without it, the home folder is.
export function geminiHome(env = process.env, platform = process.platform) {
  const base = env.GEMINI_CLI_HOME ? path.resolve(env.GEMINI_CLI_HOME) : (platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME) || os.homedir();
  return path.join(base, ".gemini");
}

const CHAT_FILE = /^session-.*\.(json|jsonl)$/i;

function* chatFiles(tmpRoot) {
  for (const entry of listDir(tmpRoot)) {
    if (!entry.isDirectory()) continue;
    const chatsDir = path.join(tmpRoot, entry.name, "chats");
    for (const f of listDir(chatsDir)) if (f.isFile() && CHAT_FILE.test(f.name)) yield { file: path.join(chatsDir, f.name), folder: entry.name };
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// A message's content: a string, one part, or a list of parts. Only the text parts that are not thoughts.
const partsOf = (content) => (Array.isArray(content) ? content : content == null || content === "" ? [] : [content]);
const textOf = (content) => partsOf(content).map((p) => (typeof p === "string" ? p : isObj(p) && typeof p.text === "string" && !p.thought ? p.text : "")).filter(Boolean).join("\n");
// What Gemini CLI puts in front of the first message (its date, system and folder listing) is not the person's words.
const isContext = (text) => /^\s*<(session_context|hook_context)>/.test(text);
const isConversational = (m) => isObj(m) && (m.type === "user" || m.type === "gemini");
const userText = (m) => { const t = textOf(m.content); return isContext(t) ? "" : t; };

// --- the records of one file --------------------------------------------------------------------------

function applyPatch(messages, patch) {
  const m = messages.get(patch.id);
  if (!m) return;
  if ("content" in patch && patch.content !== undefined) m.content = patch.content;
  if (Array.isArray(patch.toolCalls) && Array.isArray(m.toolCalls)) {
    for (const p of patch.toolCalls) {
      const call = isObj(p) ? m.toolCalls.find((c) => c?.id === p.id) : null;
      if (call && "result" in p) call.result = p.result;
    }
  }
}

function applyRecord(state, rec) {
  if (!isObj(rec)) return;
  const { meta, messages } = state;
  if (typeof rec.$rewindTo === "string") {
    const ids = [...messages.keys()];
    const at = ids.indexOf(rec.$rewindTo);
    if (at < 0) messages.clear();
    else for (const id of ids.slice(at)) messages.delete(id);
  } else if (isObj(rec.$patch)) {
    const p = rec.$patch;
    if (typeof p.id === "string") applyPatch(messages, p);
    if (Array.isArray(p.updates)) for (const u of p.updates) if (isObj(u) && typeof u.id === "string") applyPatch(messages, u);
    if (Array.isArray(p.removeIds)) for (const id of p.removeIds) messages.delete(id);
    if (Array.isArray(p.orderIds)) {
      const ordered = p.orderIds.filter((id) => typeof id === "string" && messages.has(id));
      const kept = [...messages.keys()].filter((id) => !ordered.includes(id));
      const all = new Map(messages);
      messages.clear();
      for (const id of [...kept, ...ordered]) messages.set(id, all.get(id));
    }
  } else if (typeof rec.id === "string") {
    messages.set(rec.id, rec);
  } else if (isObj(rec.$set)) {
    if (Array.isArray(rec.$set.messages)) {
      messages.clear();
      for (const m of rec.$set.messages) if (isObj(m) && typeof m.id === "string") messages.set(m.id, m);
    }
    const { messages: _ignored, ...rest } = rec.$set;
    Object.assign(meta, rest);
  } else if (typeof rec.sessionId === "string") {
    const { messages: inline, ...rest } = rec;
    Object.assign(meta, rest);
    if (Array.isArray(inline)) for (const m of inline) if (isObj(m) && typeof m.id === "string") messages.set(m.id, m);
  }
}

// { meta, messages: Map<id, message> } of a whole file; null when it holds no session.
function loadFile(file) {
  const state = { meta: {}, messages: new Map() };
  if (file.toLowerCase().endsWith(".jsonl")) {
    forEachLine(file, (line) => { if (line.trim()) applyRecord(state, tryParse(line)); });
  } else {
    const data = readJson(file);
    if (!isObj(data)) return null;
    const { messages, ...rest } = data;
    Object.assign(state.meta, rest);
    for (const m of Array.isArray(messages) ? messages : []) if (isObj(m) && typeof m.id === "string") state.messages.set(m.id, m);
  }
  return typeof state.meta.sessionId === "string" ? state : null;
}

// --- the project of a session -------------------------------------------------------------------------

const hashOf = (p) => crypto.createHash("sha256").update(p).digest("hex");
function* withParents(p) {
  let cur = path.resolve(p);
  for (;;) {
    yield cur;
    const up = path.dirname(cur);
    if (up === cur) return;
    cur = up;
  }
}

// The registry that maps a project folder's short name to the folder: { projects: { "<folder>": "<name>" } }.
function registry(root) {
  const projects = readJson(path.join(root, "projects.json"))?.projects;
  const byName = new Map();
  if (isObj(projects)) for (const [dir, name] of Object.entries(projects)) if (typeof name === "string" && typeof dir === "string") byName.set(name, dir);
  return byName;
}

// The folders a session was about: `directories` in its metadata when it has them, else the folder
// the registry names for its project folder.
function directoriesOf(meta, folder, names) {
  if (Array.isArray(meta.directories)) {
    const dirs = meta.directories.filter((d) => typeof d === "string" && d);
    if (dirs.length) return dirs;
  }
  const named = names.get(folder);
  return named ? [named] : [];
}

// --- listing ------------------------------------------------------------------------------------------

// Every session: { tool: "gemini", id, title, project, startedAt, updatedAt, source }, newest first.
export function listSessions({ env = process.env, project = "", all = false, limit = 0 } = {}) {
  const root = geminiHome(env);
  const tmp = path.join(root, "tmp");
  const out = [];
  if (!isDir(tmp)) return out;
  const names = registry(root);

  for (const { file, folder } of chatFiles(tmp)) {
    let meta = null;
    let firstUser = "";
    if (file.toLowerCase().endsWith(".jsonl")) {
      // Only the start of the file: the metadata line and the first thing the person said.
      // The metadata line says when the session began; the `$set` lines after it say when it last changed.
      const state = { meta: {}, messages: new Map() };
      let n = 0;
      forEachLine(file, (line) => {
        if (firstUser || n >= 400) { if (line.startsWith('{"$set":{"lastUpdated"')) applyRecord(state, tryParse(line)); return; }
        n++;
        applyRecord(state, tryParse(line));
        if (!firstUser) { const u = [...state.messages.values()].find((m) => m.type === "user" && userText(m).trim()); if (u) firstUser = userText(u); }
      });
      if (typeof state.meta.sessionId === "string") meta = state.meta;
    } else {
      const state = loadFile(file);
      if (state) {
        meta = state.meta;
        const u = [...state.messages.values()].find((m) => m.type === "user" && userText(m).trim());
        if (u) firstUser = userText(u);
      }
    }
    if (!meta) continue;
    const dirs = directoriesOf(meta, folder, names);
    const updated = isoOf(meta.lastUpdated) || mtimeIso(file);
    out.push({
      tool: "gemini",
      id: String(meta.sessionId),
      title: firstLine(firstUser, 70) || "(untitled)",
      project: dirs[0] || "",
      startedAt: isoOf(meta.startTime) || updated,
      updatedAt: updated,
      source: file,
      _dirs: dirs,
      _hash: typeof meta.projectHash === "string" ? meta.projectHash : "",
    });
  }

  let sessions = out;
  if (project && !all) {
    const home = (process.platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME) || os.homedir();
    sessions = sessions.filter((s) => {
      if (s._dirs.some((d) => sameProject(d, project, home))) return true;
      if (s._dirs.length || !s._hash) return false;
      // No folder is recorded: the hash of the project folder (or of a folder around it) is.
      for (const p of withParents(project)) {
        if (p === path.resolve(home) || p === path.parse(p).root) break;
        if (hashOf(p) === s._hash) { s.project = p; return true; }
      }
      return false;
    });
  }
  for (const s of sessions) { delete s._dirs; delete s._hash; }
  sessions.sort((a, b) => cmp(b.updatedAt, a.updatedAt) || cmp(a.id, b.id));
  return limit > 0 ? sessions.slice(0, limit) : sessions;
}

export function findSession(ref, opts = {}) {
  const all = listSessions({ ...opts, all: opts.all || ref !== "latest" });
  if (ref === "latest") return all[0] || null;
  const needle = ref.toLowerCase();
  const hits = all.filter((s) => s.id.toLowerCase().startsWith(needle));
  if (hits.length > 1 && !all.some((s) => s.id.toLowerCase() === needle)) {
    throw new Error(`"${ref}" matches ${hits.length} sessions; give more of the id`);
  }
  return hits.find((s) => s.id.toLowerCase() === needle) || hits[0] || null;
}

// --- reading ------------------------------------------------------------------------------------------

// A thought is { subject, description }; Gemini CLI itself shows it as "**subject** description".
const thoughtText = (t) => (typeof t === "string" ? t : isObj(t) ? (t.subject ? `**${t.subject}** ${t.description || ""}` : String(t.description || "")).trim() : "");

// What a tool call returned: the parts of its result, a functionResponse's `output` or `error`.
function resultText(result) {
  return partsOf(result).map((p) => {
    if (typeof p === "string") return p;
    if (!isObj(p)) return "";
    if (isObj(p.functionResponse)) return responseText(p.functionResponse.response);
    return typeof p.text === "string" ? p.text : "";
  }).filter(Boolean).join("\n");
}
function responseText(r) {
  if (typeof r === "string") return r;
  if (!isObj(r)) return "";
  if (typeof r.output === "string") return r.output;
  if (typeof r.error === "string") return r.error;
  return r.output != null ? JSON.stringify(r.output) : r.error != null ? JSON.stringify(r.error) : "";
}

export function readSession(entry) {
  const conv = conversation({
    tool: "gemini",
    id: entry.id,
    title: entry.title === "(untitled)" ? "" : entry.title || "",
    project: entry.project || "",
    startedAt: entry.startedAt || "",
    endedAt: entry.updatedAt || "",
    source: entry.source,
  });
  const state = loadFile(entry.source);
  if (!state) return finish(conv);
  const messages = [...state.messages.values()].filter(isConversational);

  // A user message that holds only a functionResponse is the tool's answer going back to the model.
  const answers = new Map();
  for (const m of messages) {
    if (m.type !== "user") continue;
    for (const p of partsOf(m.content)) if (isObj(p?.functionResponse) && p.functionResponse.id) answers.set(p.functionResponse.id, responseText(p.functionResponse.response));
  }

  for (const m of messages) {
    const at = isoOf(m.timestamp);
    if (m.type === "user") {
      const text = userText(m);
      if (text.trim()) conv.turns.push(turn("user", { at, text }));
      continue;
    }
    const t = turn("assistant", { at });
    appendText(t, textOf(m.content));
    const thoughts = Array.isArray(m.thoughts) && m.thoughts.length ? m.thoughts.map(thoughtText) : partsOf(m.content).filter((p) => isObj(p) && p.thought && typeof p.text === "string").map((p) => p.text);
    t.thinking = thoughts.filter(Boolean).join("\n\n");
    const seen = new Set();
    for (const call of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      if (!isObj(call)) continue;
      if (call.id) seen.add(call.id);
      t.tools.push({ name: String(call.name || "tool"), input: call.args ?? {}, output: resultText(call.result) || answers.get(call.id) || "" });
    }
    // A call that only the content holds (a patch rewrote it), with the answer that came back for it.
    for (const p of partsOf(m.content)) {
      const fc = isObj(p) ? p.functionCall : null;
      if (isObj(fc) && !(fc.id && seen.has(fc.id))) t.tools.push({ name: String(fc.name || "tool"), input: fc.args ?? {}, output: answers.get(fc.id) || "" });
    }
    if (typeof m.model === "string" && m.model && !conv.model) conv.model = m.model;
    conv.turns.push(t);
  }
  return finish(conv);
}

// --- a `/chat share` export ---------------------------------------------------------------------------

// `/chat share file.json` writes the chat history as JSON.stringify(history, null, 2): a list of
// { role: "user" | "model", parts: [{ text } | { functionCall } | { functionResponse }] }.
export function isShare(data) {
  return Array.isArray(data) && data.length > 0 && data.every((m) => isObj(m) && (m.role === "user" || m.role === "model") && Array.isArray(m.parts)) && data.some((m) => m.role === "model");
}

export function readShare(data, file = "") {
  const conv = conversation({ tool: "gemini", source: file });
  const pending = new Map();
  for (const m of data) {
    if (m.role === "user") {
      const texts = [];
      for (const p of m.parts) {
        if (isObj(p?.functionResponse)) {
          const call = pending.get(p.functionResponse.id) || [...pending.values()].find((c) => c.name === p.functionResponse.name && !c.output);
          if (call && !call.output) call.output = responseText(p.functionResponse.response);
        } else if (typeof p?.text === "string" && !isContext(p.text)) texts.push(p.text);
      }
      const text = texts.join("\n");
      if (text.trim()) conv.turns.push(turn("user", { text }));
      continue;
    }
    const t = turn("assistant");
    const thoughts = [];
    for (const p of m.parts) {
      if (!isObj(p)) continue;
      if (typeof p.text === "string") { if (p.thought) thoughts.push(p.text); else appendText(t, p.text); }
      else if (isObj(p.functionCall)) {
        const tool = { name: String(p.functionCall.name || "tool"), input: p.functionCall.args ?? {}, output: "" };
        t.tools.push(tool);
        if (p.functionCall.id) pending.set(p.functionCall.id, tool);
        else pending.set(`${tool.name}#${pending.size}`, tool);
      }
    }
    t.thinking = thoughts.join("\n\n");
    conv.turns.push(t);
  }
  return finish(conv);
}
