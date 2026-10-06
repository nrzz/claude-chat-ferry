import test from "node:test";
import assert from "node:assert/strict";
import "./helpers.mjs";
import { TOOL_NAMES, appendText, conversation, exchanges, finish, isEmptyTurn, selectTurns, stats, toolLine, toolName, toolSummary, turn } from "../src/model.mjs";

const tool = (name, input = {}, output = "") => ({ name, input, output });
const shape = (conv) => conv.turns.map((t) => `${t.role}:${t.text}`);

// --- the shape -------------------------------------------------------------------------------------

test("conversation() and turn() give every field an empty value, and every call its own arrays", () => {
  assert.deepEqual(conversation(), { tool: "", id: "", title: "", project: "", model: "", startedAt: "", endedAt: "", source: "", turns: [] });
  assert.deepEqual(turn("user"), { role: "user", at: "", text: "", thinking: "", tools: [] });
  assert.equal(conversation({ tool: "cursor", title: "T" }).tool, "cursor");
  assert.equal(turn("assistant", { text: "hi" }).text, "hi");
  assert.notEqual(conversation().turns, conversation().turns);
  assert.notEqual(turn("user").tools, turn("user").tools);
});

test("appendText adds text after a blank line, and ignores blank text", () => {
  const t = turn("assistant");
  appendText(t, "  first  ");
  assert.equal(t.text, "first");
  appendText(t, "second");
  assert.equal(t.text, "first\n\nsecond");
  for (const nothing of ["   ", "", null, undefined, "\n\t"]) appendText(t, nothing);
  assert.equal(t.text, "first\n\nsecond");
  appendText(t, "third", "\n");
  assert.equal(t.text, "first\n\nsecond\nthird");
});

test("isEmptyTurn: no text, no tool calls and no thinking", () => {
  assert.equal(isEmptyTurn(turn("user")), true);
  assert.equal(isEmptyTurn(turn("user", { text: "  \n" })), true);
  assert.equal(isEmptyTurn(turn("assistant", { thinking: "  " })), true);
  assert.equal(isEmptyTurn(turn("user", { text: "hi" })), false);
  assert.equal(isEmptyTurn(turn("assistant", { tools: [tool("Bash")] })), false);
  assert.equal(isEmptyTurn(turn("assistant", { thinking: "hmm" })), false);
});

// --- finish ----------------------------------------------------------------------------------------

test("finish drops turns that have no text, no tool calls and no thinking", () => {
  const conv = finish(conversation({ turns: [turn("user", { text: "hi" }), turn("assistant", { text: "  \n " }), turn("assistant"), turn("assistant", { text: "answer" })] }));
  assert.deepEqual(shape(conv), ["user:hi", "assistant:answer"]);
});

test("finish keeps a turn that only has tool calls, or only has thinking", () => {
  const conv = finish(conversation({ turns: [turn("user", { text: "go" }), turn("assistant", { tools: [tool("Bash", { command: "ls" })] }), turn("user", { text: "and?" }), turn("assistant", { thinking: "pondering" })] }));
  assert.equal(conv.turns.length, 4);
  assert.equal(conv.turns[1].tools.length, 1);
  assert.equal(conv.turns[3].thinking, "pondering");
});

test("finish joins consecutive turns of one role: text after a blank line, tool calls in order, thinking joined", () => {
  const first = turn("assistant", { text: "one", thinking: "think 1", tools: [tool("a")] });
  const second = turn("assistant", { at: "2026-01-01T00:00:05.000Z", text: "two", thinking: "think 2", tools: [tool("b"), tool("c")] });
  const third = turn("assistant", { text: "three" });
  const conv = finish(conversation({ turns: [turn("user", { text: "q" }), first, second, third] }));
  assert.equal(conv.turns.length, 2);
  const a = conv.turns[1];
  assert.equal(a.text, "one\n\ntwo\n\nthree");
  assert.equal(a.thinking, "think 1\n\nthink 2");
  assert.deepEqual(a.tools.map((t) => t.name), ["a", "b", "c"]);
  assert.equal(a.at, "2026-01-01T00:00:05.000Z", "the turn takes the first time that is known");
});

test("finish leaves roles alternating however the reader built the turns", () => {
  const roles = ["user", "user", "assistant", "assistant", "assistant", "user", "assistant", "assistant"];
  const conv = finish(conversation({ turns: roles.map((role, i) => turn(role, { text: `t${i}` })) }));
  assert.deepEqual(conv.turns.map((t) => t.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(conv.turns[0].text, "t0\n\nt1");
});

test("finish does not change the turns it was given, only the conversation", () => {
  const first = turn("assistant", { text: " one ", tools: [tool("a")] });
  const second = turn("assistant", { text: "two", tools: [tool("b")] });
  const conv = conversation({ turns: [first, second] });
  const result = finish(conv);
  assert.equal(result, conv, "the same conversation object comes back");
  assert.equal(first.text, " one ");
  assert.equal(first.tools.length, 1);
  assert.equal(second.tools.length, 1);
  assert.equal(conv.turns[0].text, "one\n\ntwo");
});

test("finish trims the text of every turn", () => {
  const conv = finish(conversation({ turns: [turn("user", { text: "  padded \n\n" }), turn("assistant", { text: "\n answer " })] }));
  assert.deepEqual(shape(conv), ["user:padded", "assistant:answer"]);
});

test("finish fills in startedAt and endedAt from the first and the last turn that has a time", () => {
  const conv = finish(conversation({ turns: [
    turn("user", { text: "a" }),
    turn("assistant", { at: "2026-01-01T10:00:00.000Z", text: "b" }),
    turn("user", { at: "2026-01-01T10:05:00.000Z", text: "c" }),
    turn("assistant", { text: "d" }),
  ] }));
  assert.equal(conv.startedAt, "2026-01-01T10:00:00.000Z");
  assert.equal(conv.endedAt, "2026-01-01T10:05:00.000Z");
});

test("finish keeps a startedAt and endedAt the reader already knew, and leaves them empty when no turn has a time", () => {
  const known = finish(conversation({ startedAt: "2020-01-01T00:00:00.000Z", endedAt: "2020-01-02T00:00:00.000Z", turns: [turn("user", { at: "2026-01-01T10:00:00.000Z", text: "a" })] }));
  assert.equal(known.startedAt, "2020-01-01T00:00:00.000Z");
  assert.equal(known.endedAt, "2020-01-02T00:00:00.000Z");
  const none = finish(conversation({ turns: [turn("user", { text: "a" })] }));
  assert.equal(none.startedAt, "");
  assert.equal(none.endedAt, "");
});

test("finish titles a conversation with the first line of its first user turn", () => {
  assert.equal(finish(conversation({ turns: [turn("user", { text: "\n\nFix the bug\nmore detail" })] })).title, "Fix the bug");
  assert.equal(finish(conversation({ turns: [turn("assistant", { text: "Welcome" }), turn("user", { text: "Question" })] })).title, "Question");
  const long = finish(conversation({ turns: [turn("user", { text: "x".repeat(100) })] })).title;
  assert.equal(long, `${"x".repeat(69)}…`, "cut at 70 characters");
});

test("finish calls a conversation with no user text \"(untitled)\"", () => {
  assert.equal(finish(conversation()).title, "(untitled)");
  assert.equal(finish(conversation({ turns: [turn("assistant", { text: "alone" })] })).title, "(untitled)");
});

test("finish keeps a given title, on one line and at most 120 characters", () => {
  assert.equal(finish(conversation({ title: "My title", turns: [turn("user", { text: "other" })] })).title, "My title");
  assert.equal(finish(conversation({ title: "  spaced   out \n title ", turns: [] })).title, "spaced out title");
  const cut = finish(conversation({ title: "t".repeat(200), turns: [] })).title;
  assert.equal(cut.length, 120);
  assert.ok(cut.endsWith("…"));
});

// --- selecting turns -------------------------------------------------------------------------------

const sampleChat = () => conversation({ title: "T", turns: [
  turn("user", { text: "u1" }), turn("assistant", { text: "a1" }),
  turn("user", { text: "u2" }), turn("assistant", { text: "a2" }), turn("assistant", { text: "a2b" }),
  turn("user", { text: "u3" }), turn("assistant", { text: "a3" }),
] });

test("exchanges counts the user turns", () => {
  assert.equal(exchanges(sampleChat()), 3);
  assert.equal(exchanges(conversation()), 0);
});

test("selectTurns keeps the last n exchanges whole, from the n-th last user turn on", () => {
  assert.deepEqual(shape(selectTurns(sampleChat(), { last: 1 })), ["user:u3", "assistant:a3"]);
  assert.deepEqual(shape(selectTurns(sampleChat(), { last: 2 })), ["user:u2", "assistant:a2", "assistant:a2b", "user:u3", "assistant:a3"]);
});

test("selectTurns gives everything when n is as big as the chat or bigger", () => {
  assert.equal(selectTurns(sampleChat(), { last: 3 }).turns.length, 7);
  assert.equal(selectTurns(sampleChat(), { last: 10 }).turns.length, 7);
});

test("selectTurns gives the conversation itself when n is zero, negative, missing or not a number", () => {
  const conv = sampleChat();
  for (const last of [0, -1, undefined, null, "", "abc", NaN]) assert.equal(selectTurns(conv, { last }), conv, String(last));
  assert.equal(selectTurns(conv), conv, "no options at all");
  assert.equal(selectTurns(conv, {}), conv);
});

test("selectTurns accepts the number as text, as it comes from the command line", () => {
  assert.deepEqual(shape(selectTurns(sampleChat(), { last: "1" })), ["user:u3", "assistant:a3"]);
});

test("selectTurns keeps the conversation's other fields and leaves the original alone", () => {
  const conv = sampleChat();
  const cut = selectTurns(conv, { last: 1 });
  assert.notEqual(cut, conv);
  assert.equal(cut.title, "T");
  assert.equal(conv.turns.length, 7);
});

// --- stats -----------------------------------------------------------------------------------------

test("stats counts turns by role, exchanges, tool calls, characters and a token estimate", () => {
  const conv = conversation({ turns: [
    turn("user", { text: "12345678" }),
    turn("assistant", { text: "abcd", tools: [tool("x", { command: "ls" }, "output that is not part of the one-line summary")] }),
    turn("user", { text: "xyz" }),
  ] });
  // characters: 8 + 4 + "x: ls" (5) + 3 = 20, so 5 tokens
  assert.deepEqual(stats(conv), { turns: 3, user: 2, assistant: 1, exchanges: 2, tools: 1, chars: 20, tokens: 5 });
});

test("stats of an empty conversation is all zeros", () => {
  assert.deepEqual(stats(conversation()), { turns: 0, user: 0, assistant: 0, exchanges: 0, tools: 0, chars: 0, tokens: 0 });
});

// --- tool calls ------------------------------------------------------------------------------------

const summary = (input, max) => toolSummary({ name: "t", input }, max);

test("toolSummary picks the field that says what the call did", () => {
  for (const key of ["command", "cmd", "relative_workspace_path", "relativeWorkspacePath", "target_file", "targetFile", "file_path", "filePath", "path", "pattern", "query", "search", "url", "description", "prompt", "explanation"]) {
    assert.equal(summary({ other: "not this", [key]: "the value" }), "the value", key);
  }
});

test("toolSummary prefers a command to a path, and a path to a query, whatever order the fields are in", () => {
  assert.equal(summary({ path: "a.txt", command: "ls" }), "ls");
  assert.equal(summary({ query: "q", path: "p" }), "p");
  assert.equal(summary({ command: "  ", path: "a.txt" }), "a.txt", "a blank field does not count");
});

test("toolSummary falls back to the first text value, then to the JSON of the input", () => {
  assert.equal(summary({ count: 3, blank: "  ", first: "hello", second: "later" }), "hello");
  assert.equal(summary({ count: 3, nested: { a: 1 } }), "{\"count\":3,\"nested\":{\"a\":1}}");
});

test("toolSummary of text input is the text on one line, and of no input is empty", () => {
  assert.equal(summary("  echo   hi\nthere "), "echo hi there");
  for (const nothing of [{}, null, undefined, 42, true]) assert.equal(summary(nothing), "", String(nothing));
});

test("toolSummary puts a long or multi-line value on one line and cuts it at max", () => {
  assert.equal(summary({ command: "a\n   b\tc" }), "a b c");
  const long = summary({ command: "x".repeat(300) });
  assert.equal(long.length, 120, "the default is 120");
  assert.ok(long.endsWith("…"));
  assert.equal(summary({ command: "x".repeat(50) }, 10), `${"x".repeat(9)}…`);
});

test("toolSummary gives an empty summary for an input that cannot be turned into JSON, instead of throwing", () => {
  const circular = {};
  circular.self = circular;
  assert.equal(summary(circular), "");
});

test("toolLine is the tool's name and its summary", () => {
  assert.equal(toolLine(tool("Bash", { command: "ls -la" })), "Bash: ls -la");
  assert.equal(toolLine(tool("read_file_v2", { relativeWorkspacePath: "src/Gallery.tsx" })), "read_file_v2: src/Gallery.tsx");
  assert.equal(toolLine(tool("Read", {})), "Read", "just the name when there is nothing to add");
  assert.equal(toolLine({ input: {} }), "tool", "and \"tool\" when there is no name either");
  assert.equal(toolLine(tool("Bash", { command: "x".repeat(50) }), 10), `Bash: ${"x".repeat(9)}…`);
});

test("toolName gives the product's name for a tool id, the id itself when unknown, and \"unknown\" when missing", () => {
  assert.equal(toolName("claude-code"), "Claude Code");
  assert.equal(toolName("cursor"), "Cursor");
  assert.equal(toolName("antigravity"), "Antigravity");
  assert.equal(toolName("codex"), "Codex CLI");
  assert.equal(toolName("claude-ai"), "claude.ai");
  assert.equal(toolName("chatgpt"), "ChatGPT");
  assert.equal(toolName("markdown"), "Markdown");
  assert.equal(toolName("json"), "JSON");
  assert.equal(toolName("my-own-tool"), "my-own-tool");
  assert.equal(toolName(""), "unknown");
  assert.equal(toolName(undefined), "unknown");
  assert.deepEqual(Object.keys(TOOL_NAMES).sort(), ["antigravity", "chatgpt", "claude-ai", "claude-code", "codex", "cursor", "json", "markdown"]);
});
