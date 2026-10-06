import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { hasSqlite, tmpDir, world } from "./helpers.mjs";
import { fileUri, makeCursorStore, sampleChats } from "./fake-cursor.mjs";
import { UserError } from "../src/util.mjs";
import { blobJson, blobText, hasTable, openReadOnly } from "../src/sqlite.mjs";
import { cursorUserDir, findChat, folderOfUri, globalDb, listChats, readChat, richTextToPlain, workspaces } from "../src/cursor.mjs";

const needSqlite = { skip: !hasSqlite && "needs node:sqlite (Node 22.13+)" };

const ID = {
  carousel: "11111111-aaaa-4aaa-8aaa-111111111111",
  rename: "22222222-bbbb-4bbb-8bbb-222222222222",
  other: "33333333-cccc-4ccc-8ccc-333333333333",
  archived: "44444444-dddd-4ddd-8ddd-444444444444",
  subagent: "55555555-eeee-4eee-8eee-555555555555",
  empty: "66666666-ffff-4fff-8fff-666666666666",
  deleted: "77777777-0000-4000-8000-777777777777",
  legacy: "88888888-1111-4111-8111-888888888888",
};
const WEBAPP_WS = "a".repeat(32);

// Cursor writes a folder as a URI, which spells a Windows drive letter in lower case: compare folders
// the way a person would.
const samePath = (a, b) => {
  const norm = (p) => { const r = path.resolve(p); return process.platform === "win32" ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
};
const ids = (chats) => chats.map((c) => c.id);

// The store the tests share: a Cursor user folder built the way Cursor 3.x lays it out, with a chat in
// every kind of index and one chat each of the kinds Cursor makes that must not show up.
const shared = hasSqlite ? await (async () => {
  const w = world("cursor");
  const webapp = w.project("webapp");
  const other = w.project("other");
  await makeCursorStore(w.cursor, sampleChats(webapp, other));
  return { w, webapp, other };
})() : null;

// A small store of its own for one test.
async function storeWith(spec, name = "cursor-x") {
  const w = world(name);
  await makeCursorStore(w.cursor, spec);
  return w;
}
const ws = (id, folder) => ({ id, folder });
const chatOf = (id, workspaceId, extra = {}) => ({ id, workspaceId, name: "", bubbles: [{ type: 1, text: "hello" }, { type: 2, text: "hi" }], ...extra });

// Every file under a folder with a hash of its bytes.
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(root, p)] = createHash("sha1").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(root);
  return out;
}

// --- pure helpers (every Node) ----------------------------------------------------------------------

test("folderOfUri turns Windows file URIs into Windows paths", () => {
  assert.equal(folderOfUri("file:///d%3A/Projects/x"), "d:\\Projects\\x");
  assert.equal(folderOfUri("file:///C:/Users/me/app"), "C:\\Users\\me\\app");
  assert.equal(folderOfUri("file:///c%3A/dir%20with%20space/sub"), "c:\\dir with space\\sub");
  assert.equal(folderOfUri("file:///d%3A/My%20Projects/caf%C3%A9"), "d:\\My Projects\\caf\u00e9");
  assert.equal(folderOfUri("file:///c%3A"), "c:\\", "a drive root");
});

test("folderOfUri turns posix file URIs into posix paths", () => {
  assert.equal(folderOfUri("file:///home/me/x"), "/home/me/x");
  assert.equal(folderOfUri("file:///home/me/my%20proj"), "/home/me/my proj");
  assert.equal(folderOfUri("file:////home/me/x"), "/home/me/x", "extra slashes");
  assert.equal(folderOfUri("file:///home/100%/x"), "/home/100%/x", "a stray percent sign is not an error");
});

test("folderOfUri hands back anything that is not a file URI as it is, and nothing as an empty string", () => {
  assert.equal(folderOfUri("D:\\already\\a\\path"), "D:\\already\\a\\path");
  assert.equal(folderOfUri("vscode-remote://ssh-remote%2Bhost/home/me/x"), "vscode-remote://ssh-remote%2Bhost/home/me/x");
  assert.equal(folderOfUri(""), "");
  assert.equal(folderOfUri(undefined), "");
  assert.equal(folderOfUri(null), "");
});

test("richTextToPlain reads the text of what the person typed, one line per paragraph, with @mentions", () => {
  const doc = { root: { children: [
    { children: [{ text: "Rename the " }, { type: "mention", mentionName: "Button" }, { text: " component" }] },
    { children: [{ text: "and keep the tests green" }] },
  ] } };
  assert.equal(richTextToPlain(doc), "Rename the @Button component\nand keep the tests green");
  assert.equal(richTextToPlain(JSON.stringify(doc)), "Rename the @Button component\nand keep the tests green", "the same, stored as JSON text");
});

test("richTextToPlain reads text nested in other nodes, trims, and gives an empty string for what it cannot read", () => {
  const nested = { root: { children: [{ children: [{ children: [{ text: "  deep " }, { text: "words  " }] }] }] } };
  assert.equal(richTextToPlain(nested), "deep words");
  for (const nothing of [null, undefined, "", "not json", 42, {}, { root: {} }, { root: { children: [] } }, "[1,2]"]) {
    assert.equal(richTextToPlain(nothing), "", String(nothing));
  }
});

test("cursorUserDir: CURSOR_USER_DIR wins, as an absolute path", () => {
  const dir = path.join(tmpDir(), "my-cursor");
  assert.equal(cursorUserDir({ CURSOR_USER_DIR: dir, APPDATA: "ignored", HOME: "ignored" }, "linux"), dir);
  assert.equal(cursorUserDir({ CURSOR_USER_DIR: dir }, "win32"), dir);
  assert.equal(path.isAbsolute(cursorUserDir({ CURSOR_USER_DIR: "relative/folder" }, "linux")), true);
});

test("cursorUserDir: where Cursor keeps its data on Windows, macOS and Linux", () => {
  const home = path.join(tmpDir(), "home");
  const appdata = path.join(tmpDir(), "roaming");
  assert.equal(cursorUserDir({ APPDATA: appdata, USERPROFILE: home }, "win32"), path.join(appdata, "Cursor", "User"));
  assert.equal(cursorUserDir({ USERPROFILE: home }, "win32"), path.join(home, "AppData", "Roaming", "Cursor", "User"), "no APPDATA");
  assert.equal(cursorUserDir({ HOME: home }, "win32"), path.join(home, "AppData", "Roaming", "Cursor", "User"), "HOME when there is no USERPROFILE");
  assert.equal(cursorUserDir({ HOME: home, USERPROFILE: path.join(home, "other") }, "win32"), path.join(home, "other", "AppData", "Roaming", "Cursor", "User"), "USERPROFILE first on Windows");
  assert.equal(cursorUserDir({ HOME: home }, "darwin"), path.join(home, "Library", "Application Support", "Cursor", "User"));
  assert.equal(cursorUserDir({ HOME: home }, "linux"), path.join(home, ".config", "Cursor", "User"));
  const xdg = path.join(tmpDir(), "xdg");
  assert.equal(cursorUserDir({ HOME: home, XDG_CONFIG_HOME: xdg }, "linux"), path.join(xdg, "Cursor", "User"));
});

test("globalDb is the one database under globalStorage", () => {
  const dir = path.join(tmpDir(), "User");
  assert.equal(globalDb(dir), path.join(dir, "globalStorage", "state.vscdb"));
});

test("blobText and blobJson read what node:sqlite hands back: text, bytes, numbers or nothing", () => {
  assert.equal(blobText(null), "");
  assert.equal(blobText(undefined), "");
  assert.equal(blobText("text"), "text");
  assert.equal(blobText(new Uint8Array(Buffer.from("caf\u00e9", "utf8"))), "caf\u00e9");
  assert.equal(blobText(5), "5");
  const padded = Buffer.from("xx{\"a\":1}yy");
  assert.equal(blobText(new Uint8Array(padded.buffer, padded.byteOffset + 2, 7)), "{\"a\":1}", "a view into a bigger buffer");
  assert.deepEqual(blobJson(new Uint8Array(Buffer.from("{\"a\":[1,2]}"))), { a: [1, 2] });
  assert.deepEqual(blobJson("{\"b\":true}"), { b: true });
  assert.equal(blobJson("not json"), null);
  assert.equal(blobJson(null), null);
});

test("workspaces lists each workspace Cursor has opened with the folder it was, and skips what is not a workspace", () => {
  const userDir = tmpDir();
  const folderA = path.join(tmpDir(), "proj-a");
  const base = path.join(userDir, "workspaceStorage");
  fs.mkdirSync(path.join(base, "aaa"), { recursive: true });
  fs.writeFileSync(path.join(base, "aaa", "workspace.json"), JSON.stringify({ folder: fileUri(folderA) }));
  fs.mkdirSync(path.join(base, "bbb"), { recursive: true }); // a workspace folder with no workspace.json
  fs.writeFileSync(path.join(base, "stray-file.txt"), "not a workspace");
  const found = workspaces(userDir);
  assert.deepEqual(found.map((w) => w.id).sort(), ["aaa", "bbb"]);
  const a = found.find((w) => w.id === "aaa");
  assert.ok(samePath(a.folder, folderA));
  assert.equal(a.dir, path.join(base, "aaa"));
  assert.equal(found.find((w) => w.id === "bbb").folder, "", "an unknown folder is an empty string");
  assert.deepEqual(workspaces(path.join(userDir, "missing")), []);
});

// --- a machine without Cursor, or without node:sqlite ------------------------------------------------------

test("listChats gives no chats, instead of an error, when Cursor has no store", async () => {
  const w = world("cursor-none");
  assert.deepEqual(await listChats({ env: w.env }), []);
  assert.deepEqual(await listChats({ env: w.env, all: true }), []);
  assert.deepEqual(await listChats({ env: { ...w.env, CURSOR_USER_DIR: path.join(w.base, "no-such-cursor") }, project: w.project("webapp") }), []);
});

test("findChat finds nothing, quietly, when Cursor has no store", async () => {
  const w = world("cursor-none");
  assert.equal(await findChat("latest", { env: w.env }), null);
  assert.equal(await findChat("11111111", { env: w.env }), null);
});

test("without node:sqlite, openReadOnly explains that Node 22.13 or newer is needed", async () => {
  if (hasSqlite) { assert.equal(typeof openReadOnly, "function"); return; }
  await assert.rejects(openReadOnly(path.join(tmpDir(), "state.vscdb")), (e) => e instanceof UserError && /Node 22\.13/.test(e.message) && e.message.includes(process.versions.node));
});

test("without node:sqlite, listChats says so when Cursor has a store it cannot open", { skip: hasSqlite && "this Node has node:sqlite" }, async () => {
  const w = world("cursor-nosqlite");
  fs.mkdirSync(path.dirname(globalDb(w.cursor)), { recursive: true });
  fs.writeFileSync(globalDb(w.cursor), "not read: this Node cannot open it");
  await assert.rejects(listChats({ env: w.env }), (e) => e instanceof UserError && /Node 22\.13/.test(e.message));
});

// --- listing -------------------------------------------------------------------------------------------------

test("listChats lists chats from every index Cursor has used, and the old chat tabs", needSqlite, async () => {
  const { w } = shared;
  const chats = await listChats({ env: w.env, all: true });
  assert.deepEqual(new Set(ids(chats)), new Set([ID.carousel, ID.rename, ID.other, ID.archived, ID.legacy, ID.empty]));
  const kind = (id) => chats.find((c) => c.id === id).kind;
  assert.equal(kind(ID.carousel), "composer", "indexed in the composerHeaders table");
  assert.equal(kind(ID.other), "composer", "indexed in the global ItemTable");
  assert.equal(kind(ID.archived), "composer", "indexed in its workspace");
  assert.equal(kind(ID.legacy), "legacy", "a chat tab from before composers");
});

test("listChats leaves out subagent chats", needSqlite, async () => {
  const { w } = shared;
  assert.ok(!ids(await listChats({ env: w.env, all: true })).includes(ID.subagent));
});

test("listChats leaves out a chat whose record is gone", needSqlite, async () => {
  const { w } = shared;
  assert.ok(!ids(await listChats({ env: w.env, all: true })).includes(ID.deleted));
});

test("listChats leaves out subagents however they are indexed", needSqlite, async () => {
  const folder = tmpDir();
  const w = await storeWith({
    workspaces: [ws(WEBAPP_WS, folder)],
    chats: [
      chatOf("aaaa0001-0000-4000-8000-000000000001", WEBAPP_WS, { name: "real, in the table" }),
      chatOf("aaaa0002-0000-4000-8000-000000000002", WEBAPP_WS, { name: "helper, in the table", subagent: true }),
      chatOf("aaaa0003-0000-4000-8000-000000000003", WEBAPP_WS, { name: "real, in the item table", index: "item" }),
      chatOf("aaaa0004-0000-4000-8000-000000000004", WEBAPP_WS, { name: "helper, in the item table", index: "item", subagent: true }),
    ],
  });
  assert.deepEqual((await listChats({ env: w.env, all: true })).map((c) => c.title).sort(), ["real, in the item table", "real, in the table"]);
});

test("listChats lists a chat with no messages last, with no prompts, however new it is", needSqlite, async () => {
  const { w } = shared;
  const chats = await listChats({ env: w.env, all: true });
  const last = chats[chats.length - 1];
  assert.equal(last.id, ID.empty);
  assert.equal(last.prompts, 0);
  assert.equal(last.messages, 0);
  assert.equal(last.title, "(untitled)");
  assert.ok(last.updatedAt > chats[0].updatedAt, "it is the newest chat, and still comes last");
  assert.ok(chats.slice(0, -1).every((c) => c.prompts > 0));
});

test("listChats lists chats with messages newest first", needSqlite, async () => {
  const { w } = shared;
  const chats = await listChats({ env: w.env, all: true });
  assert.deepEqual(ids(chats), [ID.other, ID.carousel, ID.rename, ID.archived, ID.legacy, ID.empty]);
});

test("listChats gives each chat its times as ISO dates, its message and prompt counts and where it came from", needSqlite, async () => {
  const { w } = shared;
  const chats = await listChats({ env: w.env, all: true });
  const carousel = chats.find((c) => c.id === ID.carousel);
  assert.equal(carousel.tool, "cursor");
  assert.equal(carousel.title, "Fix the carousel on mobile");
  assert.equal(carousel.startedAt, "2026-07-12T09:14:00.000Z");
  assert.equal(carousel.updatedAt, "2026-07-12T10:00:00.000Z");
  assert.equal(carousel.messages, 7);
  assert.equal(carousel.prompts, 2);
  assert.equal(carousel.source, `composerData:${ID.carousel}`);
  assert.equal(carousel.workspaceId, WEBAPP_WS);
  const legacy = chats.find((c) => c.id === ID.legacy);
  assert.equal(legacy.startedAt, "");
  assert.equal(legacy.updatedAt, "2024-06-01T10:00:00.000Z");
  assert.equal(legacy.messages, 2);
  assert.equal(legacy.prompts, 1);
  assert.equal(legacy.source, `${"b".repeat(32)}/aichat.chatdata`);
});

test("listChats says which folder each chat was about", needSqlite, async () => {
  const { w, webapp, other } = shared;
  const chats = await listChats({ env: w.env, all: true });
  const project = (id) => chats.find((c) => c.id === id).project;
  assert.ok(samePath(project(ID.carousel), webapp));
  assert.ok(samePath(project(ID.archived), webapp));
  assert.ok(samePath(project(ID.other), other));
  assert.ok(samePath(project(ID.legacy), other));
});

test("listChats names a chat after its header, else the first thing the person typed, even in rich text", needSqlite, async () => {
  const { w } = shared;
  const title = async (id) => (await listChats({ env: w.env, all: true })).find((c) => c.id === id).title;
  assert.equal(await title(ID.carousel), "Fix the carousel on mobile");
  assert.equal(await title(ID.rename), "Rename the @Button component");
  assert.equal(await title(ID.legacy), "Legacy tab");
});

test("listChats titles a nameless chat or tab by the first line of the first prompt, cut at 70 characters", needSqlite, async () => {
  const folder = tmpDir();
  const w = await storeWith({
    workspaces: [ws(WEBAPP_WS, folder)],
    chats: [
      chatOf("bbbb0001-0000-4000-8000-000000000001", WEBAPP_WS, { bubbles: [{ type: 1, text: "First line of the prompt\nsecond line" }, { type: 2, text: "ok" }] }),
      chatOf("bbbb0002-0000-4000-8000-000000000002", WEBAPP_WS, { bubbles: [{ type: 1, text: "y".repeat(100) }, { type: 2, text: "ok" }] }),
    ],
    legacy: [{ workspaceId: WEBAPP_WS, tabId: "tab-without-title", chatTitle: "", bubbles: [{ type: "user", text: "An old question that was never named" }, { type: "ai", text: "An answer" }] }],
  });
  const chats = await listChats({ env: w.env, all: true });
  const byId = (id) => chats.find((c) => c.id === id).title;
  assert.equal(byId("bbbb0001-0000-4000-8000-000000000001"), "First line of the prompt");
  assert.equal(byId("bbbb0002-0000-4000-8000-000000000002"), `${"y".repeat(69)}\u2026`);
  assert.equal(byId("tab-without-title"), "An old question that was never named");
});

test("listChats marks an archived chat", needSqlite, async () => {
  const folder = tmpDir();
  const w = await storeWith({
    workspaces: [ws(WEBAPP_WS, folder)],
    chats: [chatOf("cccc0001-0000-4000-8000-000000000001", WEBAPP_WS, { name: "Old", archived: true }), chatOf("cccc0002-0000-4000-8000-000000000002", WEBAPP_WS, { name: "Current" })],
  });
  const chats = await listChats({ env: w.env, all: true });
  assert.equal(chats.find((c) => c.title === "Old").archived, true);
  assert.equal(chats.find((c) => c.title === "Current").archived, false);
});

test("listChats with a limit gives that many of the newest chats", needSqlite, async () => {
  const { w } = shared;
  assert.deepEqual(ids(await listChats({ env: w.env, all: true, limit: 2 })), [ID.other, ID.carousel]);
  assert.equal((await listChats({ env: w.env, all: true, limit: 100 })).length, 6);
});

// --- the project filter --------------------------------------------------------------------------------------

test("listChats for a project gives only that project's chats, the empty one last", needSqlite, async () => {
  const { w, webapp, other } = shared;
  assert.deepEqual(ids(await listChats({ env: w.env, project: webapp })), [ID.carousel, ID.rename, ID.archived, ID.empty]);
  assert.deepEqual(ids(await listChats({ env: w.env, project: other })), [ID.other, ID.legacy]);
});

test("listChats with all gives every project's chats whatever project is named, and so does naming none", needSqlite, async () => {
  const { w, webapp } = shared;
  assert.equal((await listChats({ env: w.env, project: webapp, all: true })).length, 6);
  assert.equal((await listChats({ env: w.env })).length, 6);
  assert.equal((await listChats({ env: w.env, project: "" })).length, 6);
});

test("listChats for a project Cursor never opened gives nothing", needSqlite, async () => {
  const { w } = shared;
  assert.deepEqual(await listChats({ env: w.env, project: w.project("never-opened") }), []);
});

test("listChats counts a chat about a parent folder for a project inside it", needSqlite, async () => {
  const { w, webapp } = shared;
  const inside = path.join(webapp, "packages", "ui");
  assert.deepEqual(ids(await listChats({ env: w.env, project: inside })), [ID.carousel, ID.rename, ID.archived, ID.empty]);
});

test("listChats does not count a chat about a folder beside the project, or one that only starts with its name", needSqlite, async () => {
  const folder = tmpDir();
  const sibling = `${folder}-2`;
  fs.mkdirSync(sibling, { recursive: true });
  const w = await storeWith({ workspaces: [ws(WEBAPP_WS, sibling)], chats: [chatOf("dddd0001-0000-4000-8000-000000000001", WEBAPP_WS, { name: "Sibling" })] });
  assert.deepEqual(await listChats({ env: w.env, project: folder }), []);
});

test("listChats counts a chat about the home folder, or above it, for no project", needSqlite, async () => {
  const w = world("cursor-home");
  const code = path.join(w.home, "code");
  const app = path.join(code, "app");
  fs.mkdirSync(app, { recursive: true });
  await makeCursorStore(w.cursor, {
    workspaces: [ws("1".repeat(32), w.home), ws("2".repeat(32), w.base), ws("3".repeat(32), code), ws("4".repeat(32), app)],
    chats: [
      chatOf("eeee0001-0000-4000-8000-000000000001", "1".repeat(32), { name: "About the home folder" }),
      chatOf("eeee0002-0000-4000-8000-000000000002", "2".repeat(32), { name: "About a folder above home" }),
      chatOf("eeee0003-0000-4000-8000-000000000003", "3".repeat(32), { name: "About the code folder" }),
      chatOf("eeee0004-0000-4000-8000-000000000004", "4".repeat(32), { name: "About the app" }),
    ],
  });
  const titles = (await listChats({ env: w.env, project: app })).map((c) => c.title).sort();
  assert.deepEqual(titles, ["About the app", "About the code folder"], "a chat opened on ~ is not about every project under it");
  assert.equal((await listChats({ env: w.env, all: true })).length, 4);
});

test("listChats falls back to the folder in a chat's own header when its workspace storage is gone", needSqlite, async () => {
  const gone = tmpDir();
  const id = "9".repeat(32);
  const w = await storeWith({ workspaces: [ws(id, gone)], chats: [chatOf("ffff0001-0000-4000-8000-000000000001", id, { name: "Orphan" })] });
  fs.rmSync(path.join(w.cursor, "workspaceStorage", id), { recursive: true, force: true });
  const [orphan] = await listChats({ env: w.env, all: true });
  assert.ok(samePath(orphan.project, gone), orphan.project);
  assert.equal((await listChats({ env: w.env, project: gone })).length, 1);
});

test("listChats shows no project for a chat whose folder nothing remembers, and a project filter skips it", needSqlite, async () => {
  const w = await storeWith({ workspaces: [], chats: [chatOf("ffff0002-0000-4000-8000-000000000002", "no-such-workspace", { name: "Folderless" })] });
  const [chat] = await listChats({ env: w.env, all: true });
  assert.equal(chat.project, "");
  assert.deepEqual(await listChats({ env: w.env, project: w.project("anything") }), []);
});

// --- finding one chat ----------------------------------------------------------------------------------------

test("findChat(\"latest\") is the project's newest chat that has messages, not the newer empty one", needSqlite, async () => {
  const { w, webapp } = shared;
  assert.equal((await findChat("latest", { env: w.env, project: webapp })).id, ID.carousel);
});

test("findChat(\"latest\") without a project looks at every project", needSqlite, async () => {
  const { w } = shared;
  assert.equal((await findChat("latest", { env: w.env })).id, ID.other);
});

test("findChat(\"latest\") finds nothing when the project has only empty chats, or none", needSqlite, async () => {
  const folder = tmpDir();
  const w = await storeWith({ workspaces: [ws(WEBAPP_WS, folder)], chats: [chatOf("abab0001-0000-4000-8000-000000000001", WEBAPP_WS, { bubbles: [] })] });
  assert.equal(await findChat("latest", { env: w.env, project: folder }), null);
  assert.equal(await findChat("latest", { env: w.env, project: w.project("other-folder") }), null);
});

test("findChat finds a chat by the start of its id, in any case, whichever project is named", needSqlite, async () => {
  const { w, webapp } = shared;
  assert.equal((await findChat("11111111", { env: w.env })).id, ID.carousel);
  assert.equal((await findChat("11111111-AAAA", { env: w.env })).id, ID.carousel);
  assert.equal((await findChat(ID.rename, { env: w.env })).id, ID.rename);
  assert.equal((await findChat("33333333", { env: w.env, project: webapp })).id, ID.other, "an id is looked up everywhere");
  const legacy = await findChat("88888888", { env: w.env });
  assert.equal(legacy.id, ID.legacy);
  assert.equal(legacy.kind, "legacy");
});

test("findChat finds nothing for an id that no chat starts with", needSqlite, async () => {
  const { w } = shared;
  assert.equal(await findChat("deadbeef", { env: w.env }), null);
  assert.equal(await findChat(ID.deleted, { env: w.env }), null, "a deleted chat is gone");
  assert.equal(await findChat(ID.subagent, { env: w.env }), null, "and so is a subagent");
});

test("findChat refuses an id start that fits two chats, and says to give more of the id", needSqlite, async () => {
  const folder = tmpDir();
  const w = await storeWith({ workspaces: [ws(WEBAPP_WS, folder)], chats: [chatOf("abcd0001-0000-4000-8000-000000000001", WEBAPP_WS), chatOf("abcd0002-0000-4000-8000-000000000002", WEBAPP_WS)] });
  await assert.rejects(findChat("abcd", { env: w.env }), /"abcd" matches 2 chats; give more of the id/);
  assert.equal((await findChat("abcd0002", { env: w.env })).id, "abcd0002-0000-4000-8000-000000000002");
});

test("findChat takes a whole id even when it is also the start of another id", needSqlite, async () => {
  const folder = tmpDir();
  const w = await storeWith({ workspaces: [ws(WEBAPP_WS, folder)], chats: [chatOf("abc", WEBAPP_WS), chatOf("abcdef", WEBAPP_WS)] });
  assert.equal((await findChat("abc", { env: w.env })).id, "abc");
  assert.equal((await findChat("abcd", { env: w.env })).id, "abcdef");
});

// --- reading one chat ----------------------------------------------------------------------------------------

async function read(id, { env } = {}) {
  const e = env || shared.w.env;
  return readChat(await findChat(id, { env: e }), { env: e });
}

test("readChat gives alternating turns: what the person asked, then the assistant's work and answer", needSqlite, async () => {
  const conv = await read(ID.carousel);
  assert.deepEqual(conv.turns.map((t) => t.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(conv.turns.map((t) => t.at), ["2026-07-12T09:14:00.000Z", "2026-07-12T09:14:01.000Z", "2026-07-12T09:14:04.000Z", "2026-07-12T09:14:05.000Z"]);
  assert.equal(conv.turns[1].text, "The touch handler calls preventDefault before the click fires, so taps never reach the arrows.");
  assert.equal(conv.turns[2].text, "What is the smallest fix?");
  assert.equal(conv.turns[3].text, "Only call preventDefault after a real swipe (more than 10 px). Tests pass.");
});

test("readChat captures the assistant's thinking", needSqlite, async () => {
  const conv = await read(ID.carousel);
  assert.equal(conv.turns[1].thinking, "Probably the touch handler.");
  assert.equal(conv.turns[3].thinking, "");
});

test("readChat captures each tool call with its name, input and output", needSqlite, async () => {
  const conv = await read(ID.carousel);
  assert.deepEqual(conv.turns[1].tools, [{ name: "read_file_v2", input: { relativeWorkspacePath: "src/Gallery.tsx" }, output: "export const Gallery = () => null;" }]);
  assert.deepEqual(conv.turns[3].tools, [{ name: "run_terminal_command_v2", input: { command: "npm test" }, output: "12 passing" }]);
  assert.deepEqual(conv.turns[0].tools, []);
});

test("readChat names the files attached to a prompt on a line of their own", needSqlite, async () => {
  const conv = await read(ID.carousel);
  assert.equal(conv.turns[0].text, "The carousel arrows do not advance on mobile. See Gallery.tsx\n\n(Attached: src/Gallery.tsx)");
});

test("readChat reads a prompt that was stored only as rich text", needSqlite, async () => {
  const conv = await read(ID.rename);
  assert.equal(conv.turns[0].text, "Rename the @Button component");
  assert.equal(conv.turns[1].text, "Done: Button is now ActionButton.");
  assert.equal(conv.title, "Rename the @Button component");
});

test("readChat has the chat's model, times, title, project and where it was read from", needSqlite, async () => {
  const { webapp } = shared;
  const conv = await read(ID.carousel);
  assert.equal(conv.tool, "cursor");
  assert.equal(conv.id, ID.carousel);
  assert.equal(conv.title, "Fix the carousel on mobile");
  assert.equal(conv.model, "fake-model-1");
  assert.equal(conv.startedAt, "2026-07-12T09:14:00.000Z");
  assert.equal(conv.endedAt, "2026-07-12T10:00:00.000Z");
  assert.ok(samePath(conv.project, webapp));
  assert.equal(conv.source, `composerData:${ID.carousel}`);
});

test("readChat reads a chat indexed only in the global ItemTable", needSqlite, async () => {
  const conv = await read(ID.other);
  assert.deepEqual(conv.turns.map((t) => `${t.role}: ${t.text}`), ["user: Hello other", "assistant: Hi"]);
  assert.equal(conv.title, "Other project chat");
});

test("readChat reads an archived chat that keeps its messages inline in the chat record", needSqlite, async () => {
  const conv = await read(ID.archived);
  assert.deepEqual(conv.turns.map((t) => `${t.role}: ${t.text}`), ["user: Old inline chat", "assistant: Old inline answer"]);
  assert.equal(conv.title, "Archived chat");
});

test("readChat reads a chat tab from before composers, with roles, title and model", needSqlite, async () => {
  const conv = await read(ID.legacy);
  assert.deepEqual(conv.turns.map((t) => `${t.role}: ${t.text}`), ["user: Old style question", "assistant: Old style answer"]);
  assert.equal(conv.title, "Legacy tab");
  assert.equal(conv.model, "gpt-4");
  assert.equal(conv.endedAt, "2024-06-01T10:00:00.000Z");
  assert.equal(conv.id, ID.legacy);
});

test("readChat of a chat with no messages gives no turns", needSqlite, async () => {
  const conv = await read(ID.empty);
  assert.deepEqual(conv.turns, []);
  assert.equal(conv.title, "(untitled)");
});

test("readChat says so when the chat is no longer in Cursor's store", needSqlite, async () => {
  const { w } = shared;
  await assert.rejects(readChat({ id: "gone-chat", kind: "composer", title: "Gone" }, { env: w.env }), /chat gone-chat is no longer in Cursor's store/);
  await assert.rejects(readChat({ id: "gone-tab", kind: "legacy", workspaceId: "b".repeat(32), title: "Gone" }, { env: w.env }), /chat gone-tab is no longer in Cursor's store/);
});

test("readChat says it cannot open the store when Cursor has none", needSqlite, async () => {
  const w = world("cursor-none");
  await assert.rejects(readChat({ id: "x", kind: "composer" }, { env: w.env }), (e) => e instanceof UserError && /cannot open .*state\.vscdb/.test(e.message));
});

test("readChat joins an assistant's thinking blocks without repeating one that was stored twice", needSqlite, async () => {
  const folder = tmpDir();
  const w = await storeWith({
    workspaces: [ws(WEBAPP_WS, folder)],
    chats: [chatOf("1010aaaa-0000-4000-8000-000000000001", WEBAPP_WS, { name: "Thinking", bubbles: [
      { type: 1, text: "think about it" },
      { type: 2, thinking: "abc", allThinkingBlocks: ["abc", "def"] },
      { type: 2, text: "done" },
    ] })],
  });
  const conv = await read("1010aaaa", { env: w.env });
  assert.equal(conv.turns[1].thinking, "abc\n\ndef");
});

test("readChat copes with the shapes Cursor stores a tool call in", needSqlite, async () => {
  const folder = tmpDir();
  const w = await storeWith({
    workspaces: [ws(WEBAPP_WS, folder)],
    chats: [chatOf("2020aaaa-0000-4000-8000-000000000001", WEBAPP_WS, { name: "Tools", bubbles: [
      { type: 1, text: "run things" },
      { type: 2, tool: { name: "plain_result", rawArgs: { command: "ls" }, result: "plain text result" } },
      { type: 2, tool: { name: "json_with_output", rawArgs: { command: "ls" }, result: "{\"output\":\"from the output field\"}" } },
      { type: 2, tool: { name: "object_result", rawArgs: "not json at all", result: { other: 1 } } },
      { type: 2, tool: { name: "", rawArgs: {}, result: "" } },
      { type: 2, text: "done" },
    ] })],
  });
  const conv = await read("2020aaaa", { env: w.env });
  assert.equal(conv.turns.length, 2);
  assert.deepEqual(conv.turns[1].tools, [
    { name: "plain_result", input: { command: "ls" }, output: "plain text result" },
    { name: "json_with_output", input: { command: "ls" }, output: "from the output field" },
    { name: "object_result", input: "not json at all", output: "{\"other\":1}" },
    { name: "tool-15", input: {}, output: "" },
  ]);
  assert.equal(conv.turns[1].text, "done");
});

test("readChat names an attached file once, and drops a prompt that says nothing", needSqlite, async () => {
  const folder = tmpDir();
  const w = await storeWith({
    workspaces: [ws(WEBAPP_WS, folder)],
    chats: [chatOf("3030aaaa-0000-4000-8000-000000000001", WEBAPP_WS, { name: "Files", bubbles: [
      { type: 1, text: "look at these", files: ["a.ts", "a.ts", "b.ts"] },
      { type: 2, text: "looked" },
      { type: 1, text: "" },
      { type: 2, text: "anything else?" },
    ] })],
  });
  const conv = await read("3030aaaa", { env: w.env });
  assert.equal(conv.turns[0].text, "look at these\n\n(Attached: a.ts, b.ts)");
  assert.deepEqual(conv.turns.map((t) => t.role), ["user", "assistant"], "the empty prompt vanished, so the two answers are one turn");
  assert.equal(conv.turns[1].text, "looked\n\nanything else?");
});

// --- the store itself ----------------------------------------------------------------------------------------

test("listing and reading never change Cursor's store", needSqlite, async () => {
  const { w } = shared;
  const before = snapshot(w.cursor);
  const chats = await listChats({ env: w.env, all: true });
  for (const c of chats) await readChat(c, { env: w.env });
  await findChat("latest", { env: w.env });
  await findChat("11111111", { env: w.env });
  assert.deepEqual(snapshot(w.cursor), before, "every file is the same, and no file was added");
});

test("listChats still lists chats from an older Cursor that has no composerHeaders table", needSqlite, async () => {
  const folder = tmpDir();
  const w = await storeWith({
    workspaces: [ws(WEBAPP_WS, folder)],
    chats: [
      chatOf("4040aaaa-0000-4000-8000-000000000001", WEBAPP_WS, { name: "In the item table", index: "item" }),
      chatOf("4040aaaa-0000-4000-8000-000000000002", WEBAPP_WS, { name: "In the workspace", index: "workspace" }),
    ],
  });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(globalDb(w.cursor));
  db.exec("DROP TABLE composerHeaders");
  db.close();
  assert.deepEqual((await listChats({ env: w.env, all: true })).map((c) => c.title).sort(), ["In the item table", "In the workspace"]);
});

test("openReadOnly opens a database that cannot be written to, and hasTable tells which tables it has", needSqlite, async () => {
  const { w } = shared;
  const db = await openReadOnly(globalDb(w.cursor));
  try {
    assert.equal(hasTable(db, "cursorDiskKV"), true);
    assert.equal(hasTable(db, "ItemTable"), true);
    assert.equal(hasTable(db, "composerHeaders"), true);
    assert.equal(hasTable(db, "no_such_table"), false);
    assert.throws(() => db.exec("CREATE TABLE intruder (x)"), /readonly/i);
  } finally { db.close(); }
});

test("openReadOnly says it cannot open a database that is not there", needSqlite, async () => {
  const file = path.join(tmpDir(), "missing", "state.vscdb");
  await assert.rejects(openReadOnly(file), (e) => e instanceof UserError && e.message.startsWith(`cannot open ${file}: `));
});
