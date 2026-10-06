import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SECRETS, read, world } from "./helpers.mjs";
import { Transcript, richSession } from "./synthetic.mjs";
import { claudeDir, findSession, listSessions, projectDirName, projectSlug, projectsDir, promptText, readSession, renderAssistant, scanSession, sessionFiles, sessionRecords, writeSession } from "../src/claude-code.mjs";
import { conversation, turn } from "../src/model.mjs";

// --- where things are --------------------------------------------------------------------------

test("the config folder: CLAUDE_CONFIG_DIR, else ~/.claude; the projects folder under it", () => {
  assert.equal(claudeDir({ CLAUDE_CONFIG_DIR: "/tmp/cfg" }), path.resolve("/tmp/cfg"));
  const home = process.platform === "win32" ? "C:\\Users\\me" : "/home/me";
  assert.equal(claudeDir({ HOME: home, USERPROFILE: home }), path.join(home, ".claude"));
  assert.equal(projectsDir({ CLAUDE_CONFIG_DIR: "/tmp/cfg" }), path.join(path.resolve("/tmp/cfg"), "projects"));
});

test("the project slug replaces every non-alphanumeric character with a dash, and caps long paths with a hash", () => {
  assert.equal(projectSlug("D:\\Projects\\webapp"), "D--Projects-webapp");
  assert.equal(projectSlug("/home/me/proj.x"), "-home-me-proj-x");
  const long = "/" + "a".repeat(250);
  const s = projectSlug(long);
  assert.ok(s.length < 215 && /^-a{199}-[0-9a-z]+$/.test(s), s);
});

test("CLAUDE_CODE_PROJECT_DIR_NAME names the project folder when set", () => {
  assert.equal(projectDirName("/x/y", {}), "-x-y");
  assert.equal(projectDirName("/x/y", { CLAUDE_CODE_PROJECT_DIR_NAME: "my-proj" }), "my-proj");
});

// --- what the person typed ---------------------------------------------------------------------

test("promptText: plain text stays, commands and shell lines are spelled out, what Claude Code wrote is dropped", () => {
  assert.equal(promptText("Fix the bug"), "Fix the bug");
  assert.equal(promptText("<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src</command-args>"), "/review src");
  assert.equal(promptText("<command-name>/compact</command-name>"), "/compact");
  assert.equal(promptText("<bash-input>npm test</bash-input>"), "! npm test");
  assert.equal(promptText("<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>"), "");
  assert.equal(promptText("<local-command-stdout>x</local-command-stdout>"), "");
  assert.equal(promptText("<ide_opened_file>src/a.ts</ide_opened_file>"), "");
  assert.equal(promptText("<system-reminder>hidden</system-reminder>real question"), "real question");
  assert.equal(promptText("Caveat: the messages below..."), "");
  assert.equal(promptText("[Request interrupted by user]"), "");
  assert.equal(promptText(""), "");
});

// --- reading a session ---------------------------------------------------------------------------

test("readSession turns a rich session into alternating turns with tools, thinking, commands and the compaction summary", () => {
  const w = world("read");
  const cwd = w.project("webapp");
  const { file, id } = richSession(w.claude, { cwd });
  const conv = readSession(file);
  assert.equal(conv.tool, "claude-code");
  assert.equal(conv.id, id);
  assert.equal(conv.title, "Fix login redirect loop");
  assert.equal(conv.project, cwd);
  assert.equal(conv.model, "claude-opus-5-5");
  assert.ok(conv.startedAt < conv.endedAt);
  const roles = conv.turns.map((t) => t.role).join(" ");
  assert.equal(roles, "user assistant user assistant user assistant");
  const [u1, a1, u2, a2, u3, a3] = conv.turns;
  assert.equal(u1.text, "Fix the login redirect loop in src/auth.ts");
  assert.equal(a1.thinking, "The redirect loops when the cookie is missing.");
  assert.equal(a1.tools.length, 1);
  assert.equal(a1.tools[0].name, "Read");
  assert.equal(a1.tools[0].input.file_path, `${cwd}/src/auth.ts`);
  assert.equal(a1.tools[0].output, "export function login() {}\n");
  assert.equal(a1.text, "The loop comes from a missing cookie check. I will guard it.");
  assert.equal(u2.text, "/review src\n\n! npm test\n\nWhat about this screenshot?\n\n[1 image attached]", "a slash command, a shell command and the next prompt, as typed and in one turn since nothing was answered between them; their output is not a turn");
  assert.equal(a2.text, "The screenshot shows the same loop.");
  assert.match(u3.text, /^This session is being continued[\s\S]*Summary: the login loop is being fixed\.\n\nAdd a test for it$/, "the compaction summary and the next prompt merge into one user turn");
  assert.equal(a3.text, "Added test/auth.test.ts with a regression test.");
  assert.ok(!JSON.stringify(conv).includes("subagent chatter"), "subagent lines are left out");
  assert.ok(!JSON.stringify(conv).includes("ide_opened_file"));
});

test("readSession: a string-content user record, a title from ai-title, then summary, then the first prompt", () => {
  const w = world("titles");
  const cwd = w.project("p");
  const a = new Transcript({ seed: "a", cwd });
  a.user("Plain string prompt");
  a.say("ok");
  a.aiTitle("AI chose this");
  const fa = a.write(w.claude).file;
  assert.equal(readSession(fa).title, "AI chose this");
  const b = new Transcript({ seed: "b", cwd });
  b.user("Summary wins over the prompt");
  b.say("ok");
  b.summaryLine("Short summary title");
  assert.equal(readSession(b.write(w.claude).file).title, "Short summary title");
  const c = new Transcript({ seed: "c", cwd });
  c.user("The first prompt names it\nsecond line");
  c.say("ok");
  c.summaryLine("x".repeat(200));
  assert.equal(readSession(c.write(w.claude).file).title, "The first prompt names it", "a long summary is a compaction note, not a title");
  const d = new Transcript({ seed: "d", cwd });
  d.user([{ type: "tool_result", tool_use_id: "nope", content: "orphan" }]);
  d.say("only an answer");
  assert.equal(readSession(d.write(w.claude).file).title, "(untitled)");
});

test("readSession on a missing or empty file gives an empty conversation", () => {
  const w = world("empty");
  const conv = readSession(path.join(w.base, "nope.jsonl"));
  assert.deepEqual(conv.turns, []);
  assert.equal(conv.title, "(untitled)");
  const f = path.join(w.base, "empty.jsonl");
  fs.writeFileSync(f, "\n\nnot json\n");
  assert.deepEqual(readSession(f).turns, []);
});

// --- listing -------------------------------------------------------------------------------------

test("scanSession counts the person's prompts and finds the title without parsing every line", () => {
  const w = world("scan");
  const cwd = w.project("webapp");
  const { file } = richSession(w.claude, { cwd });
  const info = scanSession(file);
  assert.equal(info.title, "Fix login redirect loop");
  assert.equal(info.prompts, 5, "the prompt, /review, ! npm test, the image prompt, and the last prompt");
  assert.equal(info.firstPrompt, "Fix the login redirect loop in src/auth.ts");
  assert.equal(info.cwd, cwd);
  assert.ok(info.started);
});

test("sessionFiles and listSessions: by project or all, newest first, with titles", () => {
  const w = world("list");
  const webapp = w.project("webapp");
  const other = w.project("other");
  const sub = path.join(webapp, "packages", "ui");
  fs.mkdirSync(sub, { recursive: true });
  const older = new Transcript({ seed: "older", cwd: webapp, start: "2026-09-01T10:00:00Z" });
  older.prompt("Old question"); older.say("Old answer"); older.customTitle("Older");
  older.write(w.claude);
  const newer = richSession(w.claude, { cwd: webapp, start: "2026-09-05T10:00:00Z" });
  const elsewhere = new Transcript({ seed: "else", cwd: other, start: "2026-09-06T10:00:00Z" });
  elsewhere.prompt("Elsewhere"); elsewhere.say("ok");
  elsewhere.write(w.claude);
  const inSub = new Transcript({ seed: "sub", cwd: sub, start: "2026-09-04T10:00:00Z" });
  inSub.prompt("In a package"); inSub.say("ok");
  inSub.write(w.claude);
  const all = sessionFiles({ env: w.env, all: true });
  assert.equal(all.length, 4);
  assert.equal(all[0].id, elsewhere.id, "newest first");
  const mine = sessionFiles({ env: w.env, project: webapp });
  assert.deepEqual(mine.map((s) => s.id), [newer.id, inSub.id, older.id], "the project's own sessions and those of folders inside it");
  const listed = listSessions({ env: w.env, project: webapp, limit: 2 });
  assert.equal(listed.length, 2);
  assert.equal(listed[0].title, "Fix login redirect loop");
  assert.equal(listed[0].prompts, 5);
  assert.equal(listed[0].project, webapp);
  assert.equal(listSessions({ env: w.env, project: other })[0].title, "Elsewhere");
  assert.deepEqual(sessionFiles({ env: w.env, project: w.project("none") }), []);
  fs.writeFileSync(path.join(w.claude, "projects", projectSlug(webapp), "notes.txt"), "not a session");
  assert.equal(sessionFiles({ env: w.env, project: webapp }).length, 3, "only <uuid>.jsonl files count");
});

test("findSession: latest skips a session with no prompt, an id prefix matches, an ambiguous prefix is an error", () => {
  const w = world("find");
  const cwd = w.project("p");
  const empty = new Transcript({ seed: "empty", cwd, start: "2026-09-09T10:00:00Z" });
  empty.say("an answer with no prompt");
  empty.write(w.claude);
  const real = new Transcript({ seed: "real", cwd, start: "2026-09-08T10:00:00Z" });
  real.prompt("hello"); real.say("hi");
  real.write(w.claude);
  assert.equal(findSession("latest", { env: w.env, project: cwd }).id, real.id);
  assert.equal(findSession(real.id.slice(0, 8), { env: w.env, project: cwd }).id, real.id);
  assert.equal(findSession(real.id.toUpperCase(), { env: w.env }).id, real.id);
  assert.equal(findSession("zzzz", { env: w.env, project: cwd }), null);
  const twin = new Transcript({ seed: "twin", id: real.id.slice(0, 8) + "-0000-4000-8000-000000000000", cwd });
  twin.prompt("twin"); twin.say("ok");
  twin.write(w.claude);
  assert.throws(() => findSession(real.id.slice(0, 8), { env: w.env, project: cwd }), /matches 2 sessions/);
  assert.equal(findSession(real.id, { env: w.env, project: cwd }).id, real.id, "the full id is never ambiguous");
});

// --- writing a session -------------------------------------------------------------------------

const sample = () => conversation({
  tool: "cursor", id: "c1", title: "Carousel bug", startedAt: "2026-07-12T09:14:00Z",
  turns: [
    turn("user", { at: "2026-07-12T09:14:00Z", text: "The arrows do not advance on mobile." }),
    turn("assistant", { at: "2026-07-12T09:15:00Z", text: "The touch handler swallows the click.", thinking: "Check the handler.", tools: [{ name: "read_file", input: { path: "src/Gallery.tsx" }, output: "export const Gallery = 1;" }] }),
    turn("user", { at: "2026-07-12T09:16:00Z", text: "Smallest fix?" }),
    turn("assistant", { at: "2026-07-12T09:17:00Z", text: "Only preventDefault after a swipe." }),
  ],
});

test("renderAssistant: tool calls as one line each, with their output in full mode, none in none mode; thinking only when asked", () => {
  const t = sample().turns[1];
  assert.equal(renderAssistant(t), "The touch handler swallows the click.\n\n(Used read_file: src/Gallery.tsx)");
  assert.equal(renderAssistant(t, { tools: "none" }), "The touch handler swallows the click.");
  assert.match(renderAssistant(t, { tools: "full" }), /\(Used read_file: src\/Gallery\.tsx\)\n```\nexport const Gallery = 1;\n```/);
  assert.match(renderAssistant(t, { thinking: true }), /^\(Thinking: Check the handler\.\)\n\nThe touch/);
  assert.equal(renderAssistant(turn("assistant", { tools: [{ name: "ls", input: {}, output: "" }] })), "(Used ls)");
  const big = turn("assistant", { tools: [{ name: "run", input: { command: "x" }, output: "y".repeat(5000) }] });
  const full = renderAssistant(big, { tools: "full", outputMax: 100 });
  assert.ok(full.length < 400 && full.includes("characters left out"));
});

test("sessionRecords: a title record, a summary record, a banner on the first user message, alternating roles, rising timestamps", () => {
  const { sessionId, records, title, messages } = sessionRecords(sample(), { cwd: "/w/proj" });
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(title, "Carousel bug");
  assert.equal(messages, 4);
  assert.deepEqual(records[0], { type: "custom-title", customTitle: "Carousel bug", sessionId });
  assert.equal(records[1].type, "summary");
  assert.equal(records[1].summary, "Carousel bug");
  assert.equal(records[1].leafUuid, records[records.length - 1].uuid);
  const turns = records.slice(2);
  assert.deepEqual(turns.map((r) => r.type), ["user", "assistant", "user", "assistant"]);
  assert.match(turns[0].message.content[0].text, /^\[Conversation imported from Cursor chat "Carousel bug", 2026-07-12 by claude-chat-ferry\. It continues from here\.\]\n\nThe arrows/);
  assert.equal(turns[0].parentUuid, null);
  assert.equal(turns[1].parentUuid, turns[0].uuid);
  assert.equal(turns[1].message.model, "imported");
  assert.equal(turns[1].message.content[0].text, "The touch handler swallows the click.\n\n(Used read_file: src/Gallery.tsx)");
  assert.equal(turns[1].message.stop_reason, "end_turn");
  assert.equal(turns[1].requestId, "req_import_2");
  for (const r of turns) { assert.equal(r.sessionId, sessionId); assert.equal(r.cwd, "/w/proj"); assert.equal(r.isSidechain, false); assert.equal(r.userType, "external"); assert.match(r.timestamp, /^\d{4}-\d{2}-\d{2}T/); }
  for (let i = 1; i < turns.length; i++) assert.ok(turns[i].timestamp > turns[i - 1].timestamp, "timestamps rise");
  assert.equal(turns[0].timestamp, "2026-07-12T09:14:00.000Z", "the original times are kept when they are in order");
});

test("sessionRecords: consecutive turns of one role are joined, a chat that starts with the assistant gets a user banner first", () => {
  const conv = conversation({ tool: "antigravity", title: "T", turns: [turn("assistant", { text: "Hello first" }), turn("assistant", { text: "and again" }), turn("user", { text: "ok" }), turn("user", { text: "second" })] });
  const { records } = sessionRecords(conv, { cwd: "/p" });
  const turns = records.slice(2);
  assert.deepEqual(turns.map((r) => r.type), ["user", "assistant", "user"]);
  assert.match(turns[0].message.content[0].text, /^\[Conversation imported from Antigravity chat "T"/);
  assert.equal(turns[1].message.content[0].text, "Hello first\n\nand again");
  assert.equal(turns[2].message.content[0].text, "ok\n\nsecond");
  const noBanner = sessionRecords(conv, { cwd: "/p", banner: false }).records.slice(2);
  assert.equal(noBanner[0].type, "user");
  assert.match(noBanner[0].message.content[0].text, /imported; it begins with the assistant/);
  const plain = sessionRecords(sample(), { cwd: "/p", banner: false, title: "My title", model: "m1" });
  assert.equal(plain.records[0].customTitle, "My title");
  assert.ok(!plain.records[2].message.content[0].text.startsWith("["));
  assert.equal(plain.records[3].message.model, "m1");
});

test("sessionRecords: out-of-order times fall back to one second apart, and a missing start ends now", () => {
  const conv = sample();
  conv.turns[2].at = "2020-01-01T00:00:00Z";
  const turns = sessionRecords(conv, { cwd: "/p" }).records.slice(2);
  assert.equal(Date.parse(turns[2].timestamp) - Date.parse(turns[1].timestamp), 1000);
  const undated = conversation({ tool: "json", title: "x", turns: [turn("user", { text: "a" }), turn("assistant", { text: "b" })] });
  const now = new Date("2026-10-06T12:00:00Z");
  const t2 = sessionRecords(undated, { cwd: "/p", now }).records.slice(2);
  assert.equal(t2[1].timestamp, "2026-10-06T12:00:00.000Z");
});

test("writeSession writes the file where Claude Code looks, reads back the same turns, and never reuses an id", () => {
  const w = world("write");
  const cwd = w.project("proj");
  const written = writeSession(sample(), { env: w.env, cwd });
  assert.equal(path.dirname(written.file), path.join(w.claude, "projects", projectSlug(cwd)));
  assert.equal(path.basename(written.file), `${written.id}.jsonl`);
  assert.ok(!fs.existsSync(`${written.file}.${process.pid}.tmp`), "the temporary file is gone");
  const back = readSession(written.file);
  assert.equal(back.title, "Carousel bug");
  assert.equal(back.turns.length, 4);
  assert.match(back.turns[0].text, /^\[Conversation imported from Cursor/);
  assert.equal(back.turns[3].text, "Only preventDefault after a swipe.");
  assert.equal(back.model, "imported");
  assert.equal(back.project, cwd);
  assert.throws(() => writeSession(sample(), { env: w.env, cwd, id: written.id }), /already exists/);
  const listed = listSessions({ env: w.env, project: cwd });
  assert.equal(listed[0].id, written.id);
  assert.equal(listed[0].title, "Carousel bug");
  assert.equal(listed[0].prompts, 2);
  const named = writeSession(sample(), { env: { ...w.env, CLAUDE_CODE_PROJECT_DIR_NAME: "named-proj" }, cwd });
  assert.equal(path.basename(path.dirname(named.file)), "named-proj");
  assert.equal(sessionFiles({ env: { ...w.env, CLAUDE_CODE_PROJECT_DIR_NAME: "named-proj" }, project: cwd }).length, 2, "the named folder counts for the project");
});

test("a secret in a turn reaches the session file unchanged unless the caller redacted it first", () => {
  const w = world("secret");
  const conv = sample();
  conv.turns[0].text += ` key ${SECRETS.anthropic}`;
  const { file } = writeSession(conv, { env: w.env, cwd: w.project("p") });
  assert.ok(read(file).includes(SECRETS.anthropic), "the import stays on the machine; redaction is the CLI's --redact");
});
