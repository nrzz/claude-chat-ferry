// OpenAI Codex CLI's sessions, read from its rollout files (never written to).
//
// ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl   one session; $CODEX_HOME moves ~/.codex
//   { timestamp, type: "session_meta", payload: { id, cwd, cli_version, ... } }       the first line
//   { timestamp, type: "response_item", payload: { type: "message", role, content: [{ type:
//       "input_text" | "output_text", text }] } }                                     a turn
//   { ..., payload: { type: "function_call", name, arguments, call_id } }            a tool call
//   { ..., payload: { type: "function_call_output", call_id, output } }              its result
// Shapes from Codex CLI 0.130 (2026); the format is Codex's own and undocumented.
import os from "node:os";
import path from "node:path";
import { appendText, conversation, finish, turn } from "./model.mjs";
import { cmp, firstLine, forEachLine, isDir, isoOf, listDir, mtimeIso, sameProject, tryParse } from "./util.mjs";

export function codexHome(env = process.env, platform = process.platform) {
  if (env.CODEX_HOME) return path.resolve(env.CODEX_HOME);
  const home = (platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME) || os.homedir();
  return path.join(home, ".codex");
}

const ROLLOUT = /^rollout-.*\.jsonl$/i;

function* rolloutFiles(root) {
  for (const y of listDir(root)) {
    if (!y.isDirectory()) continue;
    for (const m of listDir(path.join(root, y.name))) {
      if (!m.isDirectory()) continue;
      for (const d of listDir(path.join(root, y.name, m.name))) {
        if (!d.isDirectory()) continue;
        for (const f of listDir(path.join(root, y.name, m.name, d.name))) if (f.isFile() && ROLLOUT.test(f.name)) yield path.join(root, y.name, m.name, d.name, f.name);
      }
    }
  }
}

const textOf = (content) => (Array.isArray(content) ? content.filter((b) => b && typeof b.text === "string").map((b) => b.text).join("\n") : typeof content === "string" ? content : "");

// Every session: { tool: "codex", id, title, project, startedAt, updatedAt, source }, newest first.
export function listSessions({ env = process.env, project = "", all = false, limit = 0 } = {}) {
  const root = path.join(codexHome(env), "sessions");
  const out = [];
  if (!isDir(root)) return out;
  for (const file of rolloutFiles(root)) {
    let meta = null;
    let firstUser = "";
    let started = "";
    let n = 0;
    forEachLine(file, (line) => {
      const rec = tryParse(line);
      if (!rec) return ++n < 200;
      if (rec.type === "session_meta") { meta = rec.payload || {}; started = isoOf(rec.timestamp || meta.timestamp); }
      else if (rec.type === "response_item" && rec.payload?.type === "message" && rec.payload.role === "user" && !firstUser) firstUser = textOf(rec.payload.content);
      return !(meta && firstUser) && ++n < 400;
    });
    if (!meta) continue;
    const id = String(meta.id || path.basename(file, ".jsonl").replace(/^rollout-[\dT:-]+-/, ""));
    out.push({ tool: "codex", id, title: firstLine(firstUser, 70) || "(untitled)", project: typeof meta.cwd === "string" ? meta.cwd : "", startedAt: started, updatedAt: mtimeIso(file), source: file });
  }
  let sessions = out;
  if (project && !all) { const home = (process.platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME) || os.homedir(); sessions = sessions.filter((s) => s.project && sameProject(s.project, project, home)); }
  sessions.sort((a, b) => cmp(b.updatedAt, a.updatedAt) || cmp(a.id, b.id));
  return limit > 0 ? sessions.slice(0, limit) : sessions;
}

export function findSession(ref, opts = {}) {
  const all = listSessions({ ...opts, all: opts.all || ref !== "latest" });
  if (ref === "latest") return all[0] || null;
  const needle = ref.toLowerCase();
  const hits = all.filter((s) => s.id.toLowerCase().startsWith(needle));
  if (hits.length > 1 && !all.some((s) => s.id.toLowerCase() === needle)) throw new Error(`"${ref}" matches ${hits.length} sessions; give more of the id`);
  return hits.find((s) => s.id.toLowerCase() === needle) || hits[0] || null;
}

export function readSession(entry) {
  const conv = conversation({ tool: "codex", id: entry.id, title: entry.title === "(untitled)" ? "" : entry.title || "", project: entry.project || "", startedAt: entry.startedAt || "", endedAt: entry.updatedAt || "", source: entry.source });
  const pending = new Map();
  forEachLine(entry.source, (line) => {
    const rec = tryParse(line);
    if (!rec || typeof rec !== "object") return;
    const at = isoOf(rec.timestamp);
    if (rec.type === "session_meta") { const m = rec.payload || {}; if (!conv.project && typeof m.cwd === "string") conv.project = m.cwd; if (typeof m.model === "string") conv.model = m.model; return; }
    if (rec.type === "turn_context" && typeof rec.payload?.model === "string") { conv.model = rec.payload.model; return; }
    if (rec.type !== "response_item" || !rec.payload) return;
    const p = rec.payload;
    if (p.type === "message") {
      if (p.role === "user") { const text = textOf(p.content); if (text.trim()) conv.turns.push(turn("user", { at, text })); }
      else if (p.role === "assistant") { const last = conv.turns[conv.turns.length - 1]; const t = last && last.role === "assistant" ? last : turn("assistant", { at }); if (t !== last) conv.turns.push(t); appendText(t, textOf(p.content)); }
      return;
    }
    if (p.type === "reasoning") {
      const last = conv.turns[conv.turns.length - 1];
      const t = last && last.role === "assistant" ? last : turn("assistant", { at });
      if (t !== last) conv.turns.push(t);
      const s = Array.isArray(p.summary) ? p.summary.map((x) => x?.text || "").filter(Boolean).join("\n") : "";
      if (s) t.thinking = t.thinking ? `${t.thinking}\n\n${s}` : s;
      return;
    }
    if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      const last = conv.turns[conv.turns.length - 1];
      const t = last && last.role === "assistant" ? last : turn("assistant", { at });
      if (t !== last) conv.turns.push(t);
      const input = tryParse(p.arguments) ?? p.arguments ?? p.input ?? p.action ?? {};
      const entryTool = { name: String(p.name || p.type), input, output: "" };
      t.tools.push(entryTool);
      if (p.call_id) pending.set(p.call_id, entryTool);
      return;
    }
    if ((p.type === "function_call_output" || p.type === "custom_tool_call_output" || p.type === "local_shell_call_output") && p.call_id) {
      const tool = pending.get(p.call_id);
      if (tool) { tool.output = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? ""); pending.delete(p.call_id); }
    }
  });
  return finish(conv);
}
