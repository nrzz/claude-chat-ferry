// A conversation as Markdown (what Cursor, Antigravity and people read), and Markdown back into a
// conversation. The file this tool writes has a front matter block and one "## User" or
// "## Assistant" heading per turn; the reader also takes the common hand-written shapes
// ("**User:**", "User:", "### Human").
import { appendText, conversation, finish, toolLine, toolName, turn } from "./model.mjs";
import { capText, isoOf, utcStamp } from "./util.mjs";
import { VERSION } from "./version.mjs";

const ROLE_WORDS = { user: "user", human: "user", me: "user", you: "user", prompt: "user", assistant: "assistant", ai: "assistant", claude: "assistant", cursor: "assistant", antigravity: "assistant", chatgpt: "assistant", gemini: "assistant", model: "assistant", answer: "assistant", response: "assistant" };

// A YAML-ish scalar that round-trips through the reader below.
const scalar = (v) => {
  const s = String(v ?? "");
  return /^[A-Za-z0-9 ._:/\\()~-]*$/.test(s) && !/^\s|\s$/.test(s) && s !== "" ? s : JSON.stringify(s);
};
const unscalar = (s) => { const t = s.trim(); if (t.startsWith('"')) { try { return JSON.parse(t); } catch { return t; } } return t; };

// --- writing -------------------------------------------------------------------------------------

// toMarkdown(conv, { display, thinking, tools, outputMax, frontMatter })
//   display    makeDisplay(...) from redact.mjs: every string goes through display.text
//   thinking   include the model's reasoning (off by default)
//   tools      "none" | "brief" (one line per call) | "full" (the output too, cut to outputMax)
export function toMarkdown(conv, { display, thinking = false, tools = "brief", outputMax = 2000, frontMatter = true } = {}) {
  const d = display ? (s) => display.text(s) : (s) => String(s ?? "");
  const out = [];
  if (frontMatter) {
    out.push("---");
    out.push(`title: ${scalar(d(conv.title))}`);
    out.push(`tool: ${scalar(conv.tool)}`);
    if (conv.id) out.push(`id: ${scalar(conv.id)}`);
    if (conv.project) out.push(`project: ${scalar(d(conv.project))}`);
    if (conv.model) out.push(`model: ${scalar(conv.model)}`);
    if (conv.startedAt) out.push(`started: ${scalar(isoOf(conv.startedAt))}`);
    if (conv.endedAt) out.push(`ended: ${scalar(isoOf(conv.endedAt))}`);
    out.push(`turns: ${conv.turns.length}`);
    out.push(`exported: ${scalar(new Date().toISOString())}`);
    out.push(`by: claude-chat-ferry ${VERSION}`);
    out.push("---", "");
  }
  out.push(`# ${d(conv.title)}`, "");
  out.push(`_From ${toolName(conv.tool)}${conv.project ? `, project ${d(conv.project)}` : ""}${conv.startedAt ? `, ${utcStamp(conv.startedAt)} UTC` : ""}._`, "");
  for (const t of conv.turns) {
    out.push(`## ${t.role === "user" ? "User" : "Assistant"}${t.at ? ` · ${utcStamp(t.at)}` : ""}`, "");
    if (thinking && t.thinking) out.push("<details><summary>Thinking</summary>", "", d(t.thinking).trim(), "", "</details>", "");
    if (t.text) out.push(d(t.text).trim(), "");
    if (tools !== "none") {
      for (const tool of t.tools) {
        out.push(`> **Tool** ${d(toolLine(tool))}`);
        if (tools === "full" && tool.output) {
          out.push(">");
          for (const line of capText(d(String(tool.output)), outputMax).split("\n")) out.push(`> ${line}`);
        }
        out.push("");
      }
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// --- reading -------------------------------------------------------------------------------------

const HEADING = /^#{1,4}\s+\**(\w+)\**(?:\s*[·(:\-–—]\s*(.*?)\)?)?\s*$/;
const BOLD = /^\*\*(\w+)\s*:?\*\*\s*:?\s*(.*)$/;
const PLAIN = /^(User|Human|Assistant|AI|Claude|ChatGPT|Gemini|Cursor|Antigravity)\s*:\s*(.*)$/i;
const TOOL = /^>\s*\*\*Tool\*\*\s*(.*)$/;
// "2026-07-12 09:14" in a heading is UTC, as the writer put it; anything else goes through isoOf.
const stampOf = (s) => {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?(?:\s*UTC)?$/.exec(String(s).trim());
  return m ? `${m[1]}T${m[2]}:${m[3] || "00"}.000Z` : isoOf(s);
};

// fromMarkdown(text, { source }) -> conversation. Front matter fields are taken when present;
// a file with no role headings at all is one user turn.
export function fromMarkdown(text, { source = "" } = {}) {
  const conv = conversation({ tool: "markdown", source });
  let body = String(text ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const fm = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = body.slice(fm[0].length);
    for (const line of fm[1].split("\n")) {
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const v = unscalar(m[2]);
      if (m[1] === "title") conv.title = v;
      else if (m[1] === "tool") conv.sourceTool = v;
      else if (m[1] === "id") conv.id = v;
      else if (m[1] === "project") conv.project = v;
      else if (m[1] === "model") conv.model = v;
      else if (m[1] === "started") conv.startedAt = isoOf(v);
      else if (m[1] === "ended") conv.endedAt = isoOf(v);
    }
  }
  let current = null;
  let inFence = false;
  let inThinking = false;
  let quoting = null; // the tool whose "> " output lines are being read
  let sawRole = false;
  const put = (line) => { if (inThinking) current.thinking += line + "\n"; else current.text += line + "\n"; };
  const lines = body.split("\n");
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; if (current) put(line); continue; }
    if (inFence) { if (current) put(line); continue; }
    let role = null;
    let rest = "";
    let at = "";
    let m;
    if ((m = HEADING.exec(line)) && ROLE_WORDS[m[1].toLowerCase()]) { role = ROLE_WORDS[m[1].toLowerCase()]; at = stampOf(m[2] || ""); }
    else if ((m = BOLD.exec(line)) && ROLE_WORDS[m[1].toLowerCase()]) { role = ROLE_WORDS[m[1].toLowerCase()]; rest = m[2]; }
    else if (!current && (m = PLAIN.exec(line))) { role = ROLE_WORDS[m[1].toLowerCase()]; rest = m[2]; }
    else if (current && (m = PLAIN.exec(line)) && ROLE_WORDS[m[1].toLowerCase()] !== current.role) { role = ROLE_WORDS[m[1].toLowerCase()]; rest = m[2]; }
    if (role) {
      sawRole = true;
      current = turn(role, { at, text: rest ? rest + "\n" : "" });
      conv.turns.push(current);
      inThinking = false;
      quoting = null;
      continue;
    }
    if (!current) {
      // A top heading before any turn is the title (or repeats the front matter's), never a turn.
      if (/^#\s+/.test(line)) { if (!conv.title) conv.title = line.replace(/^#\s+/, "").trim(); continue; }
      if (/^_From .*_$/.test(line) || !line.trim()) continue;
      current = turn("user");
      conv.turns.push(current);
    }
    if (/^<details><summary>Thinking<\/summary>/.test(line)) { inThinking = true; quoting = null; continue; }
    if (line === "</details>" && inThinking) { inThinking = false; continue; }
    if (inThinking) { current.thinking += line + "\n"; continue; }
    if ((m = TOOL.exec(line)) && current.role === "assistant") {
      const [name, ...summary] = m[1].split(": ");
      const tool = { name: name.trim(), input: summary.length ? summary.join(": ") : {}, output: "" };
      current.tools.push(tool);
      quoting = tool;
      continue;
    }
    if (quoting && /^>/.test(line)) { quoting.output += line.replace(/^>\s?/, "") + "\n"; continue; }
    quoting = null;
    current.text += line + "\n";
  }
  if (!sawRole && !conv.turns.length) return finish(conv);
  for (const t of conv.turns) { t.text = t.text.trim(); t.thinking = t.thinking.trim(); for (const tool of t.tools) tool.output = tool.output.trim(); }
  if (conv.sourceTool) { conv.tool = "markdown"; conv.from = conv.sourceTool; delete conv.sourceTool; }
  return finish(conv);
}

// A turn's text with its tool lines, for places that show one turn as plain text.
export const turnText = (t) => { const parts = [t.text]; for (const tool of t.tools) parts.push(`(Used ${toolLine(tool)})`); return parts.filter(Boolean).join("\n"); };
export { appendText };
