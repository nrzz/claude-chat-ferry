// Google Gemini CLI's sessions, read from its local session files (never written to).
//
// ~/.gemini/tmp/<project_hash>/chats/session-*.json (older releases: single JSON file)
// ~/.gemini/tmp/<project_hash>/chats/session-*.jsonl (newer releases: JSONL append log)
// $GEMINI_HOME moves ~/.gemini.
import os from "node:os";
import path from "node:path";
import { appendText, conversation, finish, turn } from "./model.mjs";
import { cmp, firstLine, forEachLine, isDir, isoOf, listDir, mtimeIso, readJson, sameProject, tryParse } from "./util.mjs";

export function geminiHome(env = process.env, platform = process.platform) {
  if (env.GEMINI_HOME) return path.resolve(env.GEMINI_HOME);
  const home = (platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME) || os.homedir();
  return path.join(home, ".gemini");
}

const CHAT_FILE = /^session-.*\.(json|jsonl)$/i;

function* chatFiles(tmpRoot) {
  if (!isDir(tmpRoot)) return;
  // Direct chats: tmp/chats/
  const directChats = path.join(tmpRoot, "chats");
  if (isDir(directChats)) {
    for (const f of listDir(directChats)) {
      if (f.isFile() && CHAT_FILE.test(f.name)) yield path.join(directChats, f.name);
    }
  }
  // Subdirectories: tmp/<project_hash>/chats/
  for (const entry of listDir(tmpRoot)) {
    if (!entry.isDirectory() || entry.name === "chats") continue;
    const chatsDir = path.join(tmpRoot, entry.name, "chats");
    if (!isDir(chatsDir)) continue;
    for (const f of listDir(chatsDir)) {
      if (f.isFile() && CHAT_FILE.test(f.name)) yield path.join(chatsDir, f.name);
    }
  }
}

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : "")).filter(Boolean).join("\n");
  }
  return "";
};

// Every session: { tool: "gemini", id, title, project, startedAt, updatedAt, source }, newest first.
export function listSessions({ env = process.env, project = "", all = false, limit = 0 } = {}) {
  const root = path.join(geminiHome(env), "tmp");
  const out = [];
  if (!isDir(root)) return out;

  for (const file of chatFiles(root)) {
    const isJsonl = file.endsWith(".jsonl");
    let meta = null;
    let firstUser = "";
    let started = "";

    if (isJsonl) {
      let n = 0;
      forEachLine(file, (line) => {
        const rec = tryParse(line);
        if (!rec || typeof rec !== "object") return ++n < 200;
        if (!meta && (rec.sessionId || rec.id || rec.type === "session_meta" || rec.type === "metadata")) {
          meta = rec.payload || rec;
          started = isoOf(meta.startTime || meta.timestamp || rec.timestamp);
        } else if ((rec.type === "user" || rec.role === "user") && !firstUser) {
          firstUser = textOf(rec.content);
        }
        return !(meta && firstUser) && ++n < 400;
      });
    } else {
      const data = readJson(file);
      if (data && typeof data === "object") {
        meta = data;
        started = isoOf(data.startTime || data.startedAt || data.created_at);
        const u = Array.isArray(data.messages) ? data.messages.find((m) => m && (m.type === "user" || m.role === "user")) : null;
        if (u) firstUser = textOf(u.content);
      }
    }

    if (!meta) continue;
    const base = path.basename(file).replace(/\.(json|jsonl)$/i, "").replace(/^session-/, "");
    const id = String(meta.sessionId || meta.id || base);
    const proj = typeof meta.cwd === "string" ? meta.cwd : typeof meta.project === "string" ? meta.project : "";
    const updated = isoOf(meta.lastUpdated || meta.updatedAt) || mtimeIso(file);
    out.push({
      tool: "gemini",
      id,
      title: firstLine(firstUser, 70) || "(untitled)",
      project: proj,
      startedAt: started || updated,
      updatedAt: updated,
      source: file,
    });
  }

  let sessions = out;
  if (project && !all) {
    const home = (process.platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME) || os.homedir();
    sessions = sessions.filter((s) => s.project && sameProject(s.project, project, home));
  }
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

  const parseMessage = (m, at) => {
    if (!m || typeof m !== "object") return;
    const msgAt = isoOf(m.timestamp || m.created_at || m.time) || at;
    const isUser = m.type === "user" || m.role === "user";
    const isAssistant = m.type === "gemini" || m.type === "assistant" || m.role === "assistant" || m.role === "model";

    if (isUser) {
      const text = textOf(m.content);
      if (text.trim()) conv.turns.push(turn("user", { at: msgAt, text }));
      return;
    }

    if (isAssistant) {
      const last = conv.turns[conv.turns.length - 1];
      const t = last && last.role === "assistant" ? last : turn("assistant", { at: msgAt });
      if (t !== last) conv.turns.push(t);
      appendText(t, textOf(m.content));
      if (m.thoughts) {
        const thoughtStr = typeof m.thoughts === "string" ? m.thoughts : Array.isArray(m.thoughts) ? m.thoughts.map((x) => (typeof x === "string" ? x : x?.text || "")).filter(Boolean).join("\n\n") : "";
        if (thoughtStr) t.thinking = t.thinking ? `${t.thinking}\n\n${thoughtStr}` : thoughtStr;
      }
      if (Array.isArray(m.toolCalls)) {
        for (const call of m.toolCalls) {
          if (!call || typeof call !== "object") continue;
          const input = call.args ?? call.arguments ?? call.input ?? {};
          const output = typeof call.output === "string" ? call.output : typeof call.result === "string" ? call.result : call.response ? (typeof call.response === "string" ? call.response : JSON.stringify(call.response)) : "";
          t.tools.push({
            name: String(call.name || call.functionCall?.name || call.type || "tool"),
            input: typeof input === "string" ? tryParse(input) ?? input : input,
            output,
          });
        }
      }
      if (typeof m.model === "string" && !conv.model) conv.model = m.model;
    }
  };

  const isJsonl = entry.source.endsWith(".jsonl");
  if (isJsonl) {
    forEachLine(entry.source, (line) => {
      const rec = tryParse(line);
      if (!rec || typeof rec !== "object") return;
      const at = isoOf(rec.timestamp || rec.created_at);
      if (rec.sessionId || rec.type === "session_meta" || rec.type === "metadata") {
        const m = rec.payload || rec;
        if (!conv.project && typeof m.cwd === "string") conv.project = m.cwd;
        if (!conv.model && typeof m.model === "string") conv.model = m.model;
        return;
      }
      parseMessage(rec, at);
    });
  } else {
    const data = readJson(entry.source);
    if (data && typeof data === "object") {
      if (!conv.project && typeof data.cwd === "string") conv.project = data.cwd;
      if (!conv.model && typeof data.model === "string") conv.model = data.model;
      for (const m of data.messages || []) {
        parseMessage(m, isoOf(m.timestamp));
      }
    }
  }

  return finish(conv);
}
