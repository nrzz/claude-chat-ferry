import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tmpDir, world } from "./helpers.mjs";
import { makeCodex, sampleCodex } from "./fake-codex.mjs";
import { codexHome, findSession, listSessions, readSession } from "../src/codex.mjs";

const ID = { health: "0199c0de-1111-4111-8111-aaaaaaaaaaaa", other: "0199c0de-2222-4222-8222-bbbbbbbbbbbb" };

// A Codex home with the two sample sessions. Tests that only read share it.
const shared = world("codex");
const webapp = shared.project("webapp");
const other = shared.project("other");
makeCodex(shared.codex, sampleCodex(webapp, other));

const ids = (list) => list.map((s) => s.id);
const roles = (conv) => conv.turns.map((t) => t.role);
const texts = (conv) => conv.turns.map((t) => t.text);

// --- rollout files written by hand, for the shapes the sample does not have -------------------------------

function rollout(w, id, records, { name } = {}) {
  const folder = path.join(w.codex, "sessions", "2026", "10", "01");
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, name || `rollout-2026-10-01T09-00-00-${id}.jsonl`);
  fs.writeFileSync(file, `${records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n")}\n`);
  return file;
}
const meta = (id, cwd, extra = {}) => ({ timestamp: "2026-10-01T09:00:00.000Z", type: "session_meta", payload: { id, timestamp: "2026-10-01T09:00:00.000Z", cwd, ...extra } });
const item = (payload, timestamp = "2026-10-01T09:00:05.000Z") => ({ timestamp, type: "response_item", payload });
const userMsg = (text, at) => item({ type: "message", role: "user", content: [{ type: "input_text", text }] }, at);
const assistantMsg = (text, at) => item({ type: "message", role: "assistant", content: [{ type: "output_text", text }] }, at);
const call = (name, args, callId) => item({ type: "function_call", name, arguments: typeof args === "string" ? args : JSON.stringify(args), call_id: callId });
const output = (callId, out) => item({ type: "function_call_output", call_id: callId, output: out });

// One session of its own in a fresh Codex home, read back.
function session(records, { id = "0abc0000-0000-4000-8000-000000000001", cwd } = {}) {
  const w = world("codex-one");
  rollout(w, id, [meta(id, cwd ?? w.project("proj")), ...records]);
  const [entry] = listSessions({ env: w.env });
  return { w, entry, conv: readSession(entry) };
}

// --- where Codex keeps things -------------------------------------------------------------------------------

test("codexHome is CODEX_HOME when set, as an absolute path", () => {
  const dir = path.join(tmpDir(), "my-codex");
  assert.equal(codexHome({ CODEX_HOME: dir, HOME: "/ignored" }, "linux"), dir);
  assert.equal(codexHome({ CODEX_HOME: dir, USERPROFILE: "C:\\ignored" }, "win32"), dir);
  assert.equal(path.isAbsolute(codexHome({ CODEX_HOME: "relative/codex" }, "linux")), true);
});

test("codexHome otherwise is .codex in the home folder: USERPROFILE first on Windows, HOME everywhere else", () => {
  const home = path.join(tmpDir(), "home");
  const elsewhere = path.join(tmpDir(), "elsewhere");
  assert.equal(codexHome({ HOME: home }, "linux"), path.join(home, ".codex"));
  assert.equal(codexHome({ HOME: home }, "darwin"), path.join(home, ".codex"));
  assert.equal(codexHome({ USERPROFILE: home, HOME: elsewhere }, "win32"), path.join(home, ".codex"));
  assert.equal(codexHome({ HOME: home }, "win32"), path.join(home, ".codex"), "Windows falls back to HOME");
  assert.equal(codexHome({ HOME: home, USERPROFILE: elsewhere }, "linux"), path.join(home, ".codex"));
});

test("codexHome falls back to the home folder the system names when the environment has none", () => {
  assert.equal(codexHome({}, process.platform), path.join(os.homedir(), ".codex"));
});

// --- listing -----------------------------------------------------------------------------------------------------

test("listSessions lists the sessions of every project, newest first", () => {
  const list = listSessions({ env: shared.env, all: true });
  assert.deepEqual(ids(list), [ID.other, ID.health]);
  assert.deepEqual(ids(listSessions({ env: shared.env })), [ID.other, ID.health], "and so does naming no project");
});

test("listSessions titles a session with the first thing the person said, and names its project and times", () => {
  const [newer, older] = listSessions({ env: shared.env, all: true });
  assert.equal(older.title, "Add a health endpoint");
  assert.equal(newer.title, "Other project question");
  assert.equal(older.project, webapp, "the project is the folder Codex ran in");
  assert.equal(newer.project, other);
  assert.equal(older.startedAt, "2026-09-20T08:00:00.000Z");
  assert.equal(older.updatedAt, "2026-09-20T08:02:30.000Z", "the last time the file was written");
  assert.equal(newer.updatedAt, "2026-09-21T08:01:00.000Z");
  assert.equal(older.tool, "codex");
});

test("listSessions says where each session was read from", () => {
  const [first] = listSessions({ env: shared.env, all: true });
  assert.ok(first.source.startsWith(path.join(shared.codex, "sessions")));
  assert.match(path.basename(first.source), /^rollout-.*\.jsonl$/);
  assert.ok(fs.existsSync(first.source));
});

test("listSessions for a project gives only that project's sessions", () => {
  assert.deepEqual(ids(listSessions({ env: shared.env, project: webapp })), [ID.health]);
  assert.deepEqual(ids(listSessions({ env: shared.env, project: other })), [ID.other]);
  assert.deepEqual(listSessions({ env: shared.env, project: shared.project("never-used") }), []);
});

test("listSessions with all gives every project's sessions whatever project is named", () => {
  assert.deepEqual(ids(listSessions({ env: shared.env, project: webapp, all: true })), [ID.other, ID.health]);
});

test("listSessions counts a session about a parent folder for a project inside it, but not one about a sibling", () => {
  assert.deepEqual(ids(listSessions({ env: shared.env, project: path.join(webapp, "src", "api") })), [ID.health]);
  assert.deepEqual(ids(listSessions({ env: shared.env, project: `${webapp}-2` })), []);
});

test("listSessions with a limit gives that many of the newest", () => {
  assert.deepEqual(ids(listSessions({ env: shared.env, all: true, limit: 1 })), [ID.other]);
  assert.equal(listSessions({ env: shared.env, all: true, limit: 10 }).length, 2);
});

test("listSessions gives no sessions, without an error, when Codex has none", () => {
  const w = world("codex-none");
  assert.deepEqual(listSessions({ env: w.env }), []);
  assert.deepEqual(listSessions({ env: { ...w.env, CODEX_HOME: path.join(w.base, "never-made") }, all: true }), []);
});

test("listSessions ignores files and folders that are not rollout files, and a rollout with no session_meta", () => {
  const w = world("codex-decoys");
  makeCodex(w.codex, sampleCodex(w.project("webapp"), w.project("other")));
  const day = path.join(w.codex, "sessions", "2026", "09", "20");
  fs.writeFileSync(path.join(day, "notes.txt"), "not a session");
  fs.writeFileSync(path.join(day, "rollout-2026-09-20T09-00-00-wrong-extension.txt"), "{}");
  fs.mkdirSync(path.join(day, "rollout-a-folder.jsonl"));
  fs.writeFileSync(path.join(w.codex, "sessions", "stray-file.jsonl"), "{}");
  fs.writeFileSync(path.join(w.codex, "sessions", "2026", "stray-file.jsonl"), "{}");
  rollout(w, "no-meta", [userMsg("a rollout that never says who or where")]);
  assert.deepEqual(ids(listSessions({ env: w.env, all: true })), [ID.other, ID.health]);
});

test("listSessions takes the id from the file name when the session record has none", () => {
  const w = world("codex-noid");
  rollout(w, "unused", [{ timestamp: "2026-10-01T09:00:00.000Z", type: "session_meta", payload: { cwd: w.project("proj") } }, userMsg("hello")], { name: "rollout-2026-10-01T09-00-00-deadbeef.jsonl" });
  assert.deepEqual(ids(listSessions({ env: w.env })), ["deadbeef"]);
});

test("listSessions titles a session with no prompt \"(untitled)\", and a long first line is cut", () => {
  const empty = session([assistantMsg("an answer with no question")]);
  assert.equal(empty.entry.title, "(untitled)");
  assert.equal(empty.conv.title, "(untitled)");
  const long = session([userMsg(`${"z".repeat(100)}\nsecond line`)]);
  assert.equal(long.entry.title, `${"z".repeat(69)}\u2026`);
});

test("listSessions gives a session with no project folder no project", () => {
  const w = world("codex-nocwd");
  rollout(w, "0abc0000-0000-4000-8000-000000000009", [{ timestamp: "2026-10-01T09:00:00.000Z", type: "session_meta", payload: { id: "0abc0000-0000-4000-8000-000000000009" } }, userMsg("hello")]);
  const [entry] = listSessions({ env: w.env });
  assert.equal(entry.project, "");
  assert.deepEqual(listSessions({ env: w.env, project: w.project("proj") }), [], "and a project filter skips it");
});

// --- finding one session ---------------------------------------------------------------------------------------------

test("findSession(\"latest\") is the project's newest session, or the newest of all without a project", () => {
  assert.equal(findSession("latest", { env: shared.env, project: webapp }).id, ID.health);
  assert.equal(findSession("latest", { env: shared.env, project: other }).id, ID.other);
  assert.equal(findSession("latest", { env: shared.env }).id, ID.other);
  assert.equal(findSession("latest", { env: shared.env, project: shared.project("never-used") }), null);
});

test("findSession finds a session by the start of its id, in any case, whichever project is named", () => {
  assert.equal(findSession("0199c0de-1111", { env: shared.env }).id, ID.health);
  assert.equal(findSession("0199C0DE-2222", { env: shared.env, project: webapp }).id, ID.other, "an id is looked up everywhere");
  assert.equal(findSession(ID.health, { env: shared.env }).title, "Add a health endpoint");
});

test("findSession finds nothing for an id nobody starts with, or when there are no sessions", () => {
  assert.equal(findSession("deadbeef", { env: shared.env }), null);
  const none = world("codex-none");
  assert.equal(findSession("latest", { env: none.env }), null);
  assert.equal(findSession("0199", { env: none.env }), null);
});

test("findSession refuses an id start that fits two sessions, and says to give more of the id", () => {
  assert.throws(() => findSession("0199c0de", { env: shared.env }), /"0199c0de" matches 2 sessions; give more of the id/);
});

test("findSession takes a whole id even when it is also the start of another id", () => {
  const w = world("codex-prefix");
  rollout(w, "abc", [meta("abc", w.project("a")), userMsg("short id")], { name: "rollout-2026-10-01T09-00-00-abc.jsonl" });
  rollout(w, "abcdef", [meta("abcdef", w.project("b")), userMsg("long id")], { name: "rollout-2026-10-01T09-00-00-abcdef.jsonl" });
  assert.equal(findSession("abc", { env: w.env }).title, "short id");
  assert.equal(findSession("abcd", { env: w.env }).title, "long id");
});

// --- reading ---------------------------------------------------------------------------------------------------------

const health = () => readSession(findSession(ID.health, { env: shared.env }));

test("readSession gives alternating turns: what the person asked, then the assistant's work and answer", () => {
  const conv = health();
  assert.deepEqual(roles(conv), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(texts(conv), ["Add a health endpoint", "Added GET /health returning 200 and a test.", "Document it", "Documented in README under Endpoints."]);
});

test("readSession reads the model's reasoning summary as thinking", () => {
  const conv = health();
  assert.equal(conv.turns[1].thinking, "Need a route and a test.");
  assert.equal(conv.turns[0].thinking, "");
  assert.equal(conv.turns[3].thinking, "");
});

test("readSession pairs a function call with its output by call id", () => {
  const conv = health();
  assert.deepEqual(conv.turns[1].tools, [{ name: "exec_command", input: { cmd: "ls src" }, output: "app.js\nroutes.js" }]);
});

test("readSession takes the model from the turn context", () => {
  assert.equal(health().model, "gpt-5-codex");
  assert.equal(readSession(findSession(ID.other, { env: shared.env })).model, "", "a session that never named one");
});

test("readSession ignores event messages, which only repeat the conversation", () => {
  const { conv } = session([
    { timestamp: "2026-10-01T09:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "duplicate of the prompt" } },
    userMsg("real prompt"),
    { timestamp: "2026-10-01T09:00:06.000Z", type: "event_msg", payload: { type: "agent_message", message: "duplicate of the answer" } },
    assistantMsg("real answer"),
    { timestamp: "2026-10-01T09:00:07.000Z", type: "event_msg", payload: { type: "token_count", info: null } },
  ]);
  assert.deepEqual(texts(conv), ["real prompt", "real answer"]);
  assert.ok(!JSON.stringify(conv).includes("duplicate"));
});

test("readSession leaves out developer and system messages", () => {
  const { conv } = session([
    item({ type: "message", role: "developer", content: [{ type: "input_text", text: "developer instructions the person never wrote" }] }),
    item({ type: "message", role: "system", content: [{ type: "input_text", text: "system text" }] }),
    userMsg("real prompt"),
    assistantMsg("real answer"),
  ]);
  assert.deepEqual(texts(conv), ["real prompt", "real answer"]);
});

test("readSession names the session, its project and its times", () => {
  const conv = health();
  assert.equal(conv.tool, "codex");
  assert.equal(conv.id, ID.health);
  assert.equal(conv.title, "Add a health endpoint");
  assert.equal(conv.project, webapp);
  assert.equal(conv.startedAt, "2026-09-20T08:00:00.000Z");
  assert.equal(conv.endedAt, "2026-09-20T08:02:30.000Z");
  assert.equal(conv.turns[0].at, "2026-09-20T08:00:15.000Z");
  assert.equal(conv.turns[1].at, "2026-09-20T08:00:30.000Z");
  assert.ok(conv.source.endsWith(".jsonl"));
});

test("readSession joins the parts of a message, and reads a message whose content is plain text", () => {
  const { conv } = session([
    item({ type: "message", role: "user", content: [{ type: "input_text", text: "part one" }, { type: "input_text", text: "part two" }] }),
    item({ type: "message", role: "assistant", content: "a plain string" }),
  ]);
  assert.deepEqual(texts(conv), ["part one\npart two", "a plain string"]);
});

test("readSession joins several reasoning summaries, and ignores reasoning that has none", () => {
  const { conv } = session([
    userMsg("think"),
    item({ type: "reasoning", summary: [{ type: "summary_text", text: "First" }, { type: "summary_text", text: "Second" }] }),
    item({ type: "reasoning", summary: [], encrypted_content: "opaque" }),
    item({ type: "reasoning", summary: [{ type: "summary_text", text: "Third" }] }),
    assistantMsg("done"),
  ]);
  assert.deepEqual(roles(conv), ["user", "assistant"]);
  assert.equal(conv.turns[1].thinking, "First\nSecond\n\nThird");
});

test("readSession lets a later turn context change the model, and reads a model from the session record", () => {
  const first = session([{ timestamp: "2026-10-01T09:00:01.000Z", type: "turn_context", payload: { model: "model-one" } }, userMsg("q"), { timestamp: "2026-10-01T09:00:09.000Z", type: "turn_context", payload: { model: "model-two" } }, assistantMsg("a")]);
  assert.equal(first.conv.model, "model-two");
  const w = world("codex-meta-model");
  rollout(w, "0abc0000-0000-4000-8000-000000000002", [meta("0abc0000-0000-4000-8000-000000000002", w.project("p"), { model: "meta-model" }), userMsg("q"), assistantMsg("a")]);
  assert.equal(readSession(listSessions({ env: w.env })[0]).model, "meta-model");
});

test("readSession reads custom tool calls and shell calls and their outputs", () => {
  const { conv } = session([
    userMsg("patch it and list it"),
    item({ type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** End Patch", call_id: "c1" }),
    item({ type: "custom_tool_call_output", call_id: "c1", output: "Success. Updated the following files:\nM a.js" }),
    item({ type: "local_shell_call", call_id: "s1", action: { type: "exec", command: ["bash", "-lc", "ls"] } }),
    item({ type: "local_shell_call_output", call_id: "s1", output: "a.js\nb.js" }),
    assistantMsg("done"),
  ]);
  assert.deepEqual(conv.turns[1].tools, [
    { name: "apply_patch", input: "*** Begin Patch\n*** End Patch", output: "Success. Updated the following files:\nM a.js" },
    { name: "local_shell_call", input: { type: "exec", command: ["bash", "-lc", "ls"] }, output: "a.js\nb.js" },
  ]);
});

test("readSession keeps a tool call's arguments as text when they are not JSON, and writes an output that is not text as JSON", () => {
  const { conv } = session([
    userMsg("go"),
    call("plain_args", "just words", "p1"),
    output("p1", { exit_code: 0, stdout: "ok" }),
    call("no_output", { a: 1 }, "p2"),
    output("never-called", "an output with no call of its own"),
  ]);
  assert.deepEqual(conv.turns[1].tools, [
    { name: "plain_args", input: "just words", output: "{\"exit_code\":0,\"stdout\":\"ok\"}" },
    { name: "no_output", input: { a: 1 }, output: "" },
  ]);
  assert.ok(!JSON.stringify(conv).includes("an output with no call"), "an output nobody asked for is dropped");
});

test("readSession pairs outputs with calls by id, whatever order they come in", () => {
  const { conv } = session([
    userMsg("two commands"),
    call("exec_command", { cmd: "first" }, "a"),
    call("exec_command", { cmd: "second" }, "b"),
    output("b", "second output"),
    output("a", "first output"),
    assistantMsg("done"),
  ]);
  assert.deepEqual(conv.turns[1].tools.map((t) => [t.input.cmd, t.output]), [["first", "first output"], ["second", "second output"]]);
});

test("readSession skips lines that are not JSON, and records of kinds it does not know", () => {
  const id = "0abc0000-0000-4000-8000-000000000003";
  const w = world("codex-junk");
  rollout(w, id, [meta(id, w.project("p")), "this line is not JSON", "", userMsg("question"), { timestamp: "2026-10-01T09:00:06.000Z", type: "something_new", payload: { text: "unknown record" } }, assistantMsg("answer")]);
  const conv = readSession(listSessions({ env: w.env })[0]);
  assert.deepEqual(texts(conv), ["question", "answer"]);
});
