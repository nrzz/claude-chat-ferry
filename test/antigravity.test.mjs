import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tmpDir, world } from "./helpers.mjs";
import { ANSWER, HISTORY, TOOL, USER, makeAntigravity, pbBytes, pbString, pbVarint, sampleConversations } from "./fake-antigravity.mjs";
import { antigravityDirs, findConversation, listConversations, protoFields, readConversation, readTitles, unwrapRequest } from "../src/antigravity.mjs";

const ID = { retry: "a4637e82-7a92-4895-8051-3ea8dd644802", repo: "c545ff0c-fb94-41b9-b564-1509a63bcacb" };

// A world with the two sample conversations. Tests that only read share one.
const shared = world("ag");
makeAntigravity(shared.antigravity, sampleConversations());

const logsOf = (dir, id) => path.join(dir, "brain", id, ".system_generated", "logs");
const ids = (list) => list.map((c) => c.id);
const roles = (conv) => conv.turns.map((t) => t.role);

// A conversation of its own in a fresh folder, listed and read back.
function converse(steps, extra = {}) {
  const w = world("ag-one");
  const id = extra.id || "0f0f0f0f-0000-4000-8000-000000000001";
  makeAntigravity(w.antigravity, [{ id, title: extra.title ?? "", steps, ...extra }], extra.options);
  const entry = listConversations({ env: w.env })[0];
  return { w, entry, conv: readConversation(entry) };
}

// --- listing ---------------------------------------------------------------------------------------------

test("listConversations lists every conversation, newest first, with when it started and was last active", () => {
  const list = listConversations({ env: shared.env });
  assert.deepEqual(ids(list), [ID.retry, ID.repo]);
  assert.equal(list[0].startedAt, "2026-09-30T10:00:00.000Z");
  assert.equal(list[0].updatedAt, "2026-09-30T10:03:00.000Z");
  assert.equal(list[1].startedAt, "2026-06-14T17:38:17.000Z");
  assert.equal(list[1].updatedAt, "2026-06-14T17:38:40.000Z");
});

test("listConversations takes a title from Antigravity's titles file", () => {
  assert.equal(listConversations({ env: shared.env })[0].title, "Retry loop in the client");
});

test("listConversations titles a conversation the titles file does not know by the first thing the person said", () => {
  assert.equal(listConversations({ env: shared.env })[1].title, "what does this repo do");
});

test("listConversations describes each conversation: tool, no project, and the transcript it came from", () => {
  const [first] = listConversations({ env: shared.env });
  assert.equal(first.tool, "antigravity");
  assert.equal(first.project, "", "Antigravity does not record a project folder");
  assert.equal(path.basename(first.source), "transcript_full.jsonl");
  assert.ok(fs.existsSync(first.source));
});

test("listConversations with a limit gives that many of the newest", () => {
  assert.deepEqual(ids(listConversations({ env: shared.env, limit: 1 })), [ID.retry]);
  assert.equal(listConversations({ env: shared.env, limit: 10 }).length, 2);
});

test("listConversations gives an empty list when the folder has no brain/ folder, or does not exist", () => {
  const empty = tmpDir();
  assert.deepEqual(listConversations({ env: { ...shared.env, ANTIGRAVITY_DIR: empty } }), []);
  assert.deepEqual(listConversations({ env: { ...shared.env, ANTIGRAVITY_DIR: path.join(empty, "never-made") } }), []);
  fs.mkdirSync(path.join(empty, "brain"));
  assert.deepEqual(listConversations({ env: { ...shared.env, ANTIGRAVITY_DIR: empty } }), [], "a brain/ folder with nothing in it");
});

test("listConversations lists the folders of an ANTIGRAVITY_DIR with several, newest first across all of them", () => {
  const a = world("ag-a");
  const b = world("ag-b");
  const [retry, repo] = sampleConversations();
  makeAntigravity(a.antigravity, [retry]);
  makeAntigravity(b.antigravity, [repo]);
  const env = { ...a.env, ANTIGRAVITY_DIR: [b.antigravity, a.antigravity].join(path.delimiter) };
  assert.deepEqual(ids(listConversations({ env })), [ID.retry, ID.repo]);
  assert.equal(listConversations({ env })[1].title, "what does this repo do", "each folder's own titles file is used");
  assert.deepEqual(ids(listConversations({ env: { ...a.env, ANTIGRAVITY_DIR: b.antigravity } })), [ID.repo], "one folder alone");
});

test("listConversations skips folders with no transcript, transcripts with nothing readable, and files in brain/", () => {
  const w = world("ag-skip");
  makeAntigravity(w.antigravity, [{ id: "11110000-0000-4000-8000-000000000001", title: "", steps: [USER("a real one", "2026-09-01T10:00:00Z")] }]);
  fs.mkdirSync(path.join(w.antigravity, "brain", "no-transcript"), { recursive: true });
  fs.mkdirSync(logsOf(w.antigravity, "all-garbage"), { recursive: true });
  fs.writeFileSync(path.join(logsOf(w.antigravity, "all-garbage"), "transcript.jsonl"), "not json\n\n{broken\n");
  fs.mkdirSync(logsOf(w.antigravity, "zero-bytes"), { recursive: true });
  fs.writeFileSync(path.join(logsOf(w.antigravity, "zero-bytes"), "transcript.jsonl"), "");
  fs.writeFileSync(path.join(w.antigravity, "brain", "stray-file.txt"), "not a conversation");
  assert.deepEqual(ids(listConversations({ env: w.env })), ["11110000-0000-4000-8000-000000000001"]);
});

test("listConversations skips the lines of a transcript that are not JSON", () => {
  const w = world("ag-garbage");
  const logs = logsOf(w.antigravity, "22220000-0000-4000-8000-000000000002");
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, "transcript.jsonl"), [JSON.stringify(USER("question", "2026-09-01T10:00:00Z")), "this line is not JSON", "", JSON.stringify(ANSWER("answer", "2026-09-01T10:01:00Z"))].join("\n"));
  const [entry] = listConversations({ env: w.env });
  assert.equal(entry.title, "question");
  assert.equal(entry.updatedAt, "2026-09-01T10:01:00.000Z");
  assert.deepEqual(readConversation(entry).turns.map((t) => t.text), ["question", "answer"]);
});

test("a transcript without times is dated by the file", () => {
  const w = world("ag-untimed");
  const logs = logsOf(w.antigravity, "33330000-0000-4000-8000-000000000003");
  fs.mkdirSync(logs, { recursive: true });
  const file = path.join(logs, "transcript.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({ source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>\nno times here\n</USER_REQUEST>" })}\n`);
  const when = new Date("2026-04-05T06:07:08Z");
  fs.utimesSync(file, when, when);
  const [entry] = listConversations({ env: w.env });
  assert.equal(entry.startedAt, "");
  assert.equal(entry.updatedAt, "2026-04-05T06:07:08.000Z");
});

test("a conversation's transcript_full.jsonl is used in preference to its transcript.jsonl", () => {
  const w = world("ag-full");
  const id = "44440000-0000-4000-8000-000000000004";
  makeAntigravity(w.antigravity, [{
    id, title: "",
    steps: [USER("short version", "2026-09-01T10:00:00Z"), ANSWER("short answer", "2026-09-01T10:00:30Z")],
    fullLines: [USER("full version", "2026-09-01T10:00:00Z"), ANSWER("full answer", "2026-09-01T10:00:30Z"), USER("and a follow-up only the full log has", "2026-09-01T10:05:00Z"), ANSWER("follow-up answer", "2026-09-01T10:06:00Z")],
  }]);
  const [entry] = listConversations({ env: w.env });
  assert.equal(path.basename(entry.source), "transcript_full.jsonl");
  assert.equal(entry.title, "full version");
  assert.equal(entry.updatedAt, "2026-09-01T10:06:00.000Z");
  assert.deepEqual(readConversation(entry).turns.map((t) => t.text), ["full version", "full answer", "and a follow-up only the full log has", "follow-up answer"]);
});

test("a conversation with only transcript.jsonl is read from that", () => {
  const { entry, conv } = converse([USER("only the short log", "2026-09-01T10:00:00Z"), ANSWER("short answer", "2026-09-01T10:00:30Z")], { options: { full: false } });
  assert.equal(path.basename(entry.source), "transcript.jsonl");
  assert.deepEqual(conv.turns.map((t) => t.text), ["only the short log", "short answer"]);
});

// --- reading ---------------------------------------------------------------------------------------------

test("readConversation unwraps the person's words from <USER_REQUEST> and keeps the turns alternating", () => {
  const conv = readConversation(findConversation(ID.retry, { env: shared.env }));
  assert.deepEqual(roles(conv), ["user", "assistant", "user", "assistant"]);
  assert.equal(conv.turns[0].text, "fix the retry loop in client.go");
  assert.equal(conv.turns[2].text, "thanks, also add a test");
  assert.ok(!JSON.stringify(conv).includes("USER_REQUEST"));
});

test("readConversation keeps the model's thinking", () => {
  const conv = readConversation(findConversation(ID.retry, { env: shared.env }));
  assert.equal(conv.turns[1].thinking, "Look at client.go before anything.");
  assert.equal(conv.turns[0].thinking, "");
});

test("readConversation turns a tool call on an answer into a tool with its arguments, and fills in the output from the step that ran it", () => {
  const conv = readConversation(findConversation(ID.retry, { env: shared.env }));
  const [run] = conv.turns[1].tools;
  assert.equal(run.name, "run_command");
  assert.deepEqual(run.input, { CommandLine: "go test ./...", Cwd: "/tmp/proj" });
  assert.equal(run.output, "ok  \tproj\t0.4s");
});

test("readConversation turns a tool step nobody announced into a tool of its own, with the output", () => {
  const conv = readConversation(findConversation(ID.retry, { env: shared.env }));
  assert.deepEqual(conv.turns[1].tools.map((t) => t.name), ["run_command", "view_file"]);
  assert.deepEqual(conv.turns[1].tools[1], { name: "view_file", input: {}, output: "package client\n\nfunc retry() {}\n" });
});

test("readConversation joins the answers around the tool steps into one turn of the assistant", () => {
  const conv = readConversation(findConversation(ID.retry, { env: shared.env }));
  assert.equal(conv.turns[1].text, "Running the tests first.\n\nThe loop never backs off. I added exponential backoff with a cap of 30 seconds.");
});

test("readConversation skips the CONVERSATION_HISTORY step, and the other bookkeeping steps, whatever they say", () => {
  const stamp = "2026-09-01T10:00:00Z";
  const { conv } = converse([
    USER("question", stamp),
    { ...HISTORY(stamp), content: "a long dump of the earlier conversation that must not appear" },
    { source: "SYSTEM", type: "CHECKPOINT", created_at: stamp, content: "checkpoint text that must not appear" },
    { source: "SYSTEM", type: "SUMMARY", created_at: stamp, content: "summary text that must not appear" },
    ANSWER("answer", stamp),
  ]);
  assert.deepEqual(conv.turns.map((t) => t.text), ["question", "answer"]);
  assert.ok(!JSON.stringify(conv).includes("must not appear"));
});

test("readConversation reads a conversation of three questions as user, assistant, user, assistant, user, assistant", () => {
  const { conv } = converse([
    USER("first question", "2026-08-01T10:00:00Z"),
    ANSWER("first answer", "2026-08-01T10:00:10Z"),
    USER("second question", "2026-08-01T10:01:00Z"),
    TOOL("RUN_COMMAND", "output two", "2026-08-01T10:01:05Z"),
    ANSWER("second answer", "2026-08-01T10:01:10Z"),
    USER("third question", "2026-08-01T10:02:00Z"),
    ANSWER("third answer", "2026-08-01T10:02:10Z"),
  ]);
  assert.deepEqual(roles(conv), ["user", "assistant", "user", "assistant", "user", "assistant"]);
  assert.deepEqual(conv.turns.map((t) => t.text), ["first question", "first answer", "second question", "second answer", "third question", "third answer"]);
  assert.deepEqual(conv.turns[3].tools, [{ name: "run_command", input: {}, output: "output two" }]);
});

test("readConversation gives each turn its time, and the conversation its title and start and end", () => {
  const conv = readConversation(findConversation(ID.retry, { env: shared.env }));
  assert.deepEqual(conv.turns.map((t) => t.at), ["2026-09-30T10:00:00.000Z", "2026-09-30T10:00:05.000Z", "2026-09-30T10:02:00.000Z", "2026-09-30T10:03:00.000Z"]);
  assert.equal(conv.tool, "antigravity");
  assert.equal(conv.id, ID.retry);
  assert.equal(conv.title, "Retry loop in the client");
  assert.equal(conv.startedAt, "2026-09-30T10:00:00.000Z");
  assert.equal(conv.endedAt, "2026-09-30T10:03:00.000Z");
  assert.equal(conv.project, "");
  assert.equal(path.basename(conv.source), "transcript_full.jsonl");
});

test("readConversation titles a conversation with no title in the titles file by its first question", () => {
  const conv = readConversation(findConversation(ID.repo, { env: shared.env }));
  assert.equal(conv.title, "what does this repo do");
  assert.deepEqual(roles(conv), ["user", "assistant"]);
});

test("readConversation pairs each announced call with the next step of its kind, in order", () => {
  const stamp = "2026-09-01T10:00:00Z";
  const { conv } = converse([
    USER("run two things", stamp),
    ANSWER("running both", stamp, { tool_calls: [{ name: "run_command", args: { CommandLine: "first" } }, { name: "run_command", args: { CommandLine: "second" } }] }),
    TOOL("RUN_COMMAND", "first output", stamp),
    TOOL("RUN_COMMAND", "second output", stamp),
  ]);
  assert.deepEqual(conv.turns[1].tools.map((t) => [t.input.CommandLine, t.output]), [["first", "first output"], ["second", "second output"]]);
});

test("readConversation keeps a tool step's own call arguments, and reads the arguments key too", () => {
  const stamp = "2026-09-01T10:00:00Z";
  const { conv } = converse([
    USER("search", stamp),
    { ...TOOL("GREP_SEARCH", "3 matches", stamp), tool_calls: [{ name: "grep", args: { Query: "retry" } }] },
    ANSWER("looking at the old key", stamp, { tool_calls: [{ name: "view_outline", arguments: { File: "a.go" } }] }),
  ]);
  assert.deepEqual(conv.turns[1].tools, [{ name: "grep_search", input: { Query: "retry" }, output: "3 matches" }, { name: "view_outline", input: { File: "a.go" }, output: "" }]);
});

test("readConversation starts an assistant turn for a tool step that comes before any answer", () => {
  const { conv } = converse([USER("go", "2026-09-01T10:00:00Z"), TOOL("LIST_DIRECTORY", "a.go\nb.go", "2026-09-01T10:00:01Z")]);
  assert.deepEqual(roles(conv), ["user", "assistant"]);
  assert.deepEqual(conv.turns[1].tools, [{ name: "list_directory", input: {}, output: "a.go\nb.go" }]);
});

test("readConversation keeps an answer that only announces tool calls", () => {
  const { conv } = converse([USER("go", "2026-09-01T10:00:00Z"), ANSWER("", "2026-09-01T10:00:01Z", { tool_calls: [{ name: "run_command", args: { CommandLine: "ls" } }] })]);
  assert.deepEqual(roles(conv), ["user", "assistant"]);
  assert.equal(conv.turns[1].tools[0].name, "run_command");
});

test("unwrapRequest takes the person's words out of their <USER_REQUEST> wrapper", () => {
  assert.equal(unwrapRequest("<USER_REQUEST>\nfix it\n</USER_REQUEST>"), "fix it");
  assert.equal(unwrapRequest("  <user_request>  fix it  </user_request>  "), "fix it", "any case, any spacing");
  assert.equal(unwrapRequest("<USER_REQUEST>\nline one\n\nline two\n</USER_REQUEST>"), "line one\n\nline two");
  assert.equal(unwrapRequest("  no wrapper  "), "no wrapper");
  assert.equal(unwrapRequest("<USER_REQUEST>\nunclosed"), "unclosed");
  assert.equal(unwrapRequest(null), "");
  assert.equal(unwrapRequest(undefined), "");
});

// --- finding one conversation --------------------------------------------------------------------------------

test("findConversation(\"latest\") is the newest conversation", () => {
  assert.equal(findConversation("latest", { env: shared.env }).id, ID.retry);
});

test("findConversation finds a conversation by the start of its id, in any case", () => {
  assert.equal(findConversation("c545ff0c", { env: shared.env }).id, ID.repo);
  assert.equal(findConversation("C545FF0C-FB94", { env: shared.env }).id, ID.repo);
  assert.equal(findConversation(ID.retry, { env: shared.env }).title, "Retry loop in the client");
});

test("findConversation finds nothing for an id nobody starts with, or when there are no conversations", () => {
  assert.equal(findConversation("deadbeef", { env: shared.env }), null);
  const none = world("ag-none");
  assert.equal(findConversation("latest", { env: none.env }), null);
  assert.equal(findConversation("c545", { env: none.env }), null);
});

test("findConversation refuses an id start that fits two conversations, and says to give more of the id", () => {
  const w = world("ag-ambiguous");
  makeAntigravity(w.antigravity, [
    { id: "aaaa0001-0000-4000-8000-000000000001", title: "One", steps: [USER("one", "2026-09-01T10:00:00Z")] },
    { id: "aaaa0002-0000-4000-8000-000000000002", title: "Two", steps: [USER("two", "2026-09-02T10:00:00Z")] },
  ]);
  assert.throws(() => findConversation("aaaa", { env: w.env }), /"aaaa" matches 2 conversations; give more of the id/);
  assert.equal(findConversation("aaaa0002", { env: w.env }).title, "Two");
});

test("findConversation takes a whole id even when it is also the start of another id", () => {
  const w = world("ag-prefix");
  makeAntigravity(w.antigravity, [
    { id: "abc", title: "Short id", steps: [USER("short", "2026-09-01T10:00:00Z")] },
    { id: "abcdef", title: "Long id", steps: [USER("long", "2026-09-02T10:00:00Z")] },
  ]);
  assert.equal(findConversation("abc", { env: w.env }).title, "Short id");
  assert.equal(findConversation("abcd", { env: w.env }).title, "Long id");
});

// --- where Antigravity keeps things ---------------------------------------------------------------------------

test("antigravityDirs defaults to the desktop app's, the editor's and the command-line agent's folders under ~/.gemini", () => {
  const home = path.join(tmpDir(), "home");
  const other = path.join(tmpDir(), "other");
  const expected = ["antigravity", "antigravity-ide", "antigravity-cli"].map((d) => path.join(home, ".gemini", d));
  assert.deepEqual(antigravityDirs({ HOME: home }, "linux"), expected);
  assert.deepEqual(antigravityDirs({ HOME: home }, "darwin"), expected);
  assert.deepEqual(antigravityDirs({ USERPROFILE: home }, "win32"), expected);
  assert.deepEqual(antigravityDirs({ USERPROFILE: home, HOME: other }, "win32"), expected, "Windows looks at USERPROFILE first");
  assert.deepEqual(antigravityDirs({ HOME: home, USERPROFILE: other }, "linux"), expected, "everywhere else at HOME");
  assert.deepEqual(antigravityDirs({ HOME: home }, "win32"), expected, "Windows falls back to HOME");
});

test("antigravityDirs falls back to the home folder the system names when the environment has none", () => {
  assert.equal(antigravityDirs({}, process.platform)[0], path.join(os.homedir(), ".gemini", "antigravity"));
});

test("antigravityDirs takes ANTIGRAVITY_DIR instead, one folder or several split at the system's path separator", () => {
  const a = path.join(tmpDir(), "a");
  const b = path.join(tmpDir(), "b");
  assert.deepEqual(antigravityDirs({ ANTIGRAVITY_DIR: a, HOME: "/ignored" }, "linux"), [a]);
  assert.deepEqual(antigravityDirs({ ANTIGRAVITY_DIR: [a, b].join(path.delimiter) }, "linux"), [a, b]);
  assert.deepEqual(antigravityDirs({ ANTIGRAVITY_DIR: [a, "", b, ""].join(path.delimiter) }, "win32"), [a, b], "empty entries are ignored");
});

test("antigravityDirs makes every folder of ANTIGRAVITY_DIR absolute", () => {
  assert.deepEqual(antigravityDirs({ ANTIGRAVITY_DIR: ["rel-one", "rel-two"].join(path.delimiter) }), [path.resolve("rel-one"), path.resolve("rel-two")]);
});

// --- the titles file -------------------------------------------------------------------------------------------

const summary = (id, title) => pbBytes(1, Buffer.concat([pbString(1, id), pbBytes(2, pbString(1, title))]));
const showFields = (fields) => fields.map((f) => (f.bytes ? { ...f, bytes: f.bytes.toString("utf8") } : f));

test("readTitles decodes the titles file: one entry per conversation, with its id and title", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "agyhub_summaries_proto.pb"), Buffer.concat([summary("id-1", "First title"), summary("id-2", "Café 日本語 \u{1F600}")]));
  const titles = readTitles(dir);
  assert.ok(titles instanceof Map);
  assert.deepEqual([...titles], [["id-1", "First title"], ["id-2", "Café 日本語 \u{1F600}"]]);
});

test("readTitles reads the titles of the sample conversations", () => {
  assert.deepEqual([...readTitles(shared.antigravity)], [[ID.retry, "Retry loop in the client"]]);
});

test("readTitles trims a title, and skips entries with no id or no title, and fields it does not know", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "agyhub_summaries_proto.pb"), Buffer.concat([
    summary("id-1", "  Padded title \n"),
    summary("id-2", ""),
    pbBytes(1, pbBytes(2, pbString(1, "a title with no id"))),
    pbString(7, "an unknown field at the top"),
    pbVarint(3, 99),
    summary("id-3", "Kept"),
  ]));
  assert.deepEqual([...readTitles(dir)], [["id-1", "Padded title"], ["id-3", "Kept"]]);
});

test("readTitles skips a title that is not valid text", () => {
  const dir = tmpDir();
  const broken = pbBytes(1, Buffer.concat([pbString(1, "id-bad"), pbBytes(2, pbBytes(1, Buffer.from([0xff, 0xfe, 0x41])))]));
  fs.writeFileSync(path.join(dir, "agyhub_summaries_proto.pb"), Buffer.concat([broken, summary("id-ok", "Fine")]));
  assert.deepEqual([...readTitles(dir)], [["id-ok", "Fine"]]);
});

test("readTitles gives no titles, without an error, for a missing file or one in another layout", () => {
  const dir = tmpDir();
  assert.equal(readTitles(dir).size, 0);
  fs.writeFileSync(path.join(dir, "agyhub_summaries_proto.pb"), "this is plain text, not a protobuf file at all");
  assert.equal(readTitles(dir).size, 0);
});

// --- the protobuf reader ---------------------------------------------------------------------------------------

test("protoFields reads varints and length-delimited fields, and steps over fixed-size ones", () => {
  const fixed64 = Buffer.concat([Buffer.from([(2 << 3) | 1]), Buffer.alloc(8, 0xff)]);
  const fixed32 = Buffer.concat([Buffer.from([(3 << 3) | 5]), Buffer.alloc(4, 0xff)]);
  const bytes = Buffer.concat([pbVarint(1, 150), fixed64, fixed32, pbString(4, "testing"), pbVarint(5, 1)]);
  assert.deepEqual(showFields(protoFields(bytes)), [
    { field: 1, wt: 0, value: 150 },
    { field: 2, wt: 1 },
    { field: 3, wt: 5 },
    { field: 4, wt: 2, bytes: "testing" },
    { field: 5, wt: 0, value: 1 },
  ]);
});

test("protoFields reads multi-byte varints, field numbers above 15 and values past 32 bits", () => {
  assert.deepEqual(showFields(protoFields(pbVarint(1, 300))), [{ field: 1, wt: 0, value: 300 }]);
  assert.deepEqual(showFields(protoFields(pbVarint(16, 1))), [{ field: 16, wt: 0, value: 1 }]);
  assert.deepEqual(showFields(protoFields(pbVarint(1000, 7))), [{ field: 1000, wt: 0, value: 7 }]);
  assert.deepEqual(showFields(protoFields(pbVarint(1, 2 ** 35))), [{ field: 1, wt: 0, value: 2 ** 35 }]);
  assert.deepEqual(showFields(protoFields(pbString(1, ""))), [{ field: 1, wt: 2, bytes: "" }], "an empty string");
});

test("protoFields reads a message inside a message", () => {
  const [outer] = protoFields(pbBytes(1, Buffer.concat([pbString(1, "inner id"), pbVarint(2, 4)])));
  assert.deepEqual(showFields(protoFields(outer.bytes)), [{ field: 1, wt: 2, bytes: "inner id" }, { field: 2, wt: 0, value: 4 }]);
});

test("protoFields of no bytes is no fields", () => {
  assert.deepEqual(protoFields(Buffer.alloc(0)), []);
});

test("protoFields throws on a wire type it does not know", () => {
  for (const wt of [3, 4, 6, 7]) assert.throws(() => protoFields(Buffer.from([(1 << 3) | wt])), new RegExp(`wire type ${wt}`));
});

test("protoFields throws on bytes that end in the middle of a field", () => {
  assert.throws(() => protoFields(Buffer.from([0x0a, 0x05, 0x61, 0x62])), /truncated/, "a string that is cut short");
  assert.throws(() => protoFields(Buffer.from([0x08, 0x80])), /truncated/, "a varint that never ends");
  assert.throws(() => protoFields(Buffer.from([0x80])), /truncated/, "a field number that never ends");
});
