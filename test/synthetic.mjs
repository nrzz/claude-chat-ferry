// Synthetic Claude Code transcripts, shaped like Claude Code 2.1.x writes them. Everything in them
// is invented; write() puts files only under the folder it is given.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { projectSlug } from "../src/claude-code.mjs";

// A repeatable UUID: the same seed and counter always give the same id.
export function uuid(seed, n = 0) {
  const x = createHash("sha1").update(`${seed}:${n}`).digest("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-${"89ab"[parseInt(x[16], 16) % 4]}${x.slice(17, 20)}-${x.slice(20, 32)}`;
}

export class Transcript {
  constructor({ id, seed, cwd, branch = "main", version = "2.1.289", model = "claude-opus-5-5", start = "2026-10-01T09:00:00.000Z", stepMs = 20000 }) {
    this.seed = seed || id || "session";
    this.id = id || uuid(this.seed, 0);
    this.cwd = cwd;
    this.branch = branch;
    this.version = version;
    this.model = model;
    this.clock = Date.parse(start);
    this.stepMs = stepMs;
    this.records = [];
    this.parent = null;
    this.counter = 1;
    this.msgCounter = 1;
    this.toolCounter = 1;
  }
  now() { const t = new Date(this.clock).toISOString(); this.clock += this.stepMs; return t; }
  nextUuid() { return uuid(this.seed, this.counter++); }
  chain(fields) {
    const rec = { parentUuid: this.parent, isSidechain: false, userType: "external", entrypoint: "cli", cwd: this.cwd, sessionId: this.id, version: this.version, gitBranch: this.branch, ...fields, uuid: this.nextUuid(), timestamp: this.now() };
    this.records.push(rec);
    this.parent = rec.uuid;
    return rec;
  }
  side(fields) { const rec = { sessionId: this.id, ...fields }; this.records.push(rec); return rec; }

  // --- the person ---
  user(content, extra = {}) { return this.chain({ type: "user", message: { role: "user", content }, ...extra }); }
  prompt(text) { return this.user(text, { permissionMode: "default" }); }
  promptBlocks(blocks) { return this.user(blocks); }
  image(text = "") { const blocks = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]; if (text) blocks.push({ type: "text", text }); return this.user(blocks); }
  command(name, args = "") { const bare = name.replace(/^\//, ""); return this.user(`<command-message>${bare}</command-message>\n<command-name>/${bare}</command-name>\n<command-args>${args}</command-args>`); }
  commandOutput(text) { return this.user(`<local-command-stdout>${text}</local-command-stdout>`); }
  bashInput(cmd) { return this.user(`<bash-input>${cmd}</bash-input>`); }
  bashOutput(stdout, stderr = "") { return this.user(`<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`); }
  interrupt() { return this.user([{ type: "text", text: "[Request interrupted by user]" }]); }
  systemReminder(text) { return this.user([{ type: "text", text: `<system-reminder>${text}</system-reminder>` }], { isMeta: true }); }
  injected(name, text) { return this.user([{ type: "text", text: `<${name}>${text}</${name}>` }]); }

  // --- Claude ---
  usage(n = this.msgCounter) { return { input_tokens: 100 + n, output_tokens: 40 + n * 2, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000 * n }; }
  assistant(blocks, { stop = "end_turn" } = {}) {
    const n = this.msgCounter++;
    return blocks.map((b, i) => this.chain({ type: "assistant", requestId: `req_${this.seed.slice(0, 6)}${n}`, message: { id: `msg_${this.seed.slice(0, 6)}${n}`, type: "message", role: "assistant", model: this.model, content: [b], stop_reason: i === blocks.length - 1 ? stop : null, stop_sequence: null, usage: this.usage(n) } }));
  }
  say(text) { return this.assistant([{ type: "text", text }]); }
  think(text) { return this.assistant([{ type: "thinking", thinking: text, signature: "SIG" }], { stop: null }); }
  tool(name, input) { const id = `toolu_${this.seed.slice(0, 6)}${this.toolCounter++}`; this.assistant([{ type: "tool_use", id, name, input }], { stop: "tool_use" }); return id; }
  result(toolId, content, { isError = false } = {}) { const block = { type: "tool_result", tool_use_id: toolId, content }; if (isError) block.is_error = true; return this.chain({ type: "user", message: { role: "user", content: [block] }, toolUseResult: { stdout: typeof content === "string" ? content : "" } }); }
  run(name, input, output) { const id = this.tool(name, input); this.result(id, output); return id; }

  // --- the rest ---
  compact(summary = "The conversation so far: the user is fixing a login bug.") {
    const before = this.parent;
    this.parent = null;
    this.chain({ type: "system", subtype: "compact_boundary", content: "Conversation compacted", isMeta: false, level: "info", compactMetadata: { trigger: "auto", preTokens: 167000 }, logicalParentUuid: before });
    return this.user([{ type: "text", text: `This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\n${summary}` }], { isCompactSummary: true, isVisibleInTranscriptOnly: true });
  }
  customTitle(title) { return this.side({ type: "custom-title", customTitle: title }); }
  aiTitle(title) { return this.side({ type: "ai-title", aiTitle: title }); }
  summaryLine(summary) { return this.side({ type: "summary", summary, leafUuid: this.parent }); }
  sidechain(text) { const rec = this.chain({ type: "user", message: { role: "user", content: text } }); rec.isSidechain = true; rec.agentId = "a1"; return rec; }
  bookkeeping() {
    this.side({ type: "queue-operation", operation: "enqueue", timestamp: this.now(), content: "queued" });
    this.side({ type: "file-history-snapshot", messageId: "m1", snapshot: { messageId: "m1", trackedFileBackups: {}, timestamp: this.now() }, isSnapshotUpdate: false });
    this.side({ type: "mode", mode: "normal" });
    this.side({ type: "cost-state", totalCostUSD: 1.5 });
    return this;
  }

  // Writes <configDir>/projects/<slug>/<id>.jsonl and returns where.
  write(configDir, { mtime = true } = {}) {
    const dir = path.join(configDir, "projects", projectSlug(this.cwd));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${this.id}.jsonl`);
    fs.writeFileSync(file, this.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    if (mtime) { const t = new Date(this.clock); fs.utimesSync(file, t, t); }
    return { id: this.id, file, dir, transcript: this };
  }
}

// A session with a bit of everything: a title, prompts, thinking, a tool call with its result, a
// slash command, a shell command, an image, a compaction, a subagent line and bookkeeping.
export function richSession(configDir, { cwd, id, title = "Fix login redirect loop", start = "2026-10-01T12:00:00.000Z", extra = "" } = {}) {
  const t = new Transcript({ id, seed: id || "rich", cwd, start });
  t.bookkeeping();
  t.prompt(`Fix the login redirect loop in src/auth.ts ${extra}`.trim());
  t.systemReminder("ignore me");
  t.think("The redirect loops when the cookie is missing.");
  t.run("Read", { file_path: `${cwd}/src/auth.ts` }, "export function login() {}\n");
  t.say("The loop comes from a missing cookie check. I will guard it.");
  t.command("/review", "src");
  t.commandOutput("review output");
  t.bashInput("npm test");
  t.bashOutput("12 passing");
  t.image("What about this screenshot?");
  t.say("The screenshot shows the same loop.");
  t.injected("ide_opened_file", "src/auth.ts");
  t.sidechain("subagent chatter");
  t.compact("Summary: the login loop is being fixed.");
  t.prompt("Add a test for it");
  t.say("Added test/auth.test.ts with a regression test.");
  t.customTitle(title);
  return t.write(configDir);
}
