import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SECRETS, hasSqlite, read, run, runCli, world } from "./helpers.mjs";
import { Transcript, richSession } from "./synthetic.mjs";
import { makeCursorStore, sampleChats } from "./fake-cursor.mjs";
import { makeAntigravity, sampleConversations } from "./fake-antigravity.mjs";
import { makeCodex, sampleCodex } from "./fake-codex.mjs";
import { readSession, sessionFiles } from "../src/claude-code.mjs";
import { parseArgs } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";

const needSqlite = { skip: !hasSqlite && "needs node:sqlite (Node 22.13+)" };

// A world with one Claude Code session, Antigravity conversations, Codex sessions and (with
// SQLite) Cursor chats, all about the project folder.
async function populated(name) {
  const w = world(name);
  const project = w.project("webapp");
  const other = w.project("other");
  const session = richSession(w.claude, { cwd: project, extra: `token ${SECRETS.github}` });
  makeAntigravity(w.antigravity, sampleConversations());
  makeCodex(w.codex, sampleCodex(project, other));
  if (hasSqlite) await makeCursorStore(w.cursor, sampleChats(project, other));
  else { // a store exists, but this Node cannot read it: the command must say which Node it needs
    fs.mkdirSync(path.join(w.cursor, "globalStorage"), { recursive: true });
    fs.writeFileSync(path.join(w.cursor, "globalStorage", "state.vscdb"), "SQLite format 3\u0000 (a stand-in: this Node has no node:sqlite to read it)");
  }
  return { w, project, other, session };
}

// --- arguments -----------------------------------------------------------------------------------

test("parseArgs: flags with values, --flag=value, booleans, --no-redact, positionals and --", () => {
  const o = parseArgs(["import", "cursor:latest", "--last", "3", "--tools=full", "--thinking", "--no-redact", "--", "--not-a-flag"]);
  assert.deepEqual(o._, ["import", "cursor:latest", "--not-a-flag"]);
  assert.equal(o.last, "3");
  assert.equal(o.tools, "full");
  assert.equal(o.thinking, true);
  assert.equal(o["no-redact"], true);
  assert.equal(parseArgs(["--json=false"]).json, false);
  assert.throws(() => parseArgs(["--frob"]), /unknown option --frob/);
  assert.throws(() => parseArgs(["--out"]), /--out needs a value/);
});

test("help, version, unknown commands and options", async () => {
  const w = world("help");
  for (const args of [["--help"], ["help"], []]) { const r = await run(args, w); assert.equal(r.code, 0); assert.match(r.out, /^claude-chat-ferry \d+\.\d+\.\d+: move a chat/); }
  assert.equal((await run(["version"], w)).out.trim(), VERSION);
  assert.equal((await run(["--version"], w)).out.trim(), VERSION);
  const bad = await run(["frob"], w);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /unknown command "frob"/);
  assert.match((await run(["list", "--bogus"], w)).err, /unknown option --bogus/);
  assert.match((await run(["cursor:latest"], w)).err, /start with a command: "import cursor:latest"/);
  assert.match((await run(["show", "x.md", "--to", "json"], w)).err, /--to belongs to export/);
});

// --- list ------------------------------------------------------------------------------------------

test("list shows each tool's chats for the project, newest first, with sizes; --all shows every project", async () => {
  const { w, project } = await populated("list");
  const r = await run(["list"], w, { cwd: project });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /Claude Code\s+1 session/);
  assert.match(r.out, /Fix login redirect loop\s+5 prompts/);
  assert.match(r.out, /Antigravity\s+2 chats, every project/);
  assert.match(r.out, /Retry loop in the client/);
  assert.match(r.out, /Codex CLI\s+1 chat/);
  assert.match(r.out, /Add a health endpoint/);
  if (hasSqlite) {
    assert.match(r.out, /Cursor\s+4 chats/, "two named chats, the archived one and the empty New chat");
    assert.match(r.out, /Fix the carousel on mobile\s+2 prompts/);
    assert.match(r.out, /Archived chat\s+1 prompts/);
    assert.ok(!r.out.includes("Other project chat"));
    assert.ok(!r.out.includes("A subagent"));
    assert.ok(!r.out.includes("Deleted chat"));
    assert.match(r.out, /66666666 {2}\(untitled\)\s+empty\n/, "the New chat placeholder is listed last and marked empty");
  } else {
    assert.match(r.out, /Cursor: reading this tool's chats needs Node 22\.13/);
  }
  const all = await run(["list", "--all", "--from", "codex"], w, { cwd: project });
  assert.match(all.out, /Codex CLI\s+2 chats, every project/);
  assert.match(all.out, /Other project question/);
  assert.match((await run(["list", "--from", "nope"], w)).err, /--from is claude, cursor, antigravity, codex or all/);
  assert.match((await run(["list", "--limit", "x"], w)).err, /--limit needs a number/);
});

test("list --json is machine readable", async () => {
  const { w, project } = await populated("listjson");
  const r = await run(["list", "--json", "--from", "claude"], w, { cwd: project });
  const j = JSON.parse(r.out);
  assert.equal(j.project, project);
  assert.equal(j.groups.length, 1);
  assert.equal(j.groups[0].tool, "claude-code");
  assert.equal(j.groups[0].items[0].title, "Fix login redirect loop");
  assert.deepEqual(j.problems, []);
});

test("list <export.json> shows the conversations in a claude.ai export with their numbers", async () => {
  const w = world("listfile");
  const file = path.join(w.base, "conversations.json");
  fs.writeFileSync(file, JSON.stringify([
    { uuid: "u1", name: "Older chat", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", chat_messages: [{ sender: "human", text: "hi", created_at: "2026-01-01T00:00:00Z", content: [{ type: "text", text: "hi" }] }] },
    { uuid: "u2", name: "Newer chat", created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-02T00:00:00Z", chat_messages: [{ sender: "human", text: "yo", created_at: "2026-02-01T00:00:00Z", content: [{ type: "text", text: "yo" }] }, { sender: "assistant", text: "hey", created_at: "2026-02-01T00:01:00Z", content: [{ type: "text", text: "hey" }] }] },
  ]));
  const r = await run(["list", "conversations.json"], w, { cwd: w.base });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /claude\.ai export: 2 conversations/);
  assert.match(r.out, /\n\s+2\s+2026-02-02\s+Newer chat\s+2 messages/);
  assert.match(r.out, /\n\s+1\s+2026-01-02\s+Older chat\s+1 messages/);
  assert.match(r.out, /import conversations\.json --pick <number>/);
  assert.match((await run(["list", "missing.json"], w)).err, /no such file/);
  fs.writeFileSync(path.join(w.base, "odd.json"), JSON.stringify({ hello: 1 }));
  assert.match((await run(["list", "odd.json"], w, { cwd: w.base })).err, /is not a claude\.ai export/);
});

// --- show ------------------------------------------------------------------------------------------

test("show says how big a chat is before you move it", async () => {
  const { w, project } = await populated("show");
  const r = await run(["show", "claude:latest"], w, { cwd: project });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^Fix login redirect loop\n/);
  assert.match(r.out, /from\s+Claude Code, id [0-9a-f-]{36}/);
  assert.match(r.out, /size\s+3 exchanges, 6 turns, 1 tool call, about [\d,]+ tokens/);
  assert.match(r.out, /first\s+Fix the login redirect loop/);
  assert.match(r.out, /last\s+This session is being continued/);
  const j = JSON.parse((await run(["show", "antigravity:latest", "--json"], w)).out);
  assert.equal(j.tool, "antigravity");
  assert.equal(j.stats.exchanges, 2);
  assert.equal(j.firstPrompt, "fix the retry loop in client.go");
  assert.match((await run(["show"], w)).err, /show needs a source/);
  assert.match((await run(["show", "claude:latest"], w, { cwd: w.project("empty") })).err, /no Claude Code session for the project .*empty \(try --all/);
  assert.match((await run(["show", "claude:zzzz"], w)).err, /no Claude Code session starts with "zzzz"/);
  assert.match((await run(["show", "antigravity:zzzz"], w)).err, /no Antigravity conversation starts with "zzzz"/);
  assert.match((await run(["show", "codex:zzzz"], w)).err, /no Codex CLI session starts with "zzzz"/);
  assert.match((await run(["show", "nope:latest"], w)).err, /is not a source I know/);
  assert.match((await run(["show", "x.txt"], w)).err, /no such file exists/);
});

// --- import ----------------------------------------------------------------------------------------

test("import antigravity:latest writes a Claude Code session for the project and says how to resume it", async () => {
  const { w, project } = await populated("import-ag");
  const r = await run(["import", "antigravity:latest"], w, { cwd: project });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^Imported Retry loop in the client from Antigravity into Claude Code: 4 messages, about [\d,]+ tokens of context\.\n/);
  const id = /claude --resume ([0-9a-f-]{36})/.exec(r.out)?.[1];
  assert.ok(id, r.out);
  assert.match(r.out, new RegExp(`Next, in ${project.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}:`));
  const files = sessionFiles({ env: w.env, project });
  const mine = files.find((s) => s.id === id);
  assert.ok(mine, "the session is in the project's folder");
  const conv = readSession(mine.file);
  assert.equal(conv.title, "Retry loop in the client");
  assert.deepEqual(conv.turns.map((t) => t.role), ["user", "assistant", "user", "assistant"]);
  assert.match(conv.turns[0].text, /^\[Conversation imported from Antigravity chat "Retry loop in the client", 2026-09-30 by claude-chat-ferry\./);
  assert.match(conv.turns[1].text, /\(Used run_command: go test \.\/\.\.\.\)/);
  assert.match(conv.turns[1].text, /\(Used view_file\)/);
  assert.ok(!conv.turns[1].text.includes("Look at client.go"), "thinking stays out unless --thinking");
});

test("import options: --last, --tools, --thinking, --title, --no-banner, --redact, --dry-run", async () => {
  const { w, project, session } = await populated("import-opts");
  const dry = await run(["import", "antigravity:latest", "--dry-run", "--last", "1"], w, { cwd: project });
  assert.match(dry.out, /^Would import Retry loop in the client from Antigravity into Claude Code for .*: 1 exchange, about \d+ tokens of context \(the last 1\)\./);
  assert.equal(sessionFiles({ env: w.env, project }).length, 1, "dry run wrote nothing");
  const r = await run(["import", "antigravity:latest", "--last", "1", "--tools", "none", "--thinking", "--title", "Backoff work", "--no-banner"], w, { cwd: project });
  assert.equal(r.code, 0, r.all);
  const id = /claude --resume ([0-9a-f-]{36})/.exec(r.out)[1];
  const conv = readSession(sessionFiles({ env: w.env, project }).find((s) => s.id === id).file);
  assert.equal(conv.title, "Backoff work");
  assert.deepEqual(conv.turns.map((t) => t.text), ["thanks, also add a test", "Added client_test.go with a backoff test."]);
  const full = await run(["import", "antigravity:latest", "--tools", "full", "--thinking"], w, { cwd: project });
  const id2 = /claude --resume ([0-9a-f-]{36})/.exec(full.out)[1];
  const conv2 = readSession(sessionFiles({ env: w.env, project }).find((s) => s.id === id2).file);
  assert.match(conv2.turns[1].text, /\(Thinking: Look at client\.go before anything\.\)/);
  assert.match(conv2.turns[1].text, /\(Used run_command: go test \.\/\.\.\.\)\n```\nok {2}\tproj\t0\.4s\n```/);
  const red = await run(["import", `claude:${session.id.slice(0, 8)}`, "--redact"], w, { cwd: project });
  assert.match(red.out, /replaced 1 secret \(github-token 1\); rewrote \d+ paths?\)/);
  const id3 = /claude --resume ([0-9a-f-]{36})/.exec(red.out)[1];
  const text = read(sessionFiles({ env: w.env, project }).find((s) => s.id === id3).file);
  assert.ok(text.includes("[REDACTED:github-token]") && !text.includes(SECRETS.github));
  assert.match((await run(["import", "antigravity:latest", "--last", "x"], w, { cwd: project })).err, /--last needs a number/);
  assert.match((await run(["import", "antigravity:latest", "--tools", "some"], w, { cwd: project })).err, /--tools is none, brief or full/);
  assert.match((await run(["import"], w)).err, /import needs a source/);
});

test("import cursor:latest takes this project's newest chat with messages", needSqlite, async () => {
  const { w, project, other } = await populated("import-cursor");
  const r = await run(["import", "cursor:latest"], w, { cwd: project });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^Imported Fix the carousel on mobile from Cursor into Claude Code: 4 messages/);
  const id = /claude --resume ([0-9a-f-]{36})/.exec(r.out)[1];
  const conv = readSession(sessionFiles({ env: w.env, project }).find((s) => s.id === id).file);
  assert.match(conv.turns[0].text, /The carousel arrows do not advance on mobile/);
  assert.match(conv.turns[0].text, /\(Attached: src\/Gallery\.tsx\)/);
  assert.match(conv.turns[1].text, /\(Used read_file_v2: src\/Gallery\.tsx\)/);
  assert.equal(conv.model, "fake-model-1");
  const byId = await run(["import", "cursor:33333333", "--project", other], w, { cwd: project });
  assert.match(byId.out, /Imported Other project chat from Cursor/);
  assert.match((await run(["import", "cursor:latest"], w, { cwd: w.project("nothing") })).err, /no Cursor chat for the project/);
  assert.match((await run(["import", "cursor:zzzz"], w, { cwd: project })).err, /no Cursor chat starts with "zzzz"/);
});

test("import from files: a Markdown chat, a ChatGPT export with --pick, a Claude Code session file, this tool's JSON", async () => {
  const w = world("import-files");
  const project = w.project("p");
  fs.writeFileSync(path.join(w.base, "chat.md"), "# Notes\n\n## User\n\nWhy is the build slow?\n\n## Assistant\n\nThe cache is off.\n");
  const md = await run(["import", path.join(w.base, "chat.md")], w, { cwd: project });
  assert.equal(md.code, 0, md.all);
  assert.match(md.out, /Imported Notes from Markdown into Claude Code: 2 messages/);
  const gpt = path.join(w.base, "chatgpt.json");
  const node = (id, role, text, parent, children = []) => ({ id, parent, children, message: { id, author: { role }, create_time: 1.7e9, content: { content_type: "text", parts: [text] } } });
  fs.writeFileSync(gpt, JSON.stringify([
    { title: "First", create_time: 1.7e9, update_time: 1.7e9 + 10, current_node: "a2", mapping: { a1: node("a1", "user", "one", null, ["a2"]), a2: node("a2", "assistant", "uno", "a1") } },
    { title: "Second", create_time: 1.7e9, update_time: 1.7e9 + 20, current_node: "b2", mapping: { b1: node("b1", "user", "two", null, ["b2"]), b2: node("b2", "assistant", "dos", "b1") } },
  ]));
  assert.match((await run(["import", gpt], w, { cwd: project })).err, /holds 2 conversations: add --pick/);
  const picked = await run(["import", gpt, "--pick", "Second"], w, { cwd: project });
  assert.match(picked.out, /Imported Second from ChatGPT into Claude Code: 2 messages/);
  const { file, id } = richSession(w.claude, { cwd: w.project("elsewhere") });
  const fromFile = await run(["import", file], w, { cwd: project });
  assert.match(fromFile.out, /Imported Fix login redirect loop from Claude Code into Claude Code: 6 messages/);
  const json = path.join(w.base, "ferry.json");
  const exp = await run(["export", `claude:${id.slice(0, 8)}`, "--to", "json", "--out", json], w, { cwd: project });
  assert.equal(exp.code, 0, exp.all);
  const fromJson = await run(["import", json], w, { cwd: project });
  assert.match(fromJson.out, /Imported Fix login redirect loop from Claude Code into Claude Code: 6 messages/, "this tool's JSON keeps the chat's origin");
  fs.writeFileSync(path.join(w.base, "empty.md"), "\n\n");
  assert.match((await run(["import", path.join(w.base, "empty.md")], w, { cwd: project })).err, /has no messages to import/);
  fs.writeFileSync(path.join(w.base, "x.yaml"), "a: 1");
  assert.match((await run(["import", path.join(w.base, "x.yaml")], w, { cwd: project })).err, /I read \.md, \.json and \.jsonl files/);
});

// --- export ----------------------------------------------------------------------------------------

test("export claude:latest --to cursor writes a redacted Markdown file under .ai-chats and says how to use it", async () => {
  const { w, project } = await populated("export-cursor");
  const r = await run(["export", "claude:latest", "--to", "cursor"], w, { cwd: project });
  assert.equal(r.code, 0, r.all);
  const m = /^Wrote (\S+)\n/.exec(r.out);
  assert.ok(m, r.out);
  assert.equal(m[1].replace(/\\/g, "/"), ".ai-chats/2026-10-01-fix-login-redirect-loop.md");
  assert.match(r.out, /Fix login redirect loop from Claude Code: 3 exchanges, about [\d,]+ tokens; replaced 1 secret \(github-token 1\); rewrote \d+ paths?\n/);
  assert.match(r.out, /Next, in Cursor's chat for .*: type @\.ai-chats\/2026-10-01-fix-login-redirect-loop\.md and say "continue this conversation"\./);
  const text = read(path.join(project, ".ai-chats", "2026-10-01-fix-login-redirect-loop.md"));
  assert.match(text, /^---\ntitle: Fix login redirect loop\ntool: claude-code\n/);
  assert.ok(text.includes("[REDACTED:github-token]") && !text.includes(SECRETS.github));
  assert.match(text, /## User · 2026-10-01 12:0\d\n/);
  assert.match(text, /> \*\*Tool\*\* Read: src\/auth\.ts/, "the project path becomes a relative one");
  assert.ok(!text.includes("The redirect loops when the cookie is missing."), "no thinking by default");
  const again = await run(["export", "claude:latest", "--to", "cursor"], w, { cwd: project });
  assert.match(again.out, /fix-login-redirect-loop-2\.md/, "an existing file is not overwritten");
  const forced = await run(["export", "claude:latest", "--to", "cursor", "--force", "--thinking"], w, { cwd: project });
  assert.match(forced.out, /2026-10-01-fix-login-redirect-loop\.md\n/);
  assert.ok(read(path.join(project, ".ai-chats", "2026-10-01-fix-login-redirect-loop.md")).includes("The redirect loops when the cookie is missing."));
  assert.equal(fs.readdirSync(path.join(project, ".ai-chats")).length, 2);
});

test("export to antigravity, markdown and json; --out, --out -, --no-redact, --dry-run, --last", async () => {
  const { w, project } = await populated("export-targets");
  const ag = await run(["export", "claude:latest", "--to", "antigravity"], w, { cwd: project });
  assert.match(ag.out, /Next, in Antigravity's chat for .*: mention @\.ai-chats\/2026-10-01-fix-login-redirect-loop\.md/);
  const md = await run(["export", "claude:latest", "--to", "markdown"], w, { cwd: project });
  assert.match(md.out, /^Wrote fix-login-redirect-loop\.md\n/);
  assert.match(md.out, /Cursor and Antigravity read it once you @-mention the file/);
  assert.ok(fs.existsSync(path.join(project, "fix-login-redirect-loop.md")));
  assert.match(read(path.join(project, "fix-login-redirect-loop.md")), /^project: .*webapp$/m, "the project path stays in the front matter");
  const json = await run(["export", "antigravity:latest", "--to", "json", "--out", "out/chat.json", "--last", "1"], w, { cwd: project });
  assert.match(json.out, /^Wrote out[\\/]chat\.json\n\s+Retry loop in the client from Antigravity: 1 exchange/);
  const j = JSON.parse(read(path.join(project, "out", "chat.json")));
  assert.equal(j.format, "claude-chat-ferry/1");
  assert.equal(j.turns.length, 2);
  assert.equal(j.turns[0].text, "thanks, also add a test");
  const stdout = await run(["export", "antigravity:latest", "--to", "md", "--out", "-"], w, { cwd: project });
  assert.match(stdout.out, /^---\ntitle: Retry loop in the client\ntool: antigravity\n/);
  assert.match(stdout.out, /## User · 2026-09-30 10:00\n\nfix the retry loop in client\.go/);
  const raw = await run(["export", "claude:latest", "--to", "markdown", "--out", "raw.md", "--no-redact"], w, { cwd: project });
  assert.match(raw.out, /replaced 0 secrets|no secrets found/);
  assert.match(raw.out, /\(not redacted\)/);
  assert.ok(read(path.join(project, "raw.md")).includes(SECRETS.github));
  const dry = await run(["export", "claude:latest", "--to", "json", "--dry-run"], w, { cwd: project });
  assert.match(dry.out, /^Would write .*fix-login-redirect-loop\.json\n/);
  assert.ok(!fs.existsSync(path.join(project, "fix-login-redirect-loop.json")));
  assert.match((await run(["export", "claude:latest"], w, { cwd: project })).err, /export needs --to cursor, antigravity, markdown, json or claude/);
  assert.match((await run(["export", "claude:latest", "--to", "pdf"], w, { cwd: project })).err, /export needs --to/);
  assert.match((await run(["export"], w)).err, /export needs a source/);
  const asImport = await run(["export", "antigravity:latest", "--to", "claude"], w, { cwd: project });
  assert.match(asImport.out, /^Imported Retry loop in the client from Antigravity into Claude Code/);
});

// --- the skill's command ---------------------------------------------------------------------------

test("skill-import prints the latest chat of the named tool as Markdown for the model, or says none was found", async () => {
  const { w, project } = await populated("skill");
  const ag = await run(["skill-import", "antigravity 1", "--project", project], w, { cwd: project });
  assert.equal(ag.code, 0, ag.all);
  assert.match(ag.out, /^Latest Antigravity chat for .*: "Retry loop in the client" \(2026-09-30 10:00 UTC\), 2 exchanges; the last 1 follow\.\n\n# Retry loop in the client\n/);
  assert.match(ag.out, /## User · 2026-09-30 10:02\n\nthanks, also add a test/);
  assert.ok(!ag.out.startsWith("---"), "no front matter for the model");
  const none = await run(["skill-import", "ag", "--project", w.project("empty")], w, { cwd: project });
  assert.match(none.out, /^Latest Antigravity chat for/, "Antigravity chats are not per project");
  const w2 = world("skill-none");
  const missing = await run(["skill-import", "antigravity", "--project", w2.project("x")], w2);
  assert.match(missing.out, /^No Antigravity chat was found for .*: no Antigravity conversation found\n$/);
  if (hasSqlite) {
    const cur = await run(["skill-import", "", "--project", project], w, { cwd: project });
    assert.match(cur.out, /^Latest Cursor chat for .*: "Fix the carousel on mobile" \(2026-07-12 09:14 UTC\), 2 exchanges\.\n/);
    const noneCursor = await run(["skill-import", "cursor 5", "--project", w.project("nothing")], w);
    assert.match(noneCursor.out, /^No Cursor chat was found for .*: no Cursor chat for the project/);
  } else {
    const cur = await run(["skill-import", "", "--project", project], w, { cwd: project });
    assert.match(cur.out, /^No Cursor chat was found for .*Node 22\.13/);
  }
});

// --- the real command line ---------------------------------------------------------------------------

test("the bin runs as a child process: exit codes and one-line errors", () => {
  const w = world("bin");
  const ok = runCli(["--help"], { env: w.env, cwd: w.base });
  assert.equal(ok.code, 0);
  assert.match(ok.out, /^claude-chat-ferry/);
  const bad = runCli(["import", "nope:latest"], { env: w.env, cwd: w.base });
  assert.equal(bad.code, 1);
  assert.equal(bad.out, "");
  assert.match(bad.err, /^claude-chat-ferry: "nope:latest" is not a source I know/);
  assert.ok(!bad.err.includes("at "), "no stack trace for a user error");
});

test("runCli refuses an environment that could touch a real config folder", () => {
  assert.throws(() => runCli(["--help"], { env: { CLAUDE_CONFIG_DIR: path.join(process.cwd(), "real") } }), /must be temporary/);
});

test("the Codex source works end to end: show, import", async () => {
  const { w, project } = await populated("codex");
  const show = await run(["show", "codex:latest"], w, { cwd: project });
  assert.match(show.out, /^Add a health endpoint\n\s+from\s+Codex CLI, id 0199c0de-1111/);
  assert.match(show.out, /model\s+gpt-5-codex/);
  const imp = await run(["import", "codex:latest", "--tools", "full"], w, { cwd: project });
  assert.match(imp.out, /^Imported Add a health endpoint from Codex CLI into Claude Code: 4 messages/);
  const id = /claude --resume ([0-9a-f-]{36})/.exec(imp.out)[1];
  const conv = readSession(sessionFiles({ env: w.env, project }).find((s) => s.id === id).file);
  assert.match(conv.turns[1].text, /\(Used exec_command: ls src\)\n```\napp\.js\nroutes\.js\n```/);
});

test("a session's own title and project survive a round trip through every format", async () => {
  const w = world("roundtrip");
  const project = w.project("p");
  const t = new Transcript({ seed: "rt", cwd: project });
  t.prompt("Round trip me"); t.say("Sure."); t.customTitle("Round trip");
  t.write(w.claude);
  for (const to of ["markdown", "json"]) {
    const out = path.join(w.base, `rt.${to === "json" ? "json" : "md"}`);
    const e = await run(["export", "claude:latest", "--to", to, "--out", out, "--force"], w, { cwd: project });
    assert.equal(e.code, 0, e.all);
    const s = await run(["show", out, "--json"], w, { cwd: project });
    const j = JSON.parse(s.out);
    assert.equal(j.title, "Round trip", to);
    assert.equal(j.stats.turns, 2, to);
    assert.equal(j.project, project, to);
  }
});
