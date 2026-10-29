import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, world } from "./helpers.mjs";
import { IDS, SESSION_CONTEXT, call, makeGemini, model, sampleGemini, sha256, toolAnswer, user } from "./fake-gemini.mjs";
import { geminiHome, findSession, listSessions, readSession } from "../src/gemini.mjs";
import { detectJson, listJsonFile, readJsonFile } from "../src/exports.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "gemini-0.64.0");

// A Gemini CLI home with the two sample sessions. Tests that only read share it.
const shared = world("gemini");
const webapp = shared.project("webapp");
const other = shared.project("other");
makeGemini(shared.gemini, sampleGemini(webapp, other));

const ids = (list) => list.map((s) => s.id);
const T = (s) => `2026-10-01T10:00:${String(s).padStart(2, "0")}.000Z`;

// One session written by hand into a fresh world; returns what readSession gives.
function readRecords(records, { project, ...rest } = {}) {
  const w = world("gemini-one");
  const p = project ?? w.project("p");
  makeGemini(w.gemini, [{ id: "aaaaaaaa-0000-4000-8000-000000000001", project: p, started: T(0), updated: T(59), records, ...rest }]);
  const entry = findSession("latest", { env: w.env, project: p });
  assert.ok(entry, "the session is listed for its project");
  return readSession(entry);
}

// --- where Gemini CLI keeps its files -----------------------------------------------------------------

test("geminiHome makes .gemini inside GEMINI_CLI_HOME, as an absolute path", () => {
  const dir = path.join(tmpDir(), "my-home");
  assert.equal(geminiHome({ GEMINI_CLI_HOME: dir, HOME: "/ignored" }, "linux"), path.join(dir, ".gemini"));
  assert.equal(geminiHome({ GEMINI_CLI_HOME: dir, USERPROFILE: "C:\\ignored" }, "win32"), path.join(dir, ".gemini"));
  assert.equal(path.isAbsolute(geminiHome({ GEMINI_CLI_HOME: "relative/home" }, "linux")), true);
});

test("GEMINI_HOME is not a Gemini CLI setting and is ignored", () => {
  const home = path.join(tmpDir(), "home");
  assert.equal(geminiHome({ GEMINI_HOME: path.join(tmpDir(), "elsewhere"), HOME: home }, "linux"), path.join(home, ".gemini"));
});

test("geminiHome otherwise is .gemini in the home folder: USERPROFILE first on Windows, HOME everywhere else", () => {
  const home = path.join(tmpDir(), "home");
  const elsewhere = path.join(tmpDir(), "elsewhere");
  assert.equal(geminiHome({ HOME: home }, "linux"), path.join(home, ".gemini"));
  assert.equal(geminiHome({ HOME: home }, "darwin"), path.join(home, ".gemini"));
  assert.equal(geminiHome({ USERPROFILE: home, HOME: elsewhere }, "win32"), path.join(home, ".gemini"));
  assert.equal(geminiHome({ HOME: home }, "win32"), path.join(home, ".gemini"), "Windows falls back to HOME");
  assert.equal(geminiHome({ HOME: home, USERPROFILE: elsewhere }, "linux"), path.join(home, ".gemini"));
});

test("geminiHome falls back to the home folder the system names when the environment has none", () => {
  assert.equal(geminiHome({}, process.platform), path.join(os.homedir(), ".gemini"));
});

test("sessions are found under $GEMINI_CLI_HOME/.gemini/tmp, and nowhere else", () => {
  assert.ok(fs.existsSync(path.join(shared.gemini, ".gemini", "tmp")));
  assert.equal(listSessions({ env: { ...shared.env, GEMINI_CLI_HOME: path.join(shared.gemini, ".gemini") }, all: true }).length, 0, "pointing at .gemini itself finds nothing");
  assert.equal(listSessions({ env: { ...shared.env, GEMINI_CLI_HOME: "", GEMINI_HOME: shared.gemini, HOME: tmpDir(), USERPROFILE: tmpDir() }, all: true }).length, 0, "and GEMINI_HOME is not read");
});

// --- listing -----------------------------------------------------------------------------------------

test("listSessions lists the sessions of every project, newest first", () => {
  assert.deepEqual(ids(listSessions({ env: shared.env, all: true })), [IDS.other, IDS.health]);
});

test("listSessions titles a session with the first thing the person said, not Gemini CLI's session context", () => {
  const [newer, older] = listSessions({ env: shared.env, all: true });
  assert.equal(older.title, "Add a health endpoint");
  assert.equal(newer.title, "Other project question");
  assert.equal(older.startedAt, "2026-09-20T08:00:00.000Z");
  assert.equal(older.updatedAt, "2026-09-20T08:02:30.000Z");
  assert.equal(older.tool, "gemini");
  assert.deepEqual(Object.keys(older).sort(), ["id", "project", "source", "startedAt", "title", "tool", "updatedAt"]);
});

test("listSessions says where each session was read from", () => {
  const [first] = listSessions({ env: shared.env, all: true });
  assert.ok(first.source.startsWith(path.join(shared.gemini, ".gemini", "tmp")));
  assert.match(path.basename(first.source), /^session-.*\.jsonl?$/);
  assert.ok(fs.existsSync(first.source));
});

test("the project of a session comes from projects.json, which names the folder Gemini CLI keeps a project's files in", () => {
  const older = listSessions({ env: shared.env, all: true }).find((s) => s.id === IDS.health);
  assert.equal(older.project, webapp);
  assert.deepEqual(ids(listSessions({ env: shared.env, project: webapp })), [IDS.health]);
});

test("the project of a session comes from `directories` in its metadata when it has them", () => {
  const newer = listSessions({ env: shared.env, all: true }).find((s) => s.id === IDS.other);
  assert.equal(newer.project, other);
  assert.deepEqual(ids(listSessions({ env: shared.env, project: other })), [IDS.other]);
  assert.deepEqual(ids(listSessions({ env: shared.env, project: path.join(other, "src") })), [IDS.other], "a folder inside the project belongs to it");
  assert.deepEqual(listSessions({ env: shared.env, project: shared.project("never-used") }), []);
});

test("a session belongs to a project when one of its directories holds the project or lies inside it", () => {
  const w = world("gemini-dirs");
  const a = w.project("a");
  const b = w.project("b");
  makeGemini(w.gemini, [{ id: "bbbbbbbb-0000-4000-8000-000000000001", project: a, registry: false, started: T(0), meta: { directories: [a, b] }, records: [user("u1", T(1), "two folders")] }]);
  assert.deepEqual(ids(listSessions({ env: w.env, project: a })), ["bbbbbbbb-0000-4000-8000-000000000001"]);
  assert.deepEqual(ids(listSessions({ env: w.env, project: b })), ["bbbbbbbb-0000-4000-8000-000000000001"]);
  assert.deepEqual(ids(listSessions({ env: w.env, project: path.join(b, "deep", "er") })), ["bbbbbbbb-0000-4000-8000-000000000001"]);
});

test("without a registry entry or directories, the SHA-256 of the project folder (older releases' folder name) finds the session", () => {
  const w = world("gemini-legacy");
  const p = w.project("legacy");
  makeGemini(w.gemini, [{ id: "cccccccc-0000-4000-8000-000000000001", project: p, legacy: true, started: T(0), records: [user("u1", T(1), "an old session")] }]);
  assert.ok(fs.existsSync(path.join(w.gemini, ".gemini", "tmp", sha256(p), "chats")));
  const hit = listSessions({ env: w.env, project: p });
  assert.deepEqual(ids(hit), ["cccccccc-0000-4000-8000-000000000001"]);
  assert.equal(hit[0].project, p, "and the folder that matched is the project");
  assert.deepEqual(ids(listSessions({ env: w.env, project: path.join(p, "sub") })), ["cccccccc-0000-4000-8000-000000000001"], "also from a folder inside it");
  assert.deepEqual(listSessions({ env: w.env, project: w.project("another") }), []);
  assert.equal(listSessions({ env: w.env, all: true })[0].project, "", "with --all it is listed, project unknown");
});

test("a session whose project cannot be told is listed with --all and not for a project", () => {
  const w = world("gemini-unknown");
  makeGemini(w.gemini, [{ id: "dddddddd-0000-4000-8000-000000000001", project: w.project("x"), registry: false, started: T(0), records: [user("u1", T(1), "who am I")] }]);
  assert.equal(listSessions({ env: w.env, all: true }).length, 1);
  assert.deepEqual(listSessions({ env: w.env, project: w.project("y") }), []);
});

test("listSessions honors limit", () => {
  const list = listSessions({ env: shared.env, all: true, limit: 1 });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, IDS.other);
});

test("listSessions returns an empty list when there is no tmp folder", () => {
  assert.deepEqual(listSessions({ env: world("gemini-empty").env, all: true }), []);
});

test("a .json session of an older release is listed and read like a .jsonl one", () => {
  const w = world("gemini-json");
  const p = w.project("old");
  makeGemini(w.gemini, [{ id: "eeeeeeee-0000-4000-8000-000000000001", project: p, json: true, started: T(0), updated: T(30), records: [user("u1", T(1), SESSION_CONTEXT), user("u2", T(2), "old shape"), model("m1", T(3), "old answer", { thoughts: [{ subject: "Hm", description: "old thought" }] })] }]);
  const [entry] = listSessions({ env: w.env, project: p });
  assert.match(path.basename(entry.source), /\.json$/);
  assert.equal(entry.title, "old shape");
  const conv = readSession(entry);
  assert.deepEqual(conv.turns.map((t) => [t.role, t.text]), [["user", "old shape"], ["assistant", "old answer"]]);
  assert.equal(conv.turns[1].thinking, "**Hm** old thought");
});

// --- finding -----------------------------------------------------------------------------------------

test("findSession(\"latest\") gives the newest session", () => {
  assert.equal(findSession("latest", { env: shared.env, all: true }).id, IDS.other);
  assert.equal(findSession("latest", { env: shared.env, project: webapp }).id, IDS.health);
});

test("findSession by id prefix or exact match", () => {
  assert.equal(findSession("11111111", { env: shared.env }).id, IDS.health);
  assert.equal(findSession(IDS.health, { env: shared.env }).id, IDS.health);
  assert.equal(findSession("non-existent", { env: shared.env }), null);
});

test("findSession throws on an ambiguous prefix", () => {
  const w = world("gemini-amb");
  makeGemini(w.gemini, [
    { id: "dup0aaaa-1111-4000-8000-000000000001", project: w.project("a"), started: T(0), records: [user("u1", T(1), "hi")] },
    { id: "dup0bbbb-2222-4000-8000-000000000002", project: w.project("a"), started: T(0), records: [user("u1", T(1), "hello")] },
  ]);
  assert.throws(() => findSession("dup0", { env: w.env }), /"dup0" matches 2 sessions; give more of the id/);
});

// --- reading: what Gemini CLI 0.64.0 wrote ----------------------------------------------------------------

test("readSession reads the turns, the model, the thinking and the tool output of a session as Gemini CLI writes it", () => {
  const conv = readSession(findSession(IDS.health, { env: shared.env }));
  assert.equal(conv.tool, "gemini");
  assert.equal(conv.id, IDS.health);
  assert.equal(conv.project, webapp);
  assert.equal(conv.model, "gemini-3.1-pro-preview");
  assert.deepEqual(conv.turns.map((t) => t.role), ["user", "assistant", "user", "assistant"], "the session context and the tool's answer going back are not turns");
  assert.equal(conv.turns[0].text, "Add a health endpoint");
  const a = conv.turns[1];
  assert.equal(a.thinking, "**Looking around** Need a route and a test.", "the thought is once, not once per write of the message");
  assert.equal(a.text, "Added GET /health returning 200 and a test.");
  assert.equal(a.tools.length, 1, "the message written twice is one message");
  assert.equal(a.tools[0].name, "run_shell_command");
  assert.deepEqual(a.tools[0].input, { command: "ls src" });
  assert.equal(a.tools[0].output, "app.js\nroutes.js");
  assert.equal(conv.turns[2].text, "Document it");
  assert.equal(conv.turns[3].text, "Documented in README under Endpoints.");
});

test("thoughts are joined from their subject and description", () => {
  const conv = readRecords([
    user("u1", T(1), "think"),
    model("m1", T(2), "done", { thoughts: [{ subject: "First", description: "one.", timestamp: T(2) }, { subject: "", description: "no subject", timestamp: T(2) }, { subject: "Third", description: "", timestamp: T(2) }] }),
  ]);
  assert.equal(conv.turns[1].thinking, "**First** one.\n\nno subject\n\n**Third**");
});

test("a tool's output is the output of its functionResponse, or its error", () => {
  const conv = readRecords([
    user("u1", T(1), "run things"),
    model("m1", T(2), "tried", { toolCalls: [
      call("c1", "read_file", { file_path: "a.txt" }, { output: "alpha\nbeta\n" }, T(3)),
      call("c2", "read_file", { file_path: "nope.txt" }, { error: "File not found: nope.txt" }, T(3)),
      { id: "c3", name: "weird", args: {}, result: "plain string result" },
      { id: "c4", name: "empty", args: {}, result: null },
    ] }),
  ]);
  assert.deepEqual(conv.turns[1].tools.map((t) => [t.name, t.output]), [["read_file", "alpha\nbeta\n"], ["read_file", "File not found: nope.txt"], ["weird", "plain string result"], ["empty", ""]]);
});

test("the content of a message can be a string, one part or a list of parts", () => {
  const conv = readRecords([
    user("u1", T(1), "a list"),
    model("m1", T(2), [{ text: "first " }, { text: "second", thought: false }, { text: "private", thought: true }]),
    { id: "u2", timestamp: T(3), type: "user", content: { text: "one part" } },
    { id: "m2", timestamp: T(4), type: "gemini", content: { text: "one part back" } },
    { id: "u3", timestamp: T(5), type: "user", content: "a string" },
  ]);
  assert.deepEqual(conv.turns.map((t) => t.text), ["a list", "first \nsecond", "one part", "one part back", "a string"]);
  assert.equal(conv.turns[1].thinking, "private", "a thought part is thinking, not text");
});

test("info, error and warning messages are not turns", () => {
  const conv = readRecords([
    user("u1", T(1), "hi"),
    { id: "i1", timestamp: T(2), type: "info", content: "Switched model" },
    { id: "e1", timestamp: T(3), type: "error", content: "quota" },
    { id: "w1", timestamp: T(4), type: "warning", content: "careful" },
    model("m1", T(5), "hello"),
  ]);
  assert.deepEqual(conv.turns.map((t) => t.text), ["hi", "hello"]);
});

test("a tool call that only the content holds (after a $patch) takes the answer that came back for it", () => {
  const conv = readRecords([
    user("u1", T(1), "go"),
    { id: "m1", timestamp: T(2), type: "gemini", content: [{ functionCall: { id: "f1", name: "run_shell_command", args: { command: "pwd" } } }] },
    toolAnswer("u2", T(3), "f1", "run_shell_command", { output: "/work" }),
    model("m2", T(4), "ok"),
  ]);
  assert.deepEqual(conv.turns[1].tools, [{ name: "run_shell_command", input: { command: "pwd" }, output: "/work" }]);
});

// --- reading: $set, $patch and $rewindTo lines --------------------------------------------------------------

test("a $set line merges into the metadata: lastUpdated, and directories that name the project", () => {
  const w = world("gemini-set");
  const p = w.project("set");
  makeGemini(w.gemini, [{ id: "ffffffff-0000-4000-8000-000000000001", project: p, registry: false, started: T(0), updated: T(0), records: [user("u1", T(1), "hi"), { $set: { lastUpdated: T(40) } }, { $set: { directories: [p] } }] }]);
  const [entry] = listSessions({ env: w.env, project: p });
  assert.equal(entry.updatedAt, T(40));
  assert.equal(entry.project, p);
});

test("a $set line with messages replaces the messages", () => {
  const conv = readRecords([user("u1", T(1), "gone"), model("m1", T(2), "gone too"), { $set: { messages: [user("u2", T(3), "kept"), model("m2", T(4), "also kept")] } }]);
  assert.deepEqual(conv.turns.map((t) => t.text), ["kept", "also kept"]);
});

test("a $patch line changes a message's content and the result of its tool calls", () => {
  const conv = readRecords([
    user("u1", T(1), "patch me"),
    model("m1", T(2), "before", { toolCalls: [call("c1", "read_file", { file_path: "a" }, { output: "old" }, T(2))] }),
    { $patch: { updates: [{ id: "m1", content: "after", toolCalls: [{ id: "c1", result: [{ functionResponse: { id: "c1", name: "read_file", response: { output: "new" } } }] }, { id: "nope", result: null }] }] } },
    { $patch: { id: "u1", content: [{ text: "patched prompt" }] } },
    { $patch: { updates: [{ id: "missing", content: "x" }] } },
  ]);
  assert.deepEqual(conv.turns.map((t) => t.text), ["patched prompt", "after"]);
  assert.equal(conv.turns[1].tools[0].output, "new");
});

test("a $patch line can remove and reorder messages", () => {
  const conv = readRecords([
    user("u1", T(1), "one"), model("m1", T(2), "two"), user("u2", T(3), "three"), model("m2", T(4), "four"),
    { $patch: { removeIds: ["u2", "m2"] } },
    user("u3", T(5), "five"), model("m3", T(6), "six"),
    { $patch: { orderIds: ["u3", "m3", "u1", "m1"] } },
  ]);
  assert.deepEqual(conv.turns.map((t) => t.text), ["five", "six", "one", "two"]);
});

test("a $rewindTo line drops that message and every later one; an unknown id drops them all", () => {
  const records = [user("u1", T(1), "one"), model("m1", T(2), "two"), user("u2", T(3), "three"), model("m2", T(4), "four")];
  const conv = readRecords([...records, { $rewindTo: "u2" }, user("u3", T(5), "three, again"), model("m3", T(6), "four, again")]);
  assert.deepEqual(conv.turns.map((t) => t.text), ["one", "two", "three, again", "four, again"]);
  const none = readRecords([...records, { $rewindTo: "no-such-id" }, user("u9", T(7), "fresh start")]);
  assert.deepEqual(none.turns.map((t) => t.text), ["fresh start"]);
});

test("lines that are not JSON, and records of no known kind, are skipped", () => {
  const w = world("gemini-junk");
  const p = w.project("junk");
  const root = makeGemini(w.gemini, [{ id: "99999999-0000-4000-8000-000000000001", project: p, started: T(0), updated: T(9), records: [user("u1", T(1), "survivor")] }]);
  const file = listSessions({ env: w.env, all: true })[0].source;
  fs.appendFileSync(file, "not json at all\n\n[1,2]\n{\"mystery\":true}\n" + JSON.stringify(model("m1", T(3), "still here")) + "\n");
  assert.ok(root);
  assert.deepEqual(readSession(listSessions({ env: w.env, all: true })[0]).turns.map((t) => t.text), ["survivor", "still here"]);
});

// --- reading: files recorded from Gemini CLI 0.64.0 --------------------------------------------------------

function recorded() {
  const w = world("gemini-recorded");
  const dir = path.join(w.gemini, ".gemini", "tmp", "webapp", "chats");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, "projects.json"), path.join(w.gemini, ".gemini", "projects.json"));
  fs.copyFileSync(path.join(FIXTURES, "session-read.jsonl"), path.join(dir, "session-2026-10-29T06-00-62c19e31.jsonl"));
  fs.copyFileSync(path.join(FIXTURES, "session-error.jsonl"), path.join(dir, "session-2026-10-29T06-01-0cf5e25b.jsonl"));
  return w;
}

test("a session recorded from Gemini CLI 0.64.0 lists for its project, under the name projects.json gives", () => {
  const w = recorded();
  const list = listSessions({ env: w.env, project: "C:\\work\\webapp" });
  assert.deepEqual(list.map((s) => s.id).sort(), ["0cf5e25b-3012-4dde-a86e-4c7308ea0f3c", "62c19e31-f546-4956-afb4-cef0ecdd38ec"]);
  assert.equal(list.find((s) => s.id.startsWith("62c19e31")).title, "Read notes.txt and tell me what it holds", "the session context is not the title");
  assert.equal(list[0].project, "c:\\work\\webapp");
  assert.deepEqual(listSessions({ env: w.env, project: "C:\\work\\other" }), []);
});

test("a session recorded from Gemini CLI 0.64.0 reads with its thought, its tool call, the tool's output and the resumed turn", () => {
  const conv = readSession(findSession("62c19e31", { env: recorded().env }));
  assert.equal(conv.model, "gemini-3.1-pro-preview");
  assert.deepEqual(conv.turns.map((t) => t.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(conv.turns[0].text, "Read notes.txt and tell me what it holds");
  const a = conv.turns[1];
  assert.equal(a.thinking, "**Reading notes** I should read the notes file first.", "the thought, once, though the message was written twice and patched");
  assert.equal(a.text, "TOOLDONE: the file has two lines, alpha and beta.");
  assert.equal(a.tools.length, 1);
  assert.equal(a.tools[0].name, "read_file");
  assert.deepEqual(a.tools[0].input, { file_path: "C:\\work\\webapp\\notes.txt" });
  assert.equal(a.tools[0].output, "alpha\nbeta\n");
  assert.equal(conv.turns[2].text, "Now add a line gamma");
  assert.equal(conv.turns[3].text, "PROBE-DONE");
});

test("a recorded failed tool call has the error as its output", () => {
  const conv = readSession(findSession("0cf5e25b", { env: recorded().env }));
  assert.equal(conv.turns[1].tools[0].name, "read_file");
  assert.equal(conv.turns[1].tools[0].output, "File not found: C:\\work\\webapp\\missing.txt");
});

test("the recorded session has the line kinds the reader applies: metadata, $set and $patch", () => {
  const lines = fs.readFileSync(path.join(FIXTURES, "session-read.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(lines[0]).sort(), ["kind", "lastUpdated", "projectHash", "sessionId", "startTime"], "no cwd, no project: the metadata names no folder");
  assert.ok(lines.some((l) => l.$set));
  assert.ok(lines.some((l) => l.$patch?.orderIds && l.$patch?.updates));
  assert.ok(lines.some((l) => l.type === "user" && l.content[0]?.functionResponse), "the tool's answer is recorded as a user message");
  assert.ok(!lines.some((l) => "$rewindTo" in l), "$rewindTo is in the source, not in this recording (see the test above that writes one by hand)");
});

// --- a /chat share export ---------------------------------------------------------------------------------

test("a /chat share export recorded from Gemini CLI 0.64.0 reads as a conversation", () => {
  const file = path.join(FIXTURES, "chat-share.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(detectJson(data), "gemini-share");
  const conv = readJsonFile(file);
  assert.equal(conv.tool, "gemini");
  assert.deepEqual(conv.turns.map((t) => t.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(conv.turns[0].text, "Read notes.txt and tell me what it holds", "the session context part is left out");
  assert.equal(conv.turns[1].tools.length, 1);
  assert.equal(conv.turns[1].tools[0].name, "read_file");
  assert.equal(conv.turns[1].tools[0].output, "alpha\nbeta\n", "the output is the following functionResponse (it is there three times in the recording)");
  assert.equal(conv.turns[1].text, "TOOLDONE: the file has two lines, alpha and beta.");
  assert.equal(conv.turns[2].text, "Now add a line gamma");
  assert.equal(conv.turns[3].text, "PROBE-DONE");
  assert.equal(listJsonFile(file).items.length, 1);
});

test("a /chat share export reads thoughts, errors and calls without an id", () => {
  const f = path.join(tmpDir(), "share.json");
  fs.writeFileSync(f, JSON.stringify([
    { role: "user", parts: [{ text: "go" }] },
    { role: "model", parts: [{ text: "planning", thought: true }, { text: "Running it." }, { functionCall: { name: "run_shell_command", args: { command: "false" } } }] },
    { role: "user", parts: [{ functionResponse: { name: "run_shell_command", response: { error: "exit 1" } } }] },
    { role: "model", parts: [{ text: "It failed." }] },
  ], null, 2));
  const conv = readJsonFile(f);
  assert.deepEqual(conv.turns.map((t) => t.text), ["go", "Running it.\n\nIt failed."]);
  assert.equal(conv.turns[1].thinking, "planning");
  assert.deepEqual(conv.turns[1].tools, [{ name: "run_shell_command", input: { command: "false" }, output: "exit 1" }]);
});

test("a list of messages with a role and content is still a plain list of messages, not a Gemini share", () => {
  assert.equal(detectJson([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]), "messages");
  assert.equal(detectJson([{ role: "user", parts: [{ text: "hi" }] }]), "", "only users: not recognised");
});

test("a made-up Gemini export with sessionId and generator is not read: Gemini CLI writes no such file", () => {
  const f = path.join(tmpDir(), "made-up.json");
  fs.writeFileSync(f, JSON.stringify({ generator: "gemini-cli", sessionId: "x", messages: [{ type: "user", content: "hi" }, { type: "gemini", content: "hello" }] }));
  assert.throws(() => readJsonFile(f), /is not a claude\.ai export/);
});
