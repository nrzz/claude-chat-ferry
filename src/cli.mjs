// The command: list, show, import, export, and the line the /chat-ferry:import skill runs.
import fs from "node:fs";
import path from "node:path";
import { findConversation as findAntigravity, listConversations as listAntigravity, readConversation as readAntigravity } from "./antigravity.mjs";
import { findSession, homeDir, listSessions, readSession, writeSession } from "./claude-code.mjs";
import { findSession as findCodex, listSessions as listCodex, readSession as readCodex } from "./codex.mjs";
import { findChat, listChats, readChat } from "./cursor.mjs";
import { detectJson, listJsonFile, loadJsonFile, readJsonFile, toJson } from "./exports.mjs";
import { fromMarkdown, toMarkdown } from "./markdown.mjs";
import { exchanges, selectTurns, stats, toolName } from "./model.mjs";
import { describeCounts, makeDisplay } from "./redact.mjs";
import { UserError, fail, firstLine, isFile, makeColors, num, oneLine, plural, slugify, uniquePath, utcDay, utcStamp, writeFileAtomic } from "./util.mjs";
import { REPO_URL, VERSION } from "./version.mjs";

const HELP = `claude-chat-ferry ${VERSION}: move a chat between Claude Code, Cursor and Antigravity.

Usage
  claude-chat-ferry list [--from claude|cursor|antigravity|codex|all] [--all] [--limit n] [--json]
  claude-chat-ferry list <export.json>             the conversations in a claude.ai or ChatGPT export
  claude-chat-ferry show <source>                  how big a chat is, before you move it
  claude-chat-ferry import <source> [options]      continue it in Claude Code: writes a session,
                                                   prints the "claude --resume" line
  claude-chat-ferry export <source> --to <target>  write it for another tool
                                                   targets: cursor, antigravity, markdown, json

Sources
  cursor:latest  cursor:<id>          a Cursor chat (this project's newest, or by id)
  antigravity:latest  antigravity:<id> an Antigravity conversation
  claude:latest  claude:<id>          a Claude Code session
  codex:latest  codex:<id>            a Codex CLI session
  <file>.md | <file>.json | <file>.jsonl   a Markdown chat, a claude.ai or ChatGPT export
                                      (--pick chooses one of many), a list of messages, this
                                      tool's JSON, or a Claude Code session file

Options
  --project <dir>   the project the chat belongs to (default: this folder): where "latest" looks,
                    where exports for Cursor and Antigravity go, and which Claude Code project
                    an import joins
  --all             look at every project, not only this one
  --out <path>      where to write (- for the terminal); default: a file named after the chat
  --last <n>        only the last n exchanges (a prompt and its answer)
  --tools <mode>    tool calls: none, brief (one line each, default) or full (with their output)
  --thinking        include the model's reasoning when the tool stored it
  --redact | --no-redact   replace secrets (default: on for export, off for import)
  --title <text>    the title of the session or file
  --pick <x>        which conversation of a file: its number in "list", its id, or title words
  --force           overwrite an existing output file
  --dry-run         say what would be written, write nothing
  --json            machine-readable output (list, show)

Examples
  claude-chat-ferry import cursor:latest
  claude-chat-ferry export claude:latest --to cursor
  claude-chat-ferry export antigravity:latest --to markdown --out notes/chat.md
  claude-chat-ferry list ~/Downloads/conversations.json
  claude-chat-ferry import ~/Downloads/conversations.json --pick "login bug"

${REPO_URL}
`;

const FLAGS_WITH_VALUE = new Set(["from", "project", "out", "last", "tools", "title", "pick", "to", "limit", "cursor-dir", "antigravity-dir"]);
const BOOL_FLAGS = new Set(["all", "thinking", "redact", "no-redact", "force", "dry-run", "json", "help", "version", "no-banner"]);

export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { o._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { o._.push(a); continue; }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (BOOL_FLAGS.has(name)) { o[name] = eq === -1 ? true : !/^(false|0|no|off)$/i.test(a.slice(eq + 1)); continue; }
    if (!FLAGS_WITH_VALUE.has(name)) throw new UserError(`unknown option --${name} (see --help)`);
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined) throw new UserError(`--${name} needs a value`);
    o[name] = value;
  }
  return o;
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

const SOURCE = /^(claude|claude-code|cc|cursor|antigravity|ag|codex):(.+)$/i;
const toolOfPrefix = (p) => (/^(claude|claude-code|cc)$/i.test(p) ? "claude-code" : /^cursor$/i.test(p) ? "cursor" : /^codex$/i.test(p) ? "codex" : "antigravity");

export async function resolveSource(spec, o, ctx) {
  const m = SOURCE.exec(spec);
  if (m) {
    const tool = toolOfPrefix(m[1]);
    const ref = m[2];
    const where = o.all ? "any project" : `the project ${o.project}`;
    if (tool === "claude-code") {
      let s;
      try { s = findSession(ref, { env: ctx.env, project: o.project, all: o.all }); } catch (e) { fail(e.message); }
      if (!s) fail(ref === "latest" ? `no Claude Code session for ${where} (try --all, or "list")` : `no Claude Code session starts with "${ref}"`);
      return readSession(s.file);
    }
    if (tool === "cursor") {
      let c;
      try { c = await findChat(ref, { env: ctx.env, project: o.project, all: o.all }); } catch (e) { if (e instanceof UserError) throw e; fail(e.message); }
      if (!c) fail(ref === "latest" ? `no Cursor chat for ${where} (try --all, or "list --from cursor --all")` : `no Cursor chat starts with "${ref}"`);
      try { return await readChat(c, { env: ctx.env }); } catch (e) { if (e instanceof UserError) throw e; fail(e.message); }
    }
    if (tool === "codex") {
      let s;
      try { s = findCodex(ref, { env: ctx.env, project: o.project, all: o.all }); } catch (e) { fail(e.message); }
      if (!s) fail(ref === "latest" ? `no Codex CLI session for ${where} (try --all)` : `no Codex CLI session starts with "${ref}"`);
      return readCodex(s);
    }
    let c;
    try { c = findAntigravity(ref, { env: ctx.env }); } catch (e) { fail(e.message); }
    if (!c) fail(ref === "latest" ? "no Antigravity conversation found" : `no Antigravity conversation starts with "${ref}"`);
    return readAntigravity(c);
  }
  const file = path.resolve(ctx.cwd, spec);
  if (!isFile(file)) fail(`"${spec}" is not a source I know (cursor:latest, antigravity:latest, claude:latest, an id after the colon, or a .md, .json or .jsonl file) and no such file exists`);
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jsonl") return readSession(file);
  if (ext === ".json") { try { return readJsonFile(file, o.pick || ""); } catch (e) { fail(e.message); } }
  if (ext === ".md" || ext === ".markdown" || ext === ".txt") return fromMarkdown(fs.readFileSync(file, "utf8"), { source: file });
  fail(`"${spec}": I read .md, .json and .jsonl files`);
  return null;
}

// A copy of the conversation with every string passed through display.text (secrets, paths). The
// project field keeps its path (with the home folder as ~), so the file still says which project
// it is about.
export function applyDisplay(conv, display) {
  const d = (s) => (typeof s === "string" ? display.text(s) : s);
  const deep = (v) => (typeof v === "string" ? d(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  return { ...conv, title: d(conv.title), project: display.home(conv.project), turns: conv.turns.map((t) => ({ ...t, text: d(t.text), thinking: d(t.thinking), tools: t.tools.map((x) => ({ name: x.name, input: deep(x.input), output: d(x.output) })) })) };
}

function prepare(conv, o, { redact, ctx }) {
  let c = selectTurns(conv, { last: o.last });
  if (o.last && !(Number(o.last) > 0)) fail("--last needs a number of exchanges");
  if (o.tools && !["none", "brief", "full"].includes(o.tools)) fail("--tools is none, brief or full");
  const display = makeDisplay({ redact, root: c.project || o.project, home: homeDir(ctx.env) });
  c = applyDisplay(c, display);
  if (o.title) c = { ...c, title: oneLine(o.title, 120) };
  return { conv: c, display };
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

async function cmdList(o, ctx) {
  const { say, c } = ctx;
  const file = o._[1];
  if (file) {
    const f = path.resolve(ctx.cwd, file);
    if (!isFile(f)) fail(`no such file: ${file}`);
    let listed;
    try { listed = listJsonFile(f); } catch (e) { fail(e.message); }
    if (o.json) { say(JSON.stringify(listed.items, null, 2)); return 0; }
    say(`${c.bold(`${toolName(listed.kind === "ferry" ? "json" : listed.kind)} export`)}: ${plural(listed.items.length, "conversation")} in ${file}`);
    for (const it of listed.items) say(`  ${String(it.index + 1).padStart(4)}  ${utcDay(it.updatedAt || it.startedAt).padEnd(10)}  ${oneLine(it.title, 60).padEnd(60)}  ${num(it.messages)} messages`);
    say(`\nUse: claude-chat-ferry import ${file} --pick <number>`);
    return 0;
  }
  const from = (o.from || "all").toLowerCase();
  if (!["all", "claude", "claude-code", "cursor", "antigravity", "codex"].includes(from)) fail("--from is claude, cursor, antigravity, codex or all");
  const limit = o.limit ? Number(o.limit) : 15;
  if (!(limit > 0)) fail("--limit needs a number");
  const where = o.all ? "every project" : o.project;
  const groups = [];
  const problems = [];
  if (from === "all" || from === "cursor") {
    try { groups.push({ tool: "cursor", items: await listChats({ env: ctx.env, project: o.project, all: o.all, limit }) }); } catch (e) { problems.push(`Cursor: ${e.message}`); }
  }
  if (from === "all" || from === "antigravity") groups.push({ tool: "antigravity", items: listAntigravity({ env: ctx.env, limit }) });
  if (from === "all" || from === "codex") { const items = listCodex({ env: ctx.env, project: o.project, all: o.all, limit }); if (from === "codex" || items.length) groups.push({ tool: "codex", items }); }
  if (from === "all" || from.startsWith("claude")) groups.push({ tool: "claude-code", items: listSessions({ env: ctx.env, project: o.project, all: o.all, limit }) });
  if (o.json) { say(JSON.stringify({ project: where, groups, problems }, null, 2)); return 0; }
  for (const g of groups) {
    const scope = g.tool === "antigravity" ? "every project: Antigravity does not record one" : where;
    say(`${c.bold(toolName(g.tool))}  ${c.dim(`${plural(g.items.length, g.tool === "claude-code" ? "session" : "chat")}${g.items.length >= limit ? ` (newest ${limit})` : ""}, ${scope}`)}`);
    if (!g.items.length) say(c.dim("  none"));
    for (const it of g.items) {
      const size = it.prompts !== undefined ? (it.prompts ? `${num(it.prompts)} prompts` : "empty") : "";
      say(`  ${utcStamp(it.updatedAt || it.startedAt).padEnd(16)} ${it.id.slice(0, 8)}  ${oneLine(it.title, 60).padEnd(60)} ${c.dim(size)}`.trimEnd());
    }
    say("");
  }
  for (const p of problems) say(c.yellow(p));
  say(c.dim("Next: claude-chat-ferry import cursor:<id>   or   claude-chat-ferry export claude:<id> --to cursor"));
  return 0;
}

async function cmdShow(o, ctx) {
  const spec = o._[1] || fail("show needs a source (see --help)");
  const conv = await resolveSource(spec, o, ctx);
  const s = stats(conv);
  if (o.json) { ctx.say(JSON.stringify({ ...conv, turns: undefined, stats: s, firstPrompt: firstLine(conv.turns.find((t) => t.role === "user")?.text || "", 100), lastPrompt: firstLine([...conv.turns].reverse().find((t) => t.role === "user")?.text || "", 100) }, null, 2)); return 0; }
  const { say, c } = ctx;
  say(`${c.bold(conv.title)}`);
  say(`  from      ${toolName(conv.tool)}${conv.from ? ` (originally ${toolName(conv.from)})` : ""}${conv.id ? `, id ${conv.id}` : ""}`);
  if (conv.project) say(`  project   ${conv.project}`);
  if (conv.model) say(`  model     ${conv.model}`);
  if (conv.startedAt) say(`  when      ${utcStamp(conv.startedAt)}${conv.endedAt && utcStamp(conv.endedAt) !== utcStamp(conv.startedAt) ? ` to ${utcStamp(conv.endedAt)}` : ""} UTC`);
  say(`  size      ${plural(s.exchanges, "exchange")}, ${plural(s.turns, "turn")}, ${plural(s.tools, "tool call")}, about ${num(s.tokens)} tokens`);
  const first = conv.turns.find((t) => t.role === "user");
  const last = [...conv.turns].reverse().find((t) => t.role === "user");
  if (first) say(`  first     ${firstLine(first.text, 100)}`);
  if (last && last !== first) say(`  last      ${firstLine(last.text, 100)}`);
  if (conv.source) say(c.dim(`  source    ${conv.source}`));
  return 0;
}

const TARGETS = { claude: "claude", "claude-code": "claude", cc: "claude", markdown: "markdown", md: "markdown", json: "json", cursor: "cursor", antigravity: "antigravity", ag: "antigravity" };

async function cmdImport(o, ctx) {
  const spec = o._[1] || fail("import needs a source (see --help)");
  const source = await resolveSource(spec, o, ctx);
  if (!source.turns.length) fail("that conversation has no messages to import");
  const { conv, display } = prepare(source, o, { redact: !!o.redact, ctx });
  const { say, c } = ctx;
  const s = stats(conv);
  const tools = o.tools || "brief";
  if (o["dry-run"]) {
    say(`Would import ${c.bold(conv.title)} from ${toolName(source.tool)} into Claude Code for ${o.project}: ${plural(s.exchanges, "exchange")}, about ${num(s.tokens)} tokens of context${o.last ? ` (the last ${o.last})` : ""}.`);
    return 0;
  }
  let written;
  try { written = writeSession(conv, { env: ctx.env, cwd: o.project, title: o.title, tools, thinking: !!o.thinking, banner: !o["no-banner"] }); } catch (e) { fail(e.message); }
  say(`Imported ${c.bold(written.title)} from ${toolName(source.tool)} into Claude Code: ${plural(written.messages, "message")}, about ${num(s.tokens)} tokens of context${display.redact ? ` (${describeCounts(display.counts)})` : ""}.`);
  if (s.tokens > 40000 && !o.last) say(c.yellow(`That is a lot of context for every turn; --last 20 would import only the newest 20 exchanges.`));
  say(`Next, in ${o.project}:\n  claude --resume ${written.id}`);
  say(c.dim(`Session file: ${written.file}`));
  return 0;
}

async function cmdExport(o, ctx) {
  const spec = o._[1] || fail("export needs a source (see --help)");
  const target = TARGETS[String(o.to || "").toLowerCase()] || fail("export needs --to cursor, antigravity, markdown, json or claude");
  if (target === "claude") return cmdImport(o, ctx);
  const source = await resolveSource(spec, o, ctx);
  if (!source.turns.length) fail("that conversation has no messages to export");
  const redact = o["no-redact"] ? false : o.redact !== false;
  const { conv, display } = prepare(source, o, { redact, ctx });
  const { say, c } = ctx;
  const s = stats(conv);
  const tools = o.tools || "brief";
  const text = target === "json" ? toJson(conv) : toMarkdown(conv, { thinking: !!o.thinking, tools });
  const ext = target === "json" ? "json" : "md";
  const stem = `${target === "cursor" || target === "antigravity" ? `${utcDay(conv.startedAt || new Date().toISOString())}-` : ""}${slugify(conv.title)}`;
  let out;
  if (o.out === "-") { ctx.out(text); return 0; }
  if (o.out) out = path.resolve(ctx.cwd, o.out);
  else if (target === "cursor" || target === "antigravity") out = path.join(o.project, ".ai-chats", `${stem}.${ext}`);
  else out = path.join(ctx.cwd, `${stem}.${ext}`);
  if (!o.force) out = uniquePath(out);
  const what = `${c.bold(conv.title)} from ${toolName(source.tool)}: ${plural(s.exchanges, "exchange")}, about ${num(s.tokens)} tokens; ${describeCounts(display.counts)}${display.redact ? "" : " (not redacted)"}`;
  if (o["dry-run"]) { say(`Would write ${out}\n  ${what}`); return 0; }
  writeFileAtomic(out, text);
  const shown = path.relative(ctx.cwd, out) || out;
  const inProject = path.relative(o.project, out).replace(/\\/g, "/");
  say(`Wrote ${shown}\n  ${what}`);
  if (target === "cursor") say(`Next, in Cursor's chat for ${o.project}: type @${inProject} and say "continue this conversation".`);
  else if (target === "antigravity") say(`Next, in Antigravity's chat for ${o.project}: mention @${inProject} (or drag the file into the chat) and say "continue this conversation".`);
  else if (target === "markdown") say(c.dim("Cursor and Antigravity read it once you @-mention the file in their chat."));
  return 0;
}

// The /chat-ferry:import skill: "cursor" or "antigravity" and an optional number of exchanges,
// in one string. Prints the chat as Markdown for the model, with one header line.
async function cmdSkillImport(o, ctx) {
  const words = String(o._[1] || "").trim().split(/\s+/).filter(Boolean);
  const tool = words.find((w) => /^(cursor|antigravity|ag|codex)$/i.test(w)) || "cursor";
  const n = Number(words.find((w) => /^\d+$/.test(w))) || 10;
  const toolId = /^(antigravity|ag)$/i.test(tool) ? "antigravity" : /^codex$/i.test(tool) ? "codex" : "cursor";
  let source;
  try { source = await resolveSource(`${toolId}:latest`, { ...o, all: false }, ctx); } catch (e) { ctx.out(`No ${toolName(toolId)} chat was found for ${o.project}: ${e.message}\n`); return 0; }
  const conv = selectTurns(source, { last: n });
  const total = exchanges(source);
  const shown = exchanges(conv);
  ctx.out(`Latest ${toolName(toolId)} chat for ${o.project}: "${source.title}"${source.startedAt ? ` (${utcStamp(source.startedAt)} UTC)` : ""}, ${plural(total, "exchange")}${shown < total ? `; the last ${shown} follow` : ""}.\n\n`);
  ctx.out(toMarkdown(conv, { frontMatter: false, tools: o.tools || "brief", thinking: !!o.thinking }));
  return 0;
}

// ---------------------------------------------------------------------------------------------
// main(argv, ctx) -> exit code. ctx: { cwd, env, out(s), err(s), tty }
// ---------------------------------------------------------------------------------------------

export async function main(argv, { cwd = process.cwd(), env = process.env, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), tty = !!process.stdout.isTTY } = {}) {
  const c = makeColors(env, tty);
  const say = (s) => out(`${s}\n`);
  const ctx = { cwd, env, out, err, say, c };
  try {
    const o = parseArgs(argv);
    const cmd = o._[0] || "help";
    if (o.version || cmd === "version" || cmd === "-v") { say(VERSION); return 0; }
    if (o.help || cmd === "help" || cmd === "-h") { out(HELP); return 0; }
    o.project = path.resolve(cwd, o.project || cwd);
    if (o["cursor-dir"]) env = ctx.env = { ...env, CURSOR_USER_DIR: path.resolve(cwd, o["cursor-dir"]) };
    if (o["antigravity-dir"]) env = ctx.env = { ...env, ANTIGRAVITY_DIR: path.resolve(cwd, o["antigravity-dir"]) };
    if (o.to && !["export", "import"].includes(cmd)) fail("--to belongs to export");
    switch (cmd) {
      case "list": return await cmdList(o, ctx);
      case "show": return await cmdShow(o, ctx);
      case "import": return await cmdImport(o, ctx);
      case "export": return await cmdExport(o, ctx);
      case "skill-import": return await cmdSkillImport(o, ctx);
      default:
        if (SOURCE.test(cmd) || /\.(md|markdown|json|jsonl|txt)$/i.test(cmd)) fail(`start with a command: "import ${cmd}" or "export ${cmd} --to ..."`);
        fail(`unknown command "${cmd}" (see --help)`);
    }
  } catch (e) {
    if (e instanceof UserError) { err(`claude-chat-ferry: ${e.message}\n`); return 1; }
    err(`claude-chat-ferry: ${e?.stack || e}\n`);
    return 1;
  }
  return 0;
}

export { detectJson, loadJsonFile };
