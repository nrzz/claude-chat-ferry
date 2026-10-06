import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { JSON_FORMAT, detectJson, fromJson, listJsonFile, loadJsonFile, readJsonFile, titleFromData, toJson } from "../src/exports.mjs";
import { conversation, finish, turn } from "../src/model.mjs";

const dir = tmpDir("ferry-exports-");
function write(name, data) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  return file;
}
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const roles = (conv) => conv.turns.map((t) => t.role);
const texts = (conv) => conv.turns.map((t) => t.text);
const messageOf = (fn) => { try { fn(); } catch (e) { return e.message; } return assert.fail("expected an error"); };

// --- a claude.ai export: two conversations, the newer one second in the file ----------------------------

const CLAUDE_AI = [
  {
    uuid: "c1a2b3c4-1111-4111-8111-000000000001", name: "Debug the login flow", created_at: "2026-05-01T09:00:00.000000Z", updated_at: "2026-05-01T09:30:00.000000Z",
    account: { uuid: "acct-1" },
    chat_messages: [
      {
        uuid: "m-1", sender: "human", created_at: "2026-05-01T09:00:00.000000Z", text: "Why does login fail after the session expires?",
        content: [{ type: "text", text: "Why does login fail after the session expires?" }],
        attachments: [{ file_name: "login.log", file_size: 120, file_type: "text/plain", extracted_content: "401 Unauthorized" }], files: [],
      },
      {
        uuid: "m-2", sender: "assistant", created_at: "2026-05-01T09:00:20.000000Z", text: "The access token expires after 15 minutes.",
        content: [
          { type: "text", text: "Let me check the token lifetime." },
          { type: "tool_use", id: "toolu_01", name: "web_search", input: { query: "jwt refresh token expiry" } },
          { type: "tool_result", name: "web_search", tool_use_id: "toolu_01", content: [{ type: "text", text: "Refresh tokens usually outlive access tokens." }] },
          { type: "text", text: "The access token expires after 15 minutes." },
        ],
        attachments: [], files: [],
      },
      { uuid: "m-3", sender: "human", created_at: "2026-05-01T09:29:00.000000Z", text: "Thanks, that fixed it", content: [{ type: "text", text: "Thanks, that fixed it" }], attachments: [], files: [] },
      { uuid: "m-4", sender: "assistant", created_at: "2026-05-01T09:30:00.000000Z", text: "Glad to hear it.", content: [{ type: "text", text: "Glad to hear it." }], attachments: [], files: [] },
    ],
  },
  {
    uuid: "d9e8f7a6-2222-4222-8222-000000000002", name: "", created_at: "2026-06-02T12:00:00.000000Z", updated_at: "2026-06-02T12:05:00.000000Z",
    chat_messages: [
      { uuid: "m-5", sender: "human", created_at: "2026-06-02T12:00:00.000000Z", text: "Plain text only message", attachments: [], files: [] },
      { uuid: "m-6", sender: "assistant", created_at: "2026-06-02T12:05:00.000000Z", text: "Old export with no content blocks", attachments: [], files: [] },
    ],
  },
];

// --- a ChatGPT export: a tree of messages per conversation --------------------------------------------

const msg = (id, role, parts, extra = {}) => ({
  id, author: { role, ...(extra.name ? { name: extra.name } : {}) }, create_time: extra.time ?? null,
  content: extra.content ?? { content_type: "text", parts }, metadata: extra.metadata ?? {}, recipient: "all",
});
const node = (id, parent, children, message = null) => ({ id, parent, children, message });

const CHATGPT = [
  {
    // current_node names the end of the branch the person last saw. u1 was answered twice: a1 was regenerated into a1b.
    // The first answer went on for several more messages, so the dropped branch is the longer one: only current_node
    // says which of the two the person kept.
    id: "a1111111-0000-4000-8000-000000000001", title: "Sorting algorithms", create_time: 1789000000.25, update_time: 1789000900.5, current_node: "a3", default_model_slug: "gpt-4o",
    mapping: {
      root: node("root", null, ["sys"]),
      sys: node("sys", "root", ["ctx"], msg("sys", "system", [""], { time: 1789000000 })),
      ctx: node("ctx", "sys", ["u1"], msg("ctx", "user", ["hidden context the person never saw"], { metadata: { is_visually_hidden_from_conversation: true } })),
      u1: node("u1", "ctx", ["a1", "a1b"], msg("u1", "user", ["Explain quicksort"], { time: 1789000010 })),
      a1: node("a1", "u1", ["d1"], msg("a1", "assistant", ["First answer, regenerated and not kept"], { time: 1789000020 })),
      d1: node("d1", "a1", ["d2"], msg("d1", "user", ["A follow-up in the dropped branch"], { time: 1789000021 })),
      d2: node("d2", "d1", ["d3"], msg("d2", "assistant", ["A reply in the dropped branch"], { time: 1789000022 })),
      d3: node("d3", "d2", ["d4"], msg("d3", "user", ["Another follow-up in the dropped branch"], { time: 1789000023 })),
      d4: node("d4", "d3", ["d5"], msg("d4", "assistant", ["Another reply in the dropped branch"], { time: 1789000024 })),
      d5: node("d5", "d4", ["d6"], msg("d5", "user", ["Yet another follow-up in the dropped branch"], { time: 1789000025 })),
      d6: node("d6", "d5", [], msg("d6", "assistant", ["The end of the dropped branch"], { time: 1789000026 })),
      a1b: node("a1b", "u1", ["u2"], msg("a1b", "assistant", ["Second answer, the one kept"], { time: 1789000030 })),
      u2: node("u2", "a1b", ["t1"], msg("u2", "user", ["Show code"], { time: 1789000040 })),
      t1: node("t1", "u2", ["a2"], msg("t1", "tool", ["[1, 2, 3]"], { name: "python", time: 1789000050 })),
      a2: node("a2", "t1", ["a3"], msg("a2", "assistant", [], { content: { content_type: "code", language: "python", text: "def qs(xs):\n    return sorted(xs)" }, time: 1789000060 })),
      a3: node("a3", "a2", [], msg("a3", "assistant", ["That is the whole function."], { time: 1789000070 })),
    },
  },
  {
    // no current_node and no model name: the longest chain from the root is the conversation; the model comes from a message
    conversation_id: "b2222222-0000-4000-8000-000000000002", title: "Recipe ideas", create_time: 1789100000, update_time: 1789100500,
    mapping: {
      root: node("root", null, ["u1"]),
      u1: node("u1", "root", ["a1", "a1b"], msg("u1", "user", ["Which pasta tonight?"], { time: 1789100010 })),
      a1: node("a1", "u1", [], msg("a1", "assistant", ["Short branch"], { time: 1789100020 })),
      a1b: node("a1b", "u1", ["u2"], msg("a1b", "assistant", ["Carbonara, if you have eggs."], { time: 1789100030, metadata: { model_slug: "gpt-4o-mini" } })),
      u2: node("u2", "a1b", ["a2"], msg("u2", "user", ["And a vegetarian one?"], { time: 1789100040 })),
      a2: node("a2", "u2", [], msg("a2", "assistant", ["Cacio e pepe."], { time: 1789100050 })),
    },
  },
];

// --- plain lists of messages ----------------------------------------------------------------------------

const MESSAGES = [
  { role: "user", content: "Plain string message" },
  { role: "assistant", content: [{ type: "text", text: "Reading the file." }, { type: "tool_use", id: "toolu_a", name: "read_file", input: { path: "notes.txt" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "file contents here" }] },
  { role: "assistant", content: [{ type: "thinking", thinking: "A short file." }, { type: "text", text: "It says hello." }] },
  { role: "system", content: "a system prompt that is not part of the chat" },
  { role: "user", content: [{ type: "text", text: "Thanks" }, { type: "image", source: {} }] },
];
const OPENAI = {
  title: "OpenAI style", model: "gpt-4o",
  messages: [
    { role: "system", content: "You are helpful" },
    { role: "user", content: "What is the weather?" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "18C and sunny" },
    { role: "assistant", content: "It is 18C and sunny in Paris." },
  ],
};

// --- this tool's own JSON ---------------------------------------------------------------------------------

function ferryConversation(title = "Fix the carousel on mobile", at = "2026-07-12T09:14:00.000Z") {
  return finish(conversation({
    tool: "cursor", id: "11111111-aaaa-4aaa-8aaa-111111111111", title, project: "D:\\Projects\\webapp", model: "fake-model-1", startedAt: at, endedAt: "2026-07-12T10:00:00.000Z", source: "composerData:1111",
    turns: [
      turn("user", { at, text: "The carousel arrows do not advance on mobile." }),
      turn("assistant", { at: "2026-07-12T09:15:00.000Z", text: "The touch handler calls preventDefault.", thinking: "Probably the touch handler.", tools: [{ name: "read_file_v2", input: { relativeWorkspacePath: "src/Gallery.tsx" }, output: "export const Gallery = () => null;" }] }),
    ],
  }));
}

const files = {
  claudeAi: write("claude-ai.json", CLAUDE_AI),
  chatgpt: write("chatgpt.json", CHATGPT),
  messages: write("messages.json", MESSAGES),
  openai: write("openai.json", OPENAI),
  ferry: write("ferry.json", toJson(ferryConversation())),
  ferryMany: write("ferry-many.json", [JSON.parse(toJson(ferryConversation("Older chat", "2026-01-01T10:00:00.000Z"))), JSON.parse(toJson(ferryConversation("Newer chat", "2026-07-12T09:14:00.000Z")))]),
  unknown: write("unknown.json", { hello: "world" }),
};

// --- telling the formats apart -----------------------------------------------------------------------------

test("detectJson tells a claude.ai export, a ChatGPT export, a list of messages and this tool's JSON apart", () => {
  assert.equal(detectJson(CLAUDE_AI), "claude-ai");
  assert.equal(detectJson(CLAUDE_AI[0]), "claude-ai", "one conversation on its own");
  assert.equal(detectJson(CHATGPT), "chatgpt");
  assert.equal(detectJson(CHATGPT[0]), "chatgpt");
  assert.equal(detectJson(MESSAGES), "messages");
  assert.equal(detectJson(OPENAI), "messages", "an object holding a messages list");
  assert.equal(detectJson({ format: JSON_FORMAT, turns: [] }), "ferry");
  assert.equal(detectJson([{ tool: "cursor", turns: [] }]), "ferry");
  assert.equal(JSON_FORMAT, "claude-chat-ferry/1");
});

test("detectJson gives an empty string for JSON it does not know", () => {
  for (const junk of [null, undefined, 42, "text", true, [], {}, [1, 2], [null], [{}], [{ hello: "world" }], { turns: [] }, { messages: [] }, { messages: [1] }, [{ role: "user" }]]) {
    assert.equal(detectJson(junk), "", JSON.stringify(junk));
  }
});

test("loadJsonFile reads JSON, ignoring a byte-order mark, and says what is wrong with a file it cannot use", () => {
  assert.deepEqual(loadJsonFile(write("bom.json", "\ufeff{\"a\":1}")), { a: 1 });
  assert.throws(() => loadJsonFile(write("bad.json", "{nope")), /bad\.json is not JSON/);
  assert.throws(() => loadJsonFile(path.join(dir, "missing.json")), /cannot read .*missing\.json/);
});

// --- listing -------------------------------------------------------------------------------------------------

test("listJsonFile lists a claude.ai export newest first, with each conversation's place in the file", () => {
  const { kind, items } = listJsonFile(files.claudeAi);
  assert.equal(kind, "claude-ai");
  assert.deepEqual(items, [
    { index: 1, tool: "claude-ai", id: "d9e8f7a6-2222-4222-8222-000000000002", title: "(untitled)", startedAt: "2026-06-02T12:00:00.000Z", updatedAt: "2026-06-02T12:05:00.000Z", messages: 2 },
    { index: 0, tool: "claude-ai", id: "c1a2b3c4-1111-4111-8111-000000000001", title: "Debug the login flow", startedAt: "2026-05-01T09:00:00.000Z", updatedAt: "2026-05-01T09:30:00.000Z", messages: 4 },
  ]);
});

test("listJsonFile lists a ChatGPT export newest first, counting the messages people and the assistant wrote", () => {
  const { kind, items } = listJsonFile(files.chatgpt);
  assert.equal(kind, "chatgpt");
  assert.deepEqual(items.map((i) => i.index), [1, 0]);
  assert.deepEqual(items.map((i) => i.title), ["Recipe ideas", "Sorting algorithms"]);
  assert.deepEqual(items.map((i) => i.id), ["b2222222-0000-4000-8000-000000000002", "a1111111-0000-4000-8000-000000000001"], "the id is conversation_id when there is no id");
  assert.deepEqual(items.map((i) => i.tool), ["chatgpt", "chatgpt"]);
  assert.equal(items[1].startedAt, iso(1789000000.25));
  assert.equal(items[1].updatedAt, iso(1789000900.5));
  // user and assistant messages anywhere in the tree: the system, tool and root nodes are not counted
  assert.equal(items[0].messages, 5);
  assert.equal(items[1].messages, 13);
});

test("listJsonFile lists a file of this tool's own JSON, one conversation or many", () => {
  const one = listJsonFile(files.ferry);
  assert.equal(one.kind, "ferry");
  assert.deepEqual(one.items, [{ index: 0, tool: "cursor", id: "11111111-aaaa-4aaa-8aaa-111111111111", title: "Fix the carousel on mobile", startedAt: "2026-07-12T09:14:00.000Z", updatedAt: "2026-07-12T10:00:00.000Z", messages: 2 }]);
  const many = listJsonFile(files.ferryMany);
  assert.deepEqual(many.items.map((i) => i.title), ["Older chat", "Newer chat"], "both end at the same time, so the file order stands");
  assert.deepEqual(many.items.map((i) => i.index), [0, 1]);
});

test("listJsonFile calls a list of messages one conversation, titled by the first thing the person said", () => {
  const { kind, items } = listJsonFile(files.messages);
  assert.equal(kind, "messages");
  assert.equal(items.length, 1);
  assert.equal(items[0].index, 0);
  assert.equal(items[0].tool, "json");
  assert.equal(items[0].title, "Plain string message");
  assert.equal(items[0].messages, MESSAGES.length);
});

test("listJsonFile titles a list of messages by the first line of what the person said, even when it is in content blocks", () => {
  const file = write("blocks.json", [{ role: "user", content: [{ type: "text", text: "Hello from a block" }] }, { role: "assistant", content: "Hi" }]);
  assert.equal(listJsonFile(file).items[0].title, "Hello from a block");
});

test("listJsonFile gives a list of messages the title the file itself carries, as readJsonFile does", () => {
  const { items } = listJsonFile(files.openai);
  assert.equal(items[0].title, readJsonFile(files.openai).title);
  assert.equal(items[0].title, "OpenAI style");
});

test("listJsonFile says what it accepts when the file is none of them", () => {
  for (const [name, data] of [["unknown.json", { hello: "world" }], ["numbers.json", [1, 2, 3]], ["empty.json", []], ["null.json", null], ["text.json", "\"just a JSON string\""]]) {
    const message = messageOf(() => listJsonFile(write(name, data)));
    assert.match(message, new RegExp(`^${name.replace(".", "\\.")} is not a claude\\.ai export, a ChatGPT export, a list of messages or claude-chat-ferry JSON$`), name);
  }
});

test("readJsonFile says the same about a file it does not know, whatever --pick says", () => {
  const accepted = "is not a claude.ai export, a ChatGPT export, a list of messages or claude-chat-ferry JSON";
  assert.equal(messageOf(() => readJsonFile(files.unknown)), `unknown.json ${accepted}`);
  assert.equal(messageOf(() => readJsonFile(files.unknown, "1")), `unknown.json ${accepted}`);
});

// --- picking one conversation of a file -----------------------------------------------------------------------

test("readJsonFile picks a conversation by its number in the file", () => {
  assert.equal(readJsonFile(files.claudeAi, "1").title, "Debug the login flow");
  assert.equal(readJsonFile(files.claudeAi, "2").id, "d9e8f7a6-2222-4222-8222-000000000002");
  assert.equal(readJsonFile(files.claudeAi, "  2 ").id, "d9e8f7a6-2222-4222-8222-000000000002", "spaces around the number do not matter");
  assert.equal(readJsonFile(files.chatgpt, "2").title, "Recipe ideas");
  assert.equal(readJsonFile(files.ferryMany, "1").title, "Older chat");
});

test("readJsonFile picks a conversation by its id or the start of its id, in any case", () => {
  assert.equal(readJsonFile(files.claudeAi, "c1a2b3c4").title, "Debug the login flow");
  assert.equal(readJsonFile(files.claudeAi, "C1A2B3C4-1111").title, "Debug the login flow");
  assert.equal(readJsonFile(files.claudeAi, "d9e8f7a6-2222-4222-8222-000000000002").id, "d9e8f7a6-2222-4222-8222-000000000002");
  assert.equal(readJsonFile(files.chatgpt, "b2222222").title, "Recipe ideas");
  assert.equal(readJsonFile(files.chatgpt, "a1111111").title, "Sorting algorithms");
});

test("readJsonFile picks a conversation by words of its title, in any case", () => {
  assert.equal(readJsonFile(files.claudeAi, "login").id, "c1a2b3c4-1111-4111-8111-000000000001");
  assert.equal(readJsonFile(files.claudeAi, "LOGIN FLOW").id, "c1a2b3c4-1111-4111-8111-000000000001");
  assert.equal(readJsonFile(files.chatgpt, "sorting algo").title, "Sorting algorithms");
  assert.equal(readJsonFile(files.ferryMany, "newer").title, "Newer chat");
});

test("readJsonFile picks the newest conversation for \"latest\"", () => {
  assert.equal(readJsonFile(files.claudeAi, "latest").id, "d9e8f7a6-2222-4222-8222-000000000002", "the second in the file is the newer");
  assert.equal(readJsonFile(files.chatgpt, "latest").title, "Recipe ideas");
});

test("readJsonFile asks for --pick when the file holds several conversations and none was named", () => {
  assert.match(messageOf(() => readJsonFile(files.claudeAi)), /^claude-ai\.json holds 2 conversations: add --pick /);
  assert.match(messageOf(() => readJsonFile(files.chatgpt, "")), /holds 2 conversations: add --pick/);
  assert.match(messageOf(() => readJsonFile(files.ferryMany, undefined)), /holds 2 conversations: add --pick/);
});

test("readJsonFile needs no pick for a file that holds one conversation", () => {
  assert.equal(readJsonFile(files.ferry).title, "Fix the carousel on mobile");
  assert.equal(readJsonFile(write("one-claude.json", CLAUDE_AI[0])).title, "Debug the login flow", "a single conversation object, not a list");
  assert.equal(readJsonFile(write("one-chatgpt.json", [CHATGPT[0]])).title, "Sorting algorithms", "a list of one");
  assert.equal(readJsonFile(write("one-claude-latest.json", [CLAUDE_AI[0]]), "latest").title, "Debug the login flow");
  assert.equal(readJsonFile(write("one-claude-number.json", [CLAUDE_AI[0]]), "1").title, "Debug the login flow");
});

test("readJsonFile says so when nothing matches the pick", () => {
  assert.equal(messageOf(() => readJsonFile(files.claudeAi, "zzz")), "no conversation in claude-ai.json matches \"zzz\"");
  assert.equal(messageOf(() => readJsonFile(files.claudeAi, "99")), "no conversation in claude-ai.json matches \"99\"", "a number past the end of the file");
  assert.match(messageOf(() => readJsonFile(files.ferry, "nonsense")), /no conversation in ferry\.json matches "nonsense"/);
});

test("readJsonFile lists the candidates when the pick matches more than one conversation", () => {
  const file = write("two-logins.json", [
    { uuid: "abc12345-1111-4111-8111-000000000001", name: "Login bug in the app", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:10:00Z", chat_messages: [{ sender: "human", text: "one" }] },
    { uuid: "abc12345-2222-4222-8222-000000000002", name: "Login page design", created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-01T00:10:00Z", chat_messages: [{ sender: "human", text: "two" }] },
  ]);
  const byWords = messageOf(() => readJsonFile(file, "login"));
  assert.match(byWords, /^"login" matches 2 conversations in two-logins\.json: /);
  assert.ok(byWords.includes("1 Login bug in the app") && byWords.includes("2 Login page design"), byWords);
  const byId = messageOf(() => readJsonFile(file, "abc123"));
  assert.match(byId, /^"abc123" matches 2 conversations in two-logins\.json: /);
  assert.equal(readJsonFile(file, "abc12345-2222").title, "Login page design", "more of the id settles it");
  assert.equal(readJsonFile(file, "bug").title, "Login bug in the app", "so do more specific words");
});

test("readJsonFile prefers an id to title words when both could match", () => {
  const file = write("id-or-title.json", [
    { uuid: "feedbeef-1111-4111-8111-000000000001", name: "Something else", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:10:00Z", chat_messages: [{ sender: "human", text: "one" }] },
    { uuid: "11111111-2222-4222-8222-000000000002", name: "About feedbeef the cat", created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-01T00:10:00Z", chat_messages: [{ sender: "human", text: "two" }] },
  ]);
  assert.equal(readJsonFile(file, "feedbeef").title, "Something else");
});

// --- reading a claude.ai conversation --------------------------------------------------------------------------

test("a claude.ai conversation reads with its title, id, times and who said what", () => {
  const conv = readJsonFile(files.claudeAi, "1");
  assert.equal(conv.tool, "claude-ai");
  assert.equal(conv.id, "c1a2b3c4-1111-4111-8111-000000000001");
  assert.equal(conv.title, "Debug the login flow");
  assert.equal(conv.startedAt, "2026-05-01T09:00:00.000Z");
  assert.equal(conv.endedAt, "2026-05-01T09:30:00.000Z");
  assert.equal(conv.source, `${files.claudeAi}#1`);
  assert.deepEqual(roles(conv), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(conv.turns.map((t) => t.at), ["2026-05-01T09:00:00.000Z", "2026-05-01T09:00:20.000Z", "2026-05-01T09:29:00.000Z", "2026-05-01T09:30:00.000Z"]);
});

test("a claude.ai message names its attachments and joins its text blocks", () => {
  const conv = readJsonFile(files.claudeAi, "1");
  assert.equal(conv.turns[0].text, "Why does login fail after the session expires?\n\n(Attached: login.log)");
  assert.equal(conv.turns[1].text, "Let me check the token lifetime.\n\nThe access token expires after 15 minutes.");
});

test("a claude.ai tool call keeps its input and gets the tool result as its output", () => {
  const conv = readJsonFile(files.claudeAi, "1");
  assert.deepEqual(conv.turns[1].tools, [{ name: "web_search", input: { query: "jwt refresh token expiry" }, output: "Refresh tokens usually outlive access tokens." }]);
  assert.deepEqual(conv.turns[0].tools, []);
});

test("an older claude.ai export with only text fields reads too, and an unnamed conversation is titled by its first message", () => {
  const conv = readJsonFile(files.claudeAi, "2");
  assert.equal(conv.title, "Plain text only message");
  assert.deepEqual(texts(conv), ["Plain text only message", "Old export with no content blocks"]);
  assert.equal(conv.source, `${files.claudeAi}#2`);
});

// --- reading a ChatGPT conversation ----------------------------------------------------------------------------

test("a ChatGPT conversation follows the branch current_node ends, not the regenerated answer", () => {
  const conv = readJsonFile(files.chatgpt, "1");
  assert.deepEqual(roles(conv), ["user", "assistant", "user", "assistant"]);
  assert.equal(conv.turns[0].text, "Explain quicksort");
  assert.equal(conv.turns[1].text, "Second answer, the one kept");
  assert.equal(conv.turns[2].text, "Show code");
  assert.ok(!JSON.stringify(conv).includes("regenerated"), "the answer that was regenerated is not part of the chat");
  assert.ok(!JSON.stringify(conv).includes("dropped"), "nor is anything said in the branch that was dropped, though it is the longer one");
});

test("a ChatGPT conversation skips system messages and messages hidden from the person", () => {
  const conv = readJsonFile(files.chatgpt, "1");
  assert.ok(!JSON.stringify(conv).includes("hidden context"));
  assert.equal(conv.turns[0].role, "user");
});

test("a ChatGPT tool message becomes a tool call of the assistant's turn, and code becomes a fenced block", () => {
  const conv = readJsonFile(files.chatgpt, "1");
  const last = conv.turns[3];
  assert.deepEqual(last.tools, [{ name: "python", input: {}, output: "[1, 2, 3]" }]);
  assert.equal(last.text, "```python\ndef qs(xs):\n    return sorted(xs)\n```\n\nThat is the whole function.");
});

test("a ChatGPT conversation has its title, id, model and times, with seconds turned into dates", () => {
  const conv = readJsonFile(files.chatgpt, "1");
  assert.equal(conv.tool, "chatgpt");
  assert.equal(conv.id, "a1111111-0000-4000-8000-000000000001");
  assert.equal(conv.title, "Sorting algorithms");
  assert.equal(conv.model, "gpt-4o");
  assert.equal(conv.startedAt, iso(1789000000.25));
  assert.equal(conv.endedAt, iso(1789000900.5));
  assert.equal(conv.turns[0].at, iso(1789000010));
  assert.equal(conv.turns[1].at, iso(1789000030));
  assert.equal(conv.source, `${files.chatgpt}#1`);
});

test("without current_node a ChatGPT conversation is the longest chain from the root, and the model comes from a message", () => {
  const conv = readJsonFile(files.chatgpt, "2");
  assert.deepEqual(texts(conv), ["Which pasta tonight?", "Carbonara, if you have eggs.", "And a vegetarian one?", "Cacio e pepe."]);
  assert.equal(conv.model, "gpt-4o-mini");
  assert.equal(conv.id, "b2222222-0000-4000-8000-000000000002");
});

test("a current_node that is not in the conversation falls back to the longest chain", () => {
  const file = write("gone-node.json", [{ ...CHATGPT[1], current_node: "no-such-node" }]);
  assert.deepEqual(texts(readJsonFile(file)), ["Which pasta tonight?", "Carbonara, if you have eggs.", "And a vegetarian one?", "Cacio e pepe."]);
});

test("a ChatGPT conversation whose messages point back at each other does not loop forever", () => {
  const file = write("loop.json", [{
    id: "loop-1", title: "Loop", current_node: "a",
    mapping: {
      a: node("a", "b", [], msg("a", "assistant", ["answer"])),
      b: node("b", "a", ["a"], msg("b", "user", ["question"])),
    },
  }]);
  const conv = readJsonFile(file);
  assert.deepEqual(texts(conv), ["question", "answer"]);
});

// --- reading a list of messages ------------------------------------------------------------------------------

test("a list of Anthropic-style messages reads as one conversation with its tool calls paired up", () => {
  const conv = readJsonFile(files.messages);
  assert.equal(conv.tool, "json");
  assert.equal(conv.source, files.messages);
  assert.equal(conv.title, "Plain string message");
  assert.deepEqual(roles(conv), ["user", "assistant", "user"]);
  assert.equal(conv.turns[0].text, "Plain string message");
  assert.equal(conv.turns[1].text, "Reading the file.\n\nIt says hello.", "the tool result is not a turn of its own");
  assert.equal(conv.turns[1].thinking, "A short file.");
  assert.deepEqual(conv.turns[1].tools, [{ name: "read_file", input: { path: "notes.txt" }, output: "file contents here" }]);
  assert.equal(conv.turns[2].text, "Thanks\n\n[image]");
  assert.ok(!JSON.stringify(conv).includes("system prompt"), "system messages are not part of the chat");
});

test("a messages object with a title, a model and OpenAI-style tool calls reads too", () => {
  const conv = readJsonFile(files.openai);
  assert.equal(conv.title, "OpenAI style");
  assert.equal(conv.model, "gpt-4o");
  assert.deepEqual(roles(conv), ["user", "assistant"]);
  assert.equal(conv.turns[0].text, "What is the weather?");
  assert.equal(conv.turns[1].text, "It is 18C and sunny in Paris.");
  assert.deepEqual(conv.turns[1].tools, [{ name: "get_weather", input: { city: "Paris" }, output: "18C and sunny" }]);
});

test("a messages file reads the same whatever --pick says, because it holds one conversation", () => {
  assert.equal(readJsonFile(files.messages, "latest").title, "Plain string message");
  assert.equal(readJsonFile(files.messages, "1").title, "Plain string message");
});

// --- this tool's own JSON ------------------------------------------------------------------------------------

test("toJson writes the format name, then the conversation, with only the fields a turn has", () => {
  const text = toJson(ferryConversation());
  assert.ok(text.endsWith("}\n"));
  assert.ok(text.startsWith("{\n  \"format\": \"claude-chat-ferry/1\","), "indented, with the format first");
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ["format", "tool", "id", "title", "project", "model", "startedAt", "endedAt", "source", "turns"]);
  assert.deepEqual(Object.keys(parsed.turns[0]), ["role", "at", "text", "thinking", "tools"]);
  assert.equal(parsed.turns.length, 2);
});

test("this tool's JSON reads back as the conversation it was made from", () => {
  const original = ferryConversation();
  const back = readJsonFile(write("roundtrip.json", toJson(original)));
  assert.equal(back.source, `${path.join(dir, "roundtrip.json")}#1`);
  assert.deepEqual({ ...back, source: "" }, { ...original, source: "" });
});

test("fromJson reads a conversation straight from parsed JSON, taking the first of a list", () => {
  const original = ferryConversation();
  const parsed = JSON.parse(toJson(original));
  assert.deepEqual({ ...fromJson(parsed), source: "" }, { ...original, source: "" });
  assert.equal(fromJson([parsed, JSON.parse(toJson(ferryConversation("Other")))]).title, "Fix the carousel on mobile");
  assert.equal(fromJson(parsed, "chat.json").source, "chat.json");
});

test("fromJson skips turns of an unknown role, and tidies tool calls and times", () => {
  const conv = fromJson({
    format: JSON_FORMAT, tool: "", title: "T",
    turns: [
      { role: "system", text: "not a turn" },
      { role: "user", at: 1783847640000, text: "hi" },
      { role: "assistant", text: "hello", tools: [{ input: { a: 1 }, output: { not: "text" } }, { name: "Bash", output: "ok" }, null] },
      null,
    ],
  });
  assert.equal(conv.tool, "json", "a conversation with no tool is called json");
  assert.deepEqual(roles(conv), ["user", "assistant"]);
  assert.equal(conv.turns[0].at, "2026-07-12T09:14:00.000Z");
  assert.deepEqual(conv.turns[1].tools, [{ name: "tool", input: { a: 1 }, output: "" }, { name: "Bash", input: {}, output: "ok" }, { name: "tool", input: {}, output: "" }]);
});

test("fromJson says so when there are no turns", () => {
  assert.throws(() => fromJson({}), /^Error: the JSON has no turns$/);
  assert.throws(() => fromJson({ tool: "cursor" }, path.join(dir, "chat.json")), /^Error: chat\.json has no turns$/);
  assert.throws(() => fromJson(null), /no turns/);
});

test("a file of several of this tool's conversations is picked from like any export", () => {
  const conv = readJsonFile(files.ferryMany, "older");
  assert.equal(conv.title, "Older chat");
  assert.equal(conv.source, `${files.ferryMany}#1`);
  assert.deepEqual(roles(conv), ["user", "assistant"]);
});

test("titleFromData is a short title from a title or name field", () => {
  assert.equal(titleFromData({ title: "A title" }), "A title");
  assert.equal(titleFromData({ name: "A name" }), "A name");
  assert.equal(titleFromData({ title: "", name: "Fallback" }), "Fallback");
  assert.equal(titleFromData({}), "");
  assert.equal(titleFromData(null), "");
  assert.equal(titleFromData({ title: "x".repeat(100) }).length, 70);
});
