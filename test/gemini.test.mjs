import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tmpDir, world } from "./helpers.mjs";
import { makeGemini, sampleGemini } from "./fake-gemini.mjs";
import { geminiHome, findSession, listSessions, readSession } from "../src/gemini.mjs";
import { readJsonFile } from "../src/exports.mjs";

const ID = { health: "gem-1111-2222-3333-aaaaaaaaaaaa", other: "gem-4444-5555-6666-bbbbbbbbbbbb" };

// A Gemini home with sample sessions
const shared = world("gemini");
const webapp = shared.project("webapp");
const other = shared.project("other");
makeGemini(shared.gemini, sampleGemini(webapp, other));

const ids = (list) => list.map((s) => s.id);

test("geminiHome is GEMINI_HOME when set, as an absolute path", () => {
  const dir = path.join(tmpDir(), "my-gemini");
  assert.equal(geminiHome({ GEMINI_HOME: dir, HOME: "/ignored" }, "linux"), dir);
  assert.equal(geminiHome({ GEMINI_HOME: dir, USERPROFILE: "C:\\ignored" }, "win32"), dir);
  assert.equal(path.isAbsolute(geminiHome({ GEMINI_HOME: "relative/gemini" }, "linux")), true);
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

// --- listing -----------------------------------------------------------------------------------------

test("listSessions lists the sessions of every project, newest first", () => {
  const list = listSessions({ env: shared.env, all: true });
  assert.deepEqual(ids(list), [ID.other, ID.health]);
  assert.deepEqual(ids(listSessions({ env: shared.env })), [ID.other, ID.health], "and so does naming no project");
});

test("listSessions titles a session with the first thing the person said, and names its project and times", () => {
  const [newer, older] = listSessions({ env: shared.env, all: true });
  assert.equal(older.title, "Add a health endpoint");
  assert.equal(newer.title, "Other project question");
  assert.equal(older.project, webapp);
  assert.equal(newer.project, other);
  assert.equal(older.startedAt, "2026-09-20T08:00:00.000Z");
  assert.equal(older.updatedAt, "2026-09-20T08:02:30.000Z");
  assert.equal(newer.updatedAt, "2026-09-21T08:01:00.000Z");
  assert.equal(older.tool, "gemini");
});

test("listSessions says where each session was read from", () => {
  const [first] = listSessions({ env: shared.env, all: true });
  assert.ok(first.source.startsWith(path.join(shared.gemini, "tmp")));
  assert.match(path.basename(first.source), /^session-.*\.jsonl?$/);
  assert.ok(fs.existsSync(first.source));
});

test("listSessions for a project gives only that project's sessions", () => {
  assert.deepEqual(ids(listSessions({ env: shared.env, project: webapp })), [ID.health]);
  assert.deepEqual(ids(listSessions({ env: shared.env, project: other })), [ID.other]);
  assert.deepEqual(listSessions({ env: shared.env, project: shared.project("never-used") }), []);
});

test("listSessions honors limit", () => {
  const list = listSessions({ env: shared.env, all: true, limit: 1 });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, ID.other);
});

test("listSessions returns empty list when tmp folder does not exist", () => {
  const emptyWorld = world("gemini-empty");
  assert.deepEqual(listSessions({ env: emptyWorld.env, all: true }), []);
});

// --- finding -----------------------------------------------------------------------------------------

test("findSession(\"latest\") gives the newest session", () => {
  assert.equal(findSession("latest", { env: shared.env, all: true }).id, ID.other);
  assert.equal(findSession("latest", { env: shared.env, project: webapp }).id, ID.health);
});

test("findSession by id prefix or exact match", () => {
  assert.equal(findSession("gem-1111", { env: shared.env }).id, ID.health);
  assert.equal(findSession(ID.health, { env: shared.env }).id, ID.health);
  assert.equal(findSession("non-existent", { env: shared.env }), null);
});

test("findSession throws on ambiguous prefix", () => {
  const ambWorld = world("gemini-amb");
  makeGemini(ambWorld.gemini, [
    { id: "gem-dup-1111", project: "", started: "2026-09-20T08:00:00.000Z", isJsonl: false, messages: [{ role: "user", content: "hi" }] },
    { id: "gem-dup-2222", project: "", started: "2026-09-20T08:00:00.000Z", isJsonl: false, messages: [{ role: "user", content: "hello" }] },
  ]);
  assert.throws(() => findSession("gem-dup", { env: ambWorld.env }), /"gem-dup" matches 2 sessions; give more of the id/);
});

// --- reading -----------------------------------------------------------------------------------------

test("readSession reads turns, model, thinking, tool calls from JSON session", () => {
  const entry = findSession(ID.health, { env: shared.env });
  const conv = readSession(entry);
  assert.equal(conv.tool, "gemini");
  assert.equal(conv.id, ID.health);
  assert.equal(conv.project, webapp);
  assert.equal(conv.model, "gemini-2.5-pro");
  assert.equal(conv.turns.length, 4);

  assert.equal(conv.turns[0].role, "user");
  assert.equal(conv.turns[0].text, "Add a health endpoint");

  assert.equal(conv.turns[1].role, "assistant");
  assert.equal(conv.turns[1].thinking, "Need a route and a test.");
  assert.equal(conv.turns[1].text, "Added GET /health returning 200 and a test.");
  assert.equal(conv.turns[1].tools.length, 1);
  assert.equal(conv.turns[1].tools[0].name, "run_command");
  assert.deepEqual(conv.turns[1].tools[0].input, { cmd: "ls src" });
  assert.equal(conv.turns[1].tools[0].output, "app.js\nroutes.js");

  assert.equal(conv.turns[2].role, "user");
  assert.equal(conv.turns[2].text, "Document it");

  assert.equal(conv.turns[3].role, "assistant");
  assert.equal(conv.turns[3].text, "Documented in README under Endpoints.");
});

test("readSession reads turns and model from JSONL session", () => {
  const entry = findSession(ID.other, { env: shared.env });
  const conv = readSession(entry);
  assert.equal(conv.tool, "gemini");
  assert.equal(conv.id, ID.other);
  assert.equal(conv.project, other);
  assert.equal(conv.model, "gemini-2.5-flash");
  assert.equal(conv.turns.length, 2);
  assert.equal(conv.turns[0].role, "user");
  assert.equal(conv.turns[0].text, "Other project question");
  assert.equal(conv.turns[1].role, "assistant");
  assert.equal(conv.turns[1].text, "Other project answer");
});

test("readJsonFile parses a Gemini /chat share export", () => {
  const f = path.join(tmpDir(), "gemini-share.json");
  fs.writeFileSync(f, JSON.stringify({
    generator: "gemini-cli",
    sessionId: "share-xyz",
    messages: [
      { role: "user", content: "How do I sort in JS?" },
      { role: "model", content: "Use Array.prototype.sort()." },
    ],
  }));
  const conv = readJsonFile(f);
  assert.equal(conv.tool, "gemini");
  assert.equal(conv.id, "share-xyz");
  assert.equal(conv.turns.length, 2);
  assert.equal(conv.turns[0].role, "user");
  assert.equal(conv.turns[0].text, "How do I sort in JS?");
  assert.equal(conv.turns[1].role, "assistant");
  assert.equal(conv.turns[1].text, "Use Array.prototype.sort().");
});
