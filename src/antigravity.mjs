// Google Antigravity's conversations, read from the transcript it writes for each one (never
// written to).
//
// ~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl
//   one JSON record per step: { step_index, source, type, status, created_at, content, thinking }
//   source USER_EXPLICIT with type USER_INPUT is the person; source MODEL with type
//   PLANNER_RESPONSE is the assistant's answer; other steps are tool calls or bookkeeping
// ~/.gemini/antigravity/agyhub_summaries_proto.pb   the titles, one protobuf entry per conversation
// ~/.gemini/antigravity-ide/...                     the same layout for the editor's own profile
// ANTIGRAVITY_DIR overrides the folder (one path, or several separated by the OS path separator).
// Checked against Antigravity on 2026-10-06; the format is Antigravity's own and undocumented.
import os from "node:os";
import path from "node:path";
import { appendText, conversation, finish, turn } from "./model.mjs";
import { cmp, firstLine, forEachLine, isDir, isFile, isoOf, listDir, mtimeIso, tryParse } from "./util.mjs";
import fs from "node:fs";

export function antigravityDirs(env = process.env, platform = process.platform) {
  if (env.ANTIGRAVITY_DIR) return env.ANTIGRAVITY_DIR.split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
  const home = (platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME) || os.homedir();
  // The desktop app, the editor's own profile, and the command-line agent (Antigravity 2.0).
  return ["antigravity", "antigravity-ide", "antigravity-cli"].map((d) => path.join(home, ".gemini", d));
}

// ---------------------------------------------------------------------------------------------
// Titles: a minimal protobuf reader for agyhub_summaries_proto.pb. Entry = field 1 (message):
// field 1 the conversation id, field 2 (message): field 1 the title.
// ---------------------------------------------------------------------------------------------

function varint(b, i) {
  let r = 0;
  let mul = 1;
  for (;;) {
    if (i >= b.length) throw new Error("truncated");
    const x = b[i++];
    r += (x & 0x7f) * mul;
    if (!(x & 0x80)) return [r, i];
    mul *= 128;
  }
}
// The fields of one message: [{ field, wireType, value (number) | bytes (Buffer) }].
export function protoFields(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    let tag;
    [tag, i] = varint(b, i);
    const field = Math.floor(tag / 8);
    const wt = tag % 8;
    if (wt === 0) { let v; [v, i] = varint(b, i); out.push({ field, wt, value: v }); }
    else if (wt === 1) { i += 8; out.push({ field, wt }); }
    else if (wt === 5) { i += 4; out.push({ field, wt }); }
    else if (wt === 2) { let len; [len, i] = varint(b, i); if (i + len > b.length) throw new Error("truncated"); out.push({ field, wt, bytes: b.subarray(i, i + len) }); i += len; }
    else throw new Error(`wire type ${wt}`);
  }
  return out;
}
export function readTitles(dir) {
  const titles = new Map();
  let buf;
  try { buf = fs.readFileSync(path.join(dir, "agyhub_summaries_proto.pb")); } catch { return titles; }
  try {
    for (const entry of protoFields(buf)) {
      if (entry.field !== 1 || entry.wt !== 2) continue;
      const inner = protoFields(entry.bytes);
      const id = inner.find((f) => f.field === 1 && f.wt === 2)?.bytes?.toString("utf8");
      const summary = inner.find((f) => f.field === 2 && f.wt === 2);
      const title = summary ? protoFields(summary.bytes).find((f) => f.field === 1 && f.wt === 2)?.bytes?.toString("utf8") : "";
      if (id && title && !title.includes("�")) titles.set(id, title.trim());
    }
  } catch { /* a file in another layout: the first message names the conversation instead */ }
  return titles;
}

// ---------------------------------------------------------------------------------------------
// Listing and reading
// ---------------------------------------------------------------------------------------------

const transcriptOf = (dir, id) => {
  const logs = path.join(dir, "brain", id, ".system_generated", "logs");
  for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) { const f = path.join(logs, name); if (isFile(f)) return f; }
  return "";
};

// Every conversation: { tool: "antigravity", id, title, startedAt, updatedAt, source }, newest
// first. Antigravity does not record a project folder in the transcript, so there is no project
// filter: every conversation is listed.
export function listConversations({ env = process.env, limit = 0 } = {}) {
  const out = [];
  for (const dir of antigravityDirs(env)) {
    if (!isDir(path.join(dir, "brain"))) continue;
    const titles = readTitles(dir);
    for (const d of listDir(path.join(dir, "brain"))) {
      if (!d.isDirectory()) continue;
      const file = transcriptOf(dir, d.name);
      if (!file) continue;
      let first = "";
      let last = "";
      let firstUser = "";
      let steps = 0;
      forEachLine(file, (line) => {
        const rec = tryParse(line);
        if (!rec) return;
        steps++;
        if (rec.created_at) { if (!first) first = rec.created_at; last = rec.created_at; }
        if (!firstUser && rec.type === "USER_INPUT" && typeof rec.content === "string") firstUser = unwrapRequest(rec.content);
      });
      if (!steps) continue;
      out.push({ tool: "antigravity", id: d.name, title: titles.get(d.name) || firstLine(firstUser, 70) || "(untitled)", project: "", startedAt: isoOf(first), updatedAt: isoOf(last) || mtimeIso(file), source: file });
    }
  }
  out.sort((a, b) => cmp(b.updatedAt, a.updatedAt) || cmp(a.id, b.id));
  return limit > 0 ? out.slice(0, limit) : out;
}

export function findConversation(ref, opts = {}) {
  const all = listConversations(opts);
  if (ref === "latest") return all[0] || null;
  const needle = ref.toLowerCase();
  const hits = all.filter((c) => c.id.toLowerCase().startsWith(needle));
  if (hits.length > 1 && !all.some((c) => c.id.toLowerCase() === needle)) throw new Error(`"${ref}" matches ${hits.length} conversations; give more of the id`);
  return hits.find((c) => c.id.toLowerCase() === needle) || hits[0] || null;
}

// A step that is not the person or the answer: a tool call (RUN_COMMAND, VIEW_FILE ...) or
// bookkeeping (CONVERSATION_HISTORY, CHECKPOINT). Tool-like steps with content become tool entries.
const BOOKKEEPING = /^(?:CONVERSATION_HISTORY|CHECKPOINT|SUMMARY|SYSTEM_PROMPT|TRAJECTORY|MEMORY|ERROR|PLANNER_RESPONSE)/;
// The person's words arrive wrapped: <USER_REQUEST>\n...\n</USER_REQUEST>.
export const unwrapRequest = (s) => String(s ?? "").replace(/^\s*<USER_REQUEST>\s*/i, "").replace(/\s*<\/USER_REQUEST>\s*$/i, "").trim();

export function readConversation(entry) {
  const conv = conversation({ tool: "antigravity", id: entry.id, title: entry.title === "(untitled)" ? "" : entry.title || "", startedAt: entry.startedAt || "", endedAt: entry.updatedAt || "", source: entry.source });
  forEachLine(entry.source, (line) => {
    const rec = tryParse(line);
    if (!rec || typeof rec !== "object") return;
    const at = isoOf(rec.created_at);
    const type = String(rec.type || "");
    const source = String(rec.source || "");
    const content = typeof rec.content === "string" ? rec.content : "";
    if (type === "USER_INPUT" || (source.startsWith("USER") && content && !type.startsWith("TOOL"))) {
      const text = unwrapRequest(content);
      if (text) conv.turns.push(turn("user", { at, text }));
      return;
    }
    const last = conv.turns[conv.turns.length - 1];
    const t = last && last.role === "assistant" ? last : turn("assistant", { at });
    const calls = Array.isArray(rec.tool_calls) ? rec.tool_calls.filter((c) => c && typeof c === "object") : [];
    if (type === "PLANNER_RESPONSE" || (source === "MODEL" && !BOOKKEEPING.test(type) && !type.includes("TOOL") && /RESPONSE|MESSAGE|ANSWER/.test(type))) {
      if (t !== last) conv.turns.push(t);
      if (typeof rec.thinking === "string" && rec.thinking.trim()) t.thinking = t.thinking ? `${t.thinking}\n\n${rec.thinking}` : rec.thinking;
      appendText(t, content);
      for (const c of calls) t.tools.push({ name: String(c.name || "tool"), input: c.args ?? c.arguments ?? {}, output: "" });
      return;
    }
    if ((!content.trim() && !calls.length) || BOOKKEEPING.test(type)) return;
    if (t !== last) conv.turns.push(t);
    // A tool step: its own type names the tool, its content is what came back. When the answer
    // before it already listed the call, the output completes that entry.
    const name = type.toLowerCase();
    const open = t.tools.find((x) => !x.output && x.name.toLowerCase().replace(/[^a-z]/g, "") === name.replace(/[^a-z]/g, ""));
    if (open) open.output = content;
    else t.tools.push({ name, input: calls[0]?.args ?? {}, output: content });
  });
  return finish(conv);
}
