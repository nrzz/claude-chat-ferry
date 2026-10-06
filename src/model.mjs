// The one shape every reader produces and every writer takes.
//
// A conversation: { tool, id, title, project, model, startedAt, endedAt, source, turns }
//   tool       "claude-code" | "cursor" | "antigravity" | "claude-ai" | "chatgpt" | "markdown" | "json"
//   project    the folder the chat was about, "" when the tool does not record one
//   source     where it was read from (a file path or a database key), for the person's information
// A turn: { role, at, text, thinking, tools }
//   role       "user" | "assistant"
//   at         ISO time or ""
//   text       what was said, as Markdown
//   thinking   the model's reasoning, "" when none was stored
//   tools      [{ name, input, output }]: the tool calls the assistant made in this turn, in order;
//              input is an object (or a string when the tool stored one), output a string or ""
import { estimateTokens, firstLine, oneLine } from "./util.mjs";

export const TOOL_NAMES = { "claude-code": "Claude Code", cursor: "Cursor", antigravity: "Antigravity", codex: "Codex CLI", "claude-ai": "claude.ai", chatgpt: "ChatGPT", markdown: "Markdown", json: "JSON" };
export const toolName = (tool) => TOOL_NAMES[tool] || tool || "unknown";

export function conversation(fields = {}) {
  return { tool: "", id: "", title: "", project: "", model: "", startedAt: "", endedAt: "", source: "", turns: [], ...fields };
}
export function turn(role, fields = {}) {
  return { role, at: "", text: "", thinking: "", tools: [], ...fields };
}
export function appendText(t, text, sep = "\n\n") {
  const s = String(text ?? "").trim();
  if (!s) return;
  t.text = t.text ? `${t.text}${sep}${s}` : s;
}
export const isEmptyTurn = (t) => !String(t.text || "").trim() && !(t.tools || []).length && !String(t.thinking || "").trim();

// Tidies a conversation a reader built: drops empty turns, joins consecutive turns of one role
// (an assistant's thinking, tool calls and answer are one turn), fills in the times and a title.
export function finish(conv) {
  const merged = [];
  for (const t of conv.turns) {
    if (isEmptyTurn(t)) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) {
      appendText(last, t.text);
      if (t.thinking) last.thinking = last.thinking ? `${last.thinking}\n\n${t.thinking}` : t.thinking;
      last.tools.push(...(t.tools || []));
      if (!last.at) last.at = t.at;
    } else {
      merged.push({ ...turn(t.role), ...t, text: String(t.text || "").trim(), thinking: String(t.thinking || ""), tools: [...(t.tools || [])] });
    }
  }
  conv.turns = merged;
  const times = merged.map((t) => t.at).filter(Boolean);
  if (!conv.startedAt && times.length) conv.startedAt = times[0];
  if (!conv.endedAt && times.length) conv.endedAt = times[times.length - 1];
  if (!conv.title) {
    const u = merged.find((t) => t.role === "user" && t.text);
    conv.title = u ? firstLine(u.text, 70) : "";
  }
  if (!conv.title) conv.title = "(untitled)";
  conv.title = oneLine(conv.title, 120);
  return conv;
}

// An exchange is one user turn and the assistant turns that answer it.
export const exchanges = (conv) => conv.turns.filter((t) => t.role === "user").length;

// The last n exchanges (whole, from the n-th last user turn on). n <= 0 or missing: everything.
export function selectTurns(conv, { last } = {}) {
  const n = Number(last);
  if (!(n > 0)) return conv;
  let seen = 0;
  let start = 0;
  for (let i = conv.turns.length - 1; i >= 0; i--) {
    if (conv.turns[i].role === "user" && ++seen === n) { start = i; break; }
  }
  return { ...conv, turns: conv.turns.slice(start) };
}

// A short description of a tool call: the field that says what it did (a command, a path, a
// query), or the input cut short.
const KEY_FIELDS = ["command", "cmd", "relative_workspace_path", "relativeWorkspacePath", "target_file", "targetFile", "file_path", "filePath", "path", "pattern", "query", "search", "url", "description", "prompt", "explanation"];
export function toolSummary(tool, max = 120) {
  const input = tool.input;
  if (typeof input === "string") return oneLine(input, max);
  if (input && typeof input === "object") {
    if (!Object.keys(input).length) return "";
    for (const k of KEY_FIELDS) if (typeof input[k] === "string" && input[k].trim()) return oneLine(input[k], max);
    const firstString = Object.values(input).find((v) => typeof v === "string" && v.trim());
    if (firstString) return oneLine(firstString, max);
    try { return oneLine(JSON.stringify(input), max); } catch { return ""; }
  }
  return "";
}
export function toolLine(tool, max = 120) {
  const s = toolSummary(tool, max);
  return s ? `${tool.name}: ${s}` : String(tool.name || "tool");
}

// How big a conversation is: turns by role, tool calls, characters and a rough token count.
export function stats(conv) {
  let chars = 0;
  let tools = 0;
  let user = 0;
  let assistant = 0;
  for (const t of conv.turns) {
    if (t.role === "user") user++; else assistant++;
    chars += String(t.text || "").length;
    for (const tool of t.tools || []) { tools++; chars += toolLine(tool).length; }
  }
  return { turns: conv.turns.length, user, assistant, exchanges: user, tools, chars, tokens: estimateTokens(" ".repeat(chars)) };
}
