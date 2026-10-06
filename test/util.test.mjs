import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import {
  UserError, baseName, capText, cleanText, cmp, ensureDir, escapeRegExp, estimateTokens, fail, firstLine, forEachLine,
  isDir, isFile, isInside, isoOf, listDir, localStamp, makeColors, mtimeIso, num, oneLine, pad2, plural, readJson,
  sameProject, slugify, tryParse, uniquePath, utcDay, utcStamp, writeFileAtomic,
} from "../src/util.mjs";

// A string with no lone surrogate halves encodes to UTF-8 and back unchanged.
const wellFormed = (s) => Buffer.from(s, "utf8").toString("utf8") === s;
const CHUNK = 1 << 20; // forEachLine reads 1 MiB at a time

// --- cleanText, oneLine, firstLine, capText --------------------------------------------------------

test("cleanText removes colour codes and other terminal control sequences", () => {
  assert.equal(cleanText("\x1b[31mred\x1b[0m and \x1b[1;4mbold\x1b[m"), "red and bold");
  assert.equal(cleanText("\x1b[?25lno cursor\x1b[?25h"), "no cursor");
  assert.equal(cleanText("a\x1b]0;window title\x07b"), "ab", "an OSC sequence ended by BEL");
  assert.equal(cleanText("a\x1b]0;window title\x1b\\b"), "ab", "an OSC sequence ended by ESC backslash");
  assert.equal(cleanText("\x1b]8;;https://example.com\x1b\\a link\x1b]8;;\x1b\\"), "a link");
});

test("cleanText removes stray control characters but keeps tabs and line breaks", () => {
  assert.equal(cleanText("a\x00b\x07c\x08d\x7fe\x0bf\x0cg"), "abcdefg");
  assert.equal(cleanText("a\tb\nc"), "a\tb\nc");
});

test("cleanText removes the bidirectional overrides and isolates that make text read differently from how it is stored", () => {
  for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    assert.equal(cleanText(`ab${String.fromCodePoint(cp)}cd`), "abcd", `U+${cp.toString(16)}`);
  }
  assert.equal(cleanText("access\u202e granted"), "access granted");
});

test("cleanText turns CRLF into LF and keeps only the last draw of a progress line", () => {
  assert.equal(cleanText("a\r\nb\r\nc"), "a\nb\nc");
  assert.equal(cleanText("10%\r50%\r100%\ndone"), "100%\ndone");
  assert.equal(cleanText("first\nspin /\rspin -\rspin \\\nlast"), "first\nspin \\\nlast");
});

test("cleanText copes with null and undefined, and leaves ordinary text alone", () => {
  assert.equal(cleanText(null), "");
  assert.equal(cleanText(undefined), "");
  assert.equal(cleanText(42), "42");
  const plain = "na\u00efve caf\u00e9 \u65e5\u672c\u8a9e \u{1F600}\tTab\nNew line";
  assert.equal(cleanText(plain), plain);
});

test("oneLine puts text on a single line: whitespace collapsed, ends trimmed, control codes gone", () => {
  assert.equal(oneLine("  a \n\t b   c  "), "a b c");
  assert.equal(oneLine("\x1b[31mred\x1b[0m\ntext"), "red text");
  assert.equal(oneLine(null), "");
  assert.equal(oneLine(undefined), "");
});

test("oneLine cuts long text to max characters and ends it with an ellipsis", () => {
  assert.equal(oneLine("abcdefghij", 5), "abcd\u2026");
  assert.equal(oneLine("abcde", 5), "abcde", "text of exactly max characters stays whole");
  assert.equal(oneLine("x".repeat(300)).length, 200, "the default is 200");
});

test("oneLine never leaves half an emoji at the cut", () => {
  const cut = oneLine("ab\u{1F600}cd", 4);
  assert.equal(cut, "ab\u2026");
  assert.ok(wellFormed(cut));
  assert.ok(wellFormed(oneLine("\u{1F600}".repeat(50), 11)));
});

test("firstLine is the first line that is not blank, as a title", () => {
  assert.equal(firstLine("\n\n  hello world \nsecond"), "hello world");
  assert.equal(firstLine(""), "");
  assert.equal(firstLine("   \n  "), "");
  assert.equal(firstLine(undefined), "");
  assert.equal(firstLine("x".repeat(100), 10), "xxxxxxxxx\u2026");
  assert.equal(firstLine("x".repeat(100)).length, 80, "the default is 80");
});

test("capText returns short text unchanged, and everything when max is zero or less", () => {
  assert.equal(capText("abc", 10), "abc");
  assert.equal(capText("abc".repeat(10), 0), "abc".repeat(10));
  assert.equal(capText("abc".repeat(10), -1), "abc".repeat(10));
  assert.equal(capText(null, 10), "");
});

test("capText keeps the start and the end of long text and says how much it left out", () => {
  const text = "a".repeat(50) + "b".repeat(50);
  assert.equal(capText(text, 20), `${"a".repeat(14)}\n\n[\u2026 80 characters left out \u2026]\n\n${"b".repeat(6)}`);
  assert.equal(capText(text, 20, 0.5), `${"a".repeat(10)}\n\n[\u2026 80 characters left out \u2026]\n\n${"b".repeat(10)}`);
  assert.match(capText("x".repeat(6000), 1000), /5,000 characters left out/, "big counts get thousands separators");
});

test("capText never splits an emoji, and its count of what it left out is exact", () => {
  const emoji = "\u{1F600}".repeat(30); // 60 UTF-16 units
  const out = capText(emoji, 21);
  assert.ok(wellFormed(out));
  const [head, , tail] = out.split("\n\n");
  const left = Number(/\[\u2026 (\d+) characters left out/.exec(out)[1]);
  assert.equal(head.length + tail.length + left, emoji.length);
});

test("estimateTokens is about one token per four characters, rounded up", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("x".repeat(400)), 100);
});

test("slugify makes a short file name: lower case, accents folded, symbols turned into single dashes", () => {
  assert.equal(slugify("Cr\u00e8me Br\u00fbl\u00e9e \u00e0 la fa\u00e7on"), "creme-brulee-a-la-facon");
  assert.equal(slugify("  Fix: the (carousel) -- on mobile!! "), "fix-the-carousel-on-mobile");
  assert.equal(slugify("Version 2.0 notes"), "version-2-0-notes");
});

test("slugify caps the name at 60 characters without leaving a trailing dash", () => {
  assert.equal(slugify("a".repeat(100)).length, 60);
  assert.equal(slugify(`${"a".repeat(59)} bbb`), "a".repeat(59));
});

test("slugify falls back to \"chat\" or the given word when nothing usable is left", () => {
  assert.equal(slugify("\u65e5\u672c\u8a9e"), "chat");
  assert.equal(slugify(""), "chat");
  assert.equal(slugify(null), "chat");
  assert.equal(slugify("!!!", "untitled"), "untitled");
});

test("baseName is the last part of a path in either spelling, whatever the system", () => {
  assert.equal(baseName("C:\\a\\b\\c.txt"), "c.txt");
  assert.equal(baseName("/a/b/c.txt"), "c.txt");
  assert.equal(baseName("/a/b/c/"), "c");
  assert.equal(baseName("C:\\a\\b\\c\\\\"), "c");
  assert.equal(baseName("c.txt"), "c.txt");
  assert.equal(baseName("/"), "");
  assert.equal(baseName(""), "");
  assert.equal(baseName(null), "");
});

// --- dates -----------------------------------------------------------------------------------------

test("isoOf reads ISO strings, converting any offset to UTC", () => {
  assert.equal(isoOf("2026-07-12T09:14:00Z"), "2026-07-12T09:14:00.000Z");
  assert.equal(isoOf("2026-07-12T14:44:00+05:30"), "2026-07-12T09:14:00.000Z");
  assert.equal(isoOf("2026-07-12T09:14:00.123456Z"), "2026-07-12T09:14:00.123Z", "microseconds, as claude.ai writes them");
  assert.equal(isoOf("2026-07-12"), "2026-07-12T00:00:00.000Z");
});

test("isoOf tells milliseconds from seconds since 1970, as numbers and as digit strings", () => {
  const iso = "2026-07-12T09:14:00.000Z";
  assert.equal(isoOf(1783847640000), iso);
  assert.equal(isoOf(1783847640), iso);
  assert.equal(isoOf("1783847640000"), iso);
  assert.equal(isoOf("1783847640"), iso);
  assert.equal(isoOf("1783847640.5"), "2026-07-12T09:14:00.500Z");
  assert.equal(isoOf(1783847640.5), "2026-07-12T09:14:00.500Z");
});

test("isoOf accepts a Date, and gives an empty string for anything that is not a time", () => {
  assert.equal(isoOf(new Date("2026-01-02T03:04:05Z")), "2026-01-02T03:04:05.000Z");
  for (const junk of [new Date("nope"), "not a date", "", "   ", null, undefined, NaN, Infinity, 0, -5, {}, [], true]) {
    assert.equal(isoOf(junk), "", String(junk));
  }
});

test("utcStamp and utcDay show a time in UTC, from any input isoOf understands", () => {
  assert.equal(utcStamp("2026-07-12T09:14:33Z"), "2026-07-12 09:14");
  assert.equal(utcStamp(1783847640000), "2026-07-12 09:14");
  assert.equal(utcStamp("junk"), "");
  assert.equal(utcDay("2026-07-12T23:59:59Z"), "2026-07-12");
  assert.equal(utcDay(1783847640000), "2026-07-12");
  assert.equal(utcDay(""), "");
});

test("localStamp shows the local date and time with two-digit fields", () => {
  assert.equal(localStamp(new Date(2026, 6, 2, 9, 5)), "2026-07-02 09:05");
  assert.equal(localStamp(new Date(2026, 11, 31, 23, 59)), "2026-12-31 23:59");
});

// --- folders ---------------------------------------------------------------------------------------

test("isInside: a folder is inside itself and its parents, not beside them (posix)", () => {
  assert.equal(isInside("/home/me/app", "/home/me/app"), true);
  assert.equal(isInside("/home/me/app", "/home/me/app/src/x.js"), true);
  assert.equal(isInside("/home/me/app", "/home/me/app/"), true);
  assert.equal(isInside("/home/me/app", "/home/me/app2"), false, "a longer name is not a child");
  assert.equal(isInside("/home/me/app/src", "/home/me/app"), false, "a parent is not inside its child");
  assert.equal(isInside("/home/me/app", "/home/me/app/../other"), false, "dot-dot is resolved first");
  assert.equal(isInside("/home/me/App", "/home/me/app/src"), false, "posix paths are case sensitive");
});

test("isInside compares Windows paths without regard to case or slash direction, whatever system this runs on", () => {
  assert.equal(isInside("D:\\Projects\\App", "d:/projects/app/src"), true);
  assert.equal(isInside("D:\\Projects\\App", "D:\\Projects\\App\\"), true);
  assert.equal(isInside("D:\\Projects\\App", "D:\\Projects\\App2"), false);
  assert.equal(isInside("D:\\Projects\\App\\src", "D:\\Projects\\App"), false);
  assert.equal(isInside("D:\\Projects", "E:\\Projects\\x"), false, "another drive");
  assert.equal(isInside("\\\\srv\\share\\p", "\\\\SRV\\share\\p\\x"), true, "a network share");
});

test("isInside is false when either path is missing", () => {
  assert.equal(isInside("", "/x"), false);
  assert.equal(isInside("/x", ""), false);
  assert.equal(isInside(undefined, undefined), false);
});

test("sameProject: the same folder, a folder inside it, and a parent folder all belong to the project", () => {
  const home = "C:\\Users\\me";
  assert.equal(sameProject("D:\\Projects\\app", "D:\\Projects\\app", home), true);
  assert.equal(sameProject("d:/projects/APP", "D:\\Projects\\app", home), true, "Windows spellings");
  assert.equal(sameProject("D:\\Projects\\app\\packages\\ui", "D:\\Projects\\app", home), true, "a chat about a sub-folder");
  assert.equal(sameProject("D:\\Projects", "D:\\Projects\\app", home), true, "a chat about the monorepo counts for its packages");
  assert.equal(sameProject("/srv", "/srv/app", "/home/me"), true);
});

test("sameProject: a sibling or an unrelated folder does not belong", () => {
  assert.equal(sameProject("D:\\Projects\\other", "D:\\Projects\\app", "C:\\Users\\me"), false);
  assert.equal(sameProject("D:\\Projects\\app2", "D:\\Projects\\app", "C:\\Users\\me"), false);
  assert.equal(sameProject("/srv/other", "/srv/app", "/home/me"), false);
});

test("sameProject: a chat from the home folder, or above it, is not about every project below", () => {
  const home = "C:\\Users\\me";
  assert.equal(sameProject("C:\\Users\\me", "C:\\Users\\me\\dev\\app", home), false, "the home folder itself");
  assert.equal(sameProject("C:\\Users", "C:\\Users\\me\\dev\\app", home), false, "above the home folder");
  assert.equal(sameProject("C:\\Users\\me\\dev", "C:\\Users\\me\\dev\\app", home), true, "a folder inside home is fine");
  assert.equal(sameProject("/home/me", "/home/me/dev/app", "/home/me"), false);
  assert.equal(sameProject("/home", "/home/me/dev/app", "/home/me"), false);
  assert.equal(sameProject("C:\\Users\\me", "C:\\Users\\me\\dev\\app"), true, "with no home given there is nothing to exclude");
});

test("sameProject: a drive root or / is never the project of a chat", () => {
  assert.equal(sameProject("D:\\", "D:\\Projects\\app", "C:\\Users\\me"), false);
  assert.equal(sameProject("D:", "D:\\Projects\\app", "C:\\Users\\me"), false);
  assert.equal(sameProject("/", "/srv/app", "/home/me"), false);
});

test("sameProject is false when the chat's folder or the project is missing", () => {
  assert.equal(sameProject("", "/srv/app", "/home/me"), false);
  assert.equal(sameProject("/srv/app", "", "/home/me"), false);
});

// --- files -----------------------------------------------------------------------------------------

test("uniquePath returns the path itself when it is free, then name-2, name-3 and so on", () => {
  const dir = tmpDir();
  const file = path.join(dir, "chat.md");
  assert.equal(uniquePath(file), file);
  fs.writeFileSync(file, "x");
  assert.equal(uniquePath(file), path.join(dir, "chat-2.md"));
  fs.writeFileSync(path.join(dir, "chat-2.md"), "x");
  assert.equal(uniquePath(file), path.join(dir, "chat-3.md"));
});

test("uniquePath keeps the extension last, and works on names with no extension or dots in the folder", () => {
  const dir = tmpDir();
  ensureDir(path.join(dir, "v1.2"));
  const bare = path.join(dir, "v1.2", "notes");
  fs.writeFileSync(bare, "x");
  assert.equal(uniquePath(bare), path.join(dir, "v1.2", "notes-2"));
});

test("writeFileAtomic writes the whole file, creating missing folders, and leaves nothing else behind", () => {
  const dir = tmpDir();
  const file = path.join(dir, "deep", "er", "out.md");
  writeFileAtomic(file, "caf\u00e9 \u{1F600}\n");
  assert.equal(fs.readFileSync(file, "utf8"), "caf\u00e9 \u{1F600}\n");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["out.md"], "the temporary file was renamed into place");
});

test("writeFileAtomic replaces an existing file completely, and can write an empty one", () => {
  const dir = tmpDir();
  const file = path.join(dir, "out.txt");
  writeFileAtomic(file, "a long first version of the text");
  writeFileAtomic(file, "short");
  assert.equal(fs.readFileSync(file, "utf8"), "short");
  writeFileAtomic(file, "");
  assert.equal(fs.readFileSync(file, "utf8"), "");
  assert.deepEqual(fs.readdirSync(dir), ["out.txt"]);
});

function linesOf(content, { stopAt } = {}) {
  const file = path.join(tmpDir(), "lines.txt");
  fs.writeFileSync(file, content);
  const lines = [];
  const result = forEachLine(file, (line) => { lines.push(line); if (line === stopAt) return false; return undefined; });
  return { lines, result };
}

test("forEachLine gives every non-empty line, whether the file ends with a newline or not", () => {
  assert.deepEqual(linesOf("one\ntwo\n\n\nthree").lines, ["one", "two", "three"]);
  assert.deepEqual(linesOf("one\ntwo\n").lines, ["one", "two"]);
  assert.deepEqual(linesOf("").lines, []);
  assert.deepEqual(linesOf("\n\n\n").lines, []);
  assert.equal(linesOf("one\n").result, true);
});

test("forEachLine handles CRLF line endings and drops a byte-order mark from the first line only", () => {
  assert.deepEqual(linesOf("one\r\ntwo\r\n").lines, ["one", "two"]);
  assert.deepEqual(linesOf("\ufeffone\ntwo\n").lines, ["one", "two"]);
  assert.deepEqual(linesOf("one\n\ufefftwo\n").lines, ["one", "\ufefftwo"]);
});

test("forEachLine stops as soon as the callback returns false, and only false stops it", () => {
  const stopped = linesOf("a\nb\nc\nd\n", { stopAt: "b" });
  assert.deepEqual(stopped.lines, ["a", "b"]);
  assert.equal(stopped.result, true);
  const file = path.join(tmpDir(), "x.txt");
  fs.writeFileSync(file, "a\nb\nc\n");
  const seen = [];
  forEachLine(file, (line) => { seen.push(line); return 0; });
  forEachLine(file, (line) => { seen.push(line); return null; });
  assert.deepEqual(seen, ["a", "b", "c", "a", "b", "c"]);
});

test("forEachLine returns false for a file that cannot be opened and calls nothing", () => {
  let called = 0;
  assert.equal(forEachLine(path.join(tmpDir(), "missing.jsonl"), () => { called++; }), false);
  assert.equal(called, 0);
});

test("forEachLine reads a 3 MB line whole", () => {
  const big = "x".repeat(3 * 1024 * 1024);
  const { lines } = linesOf(`${big}\nsecond\n`);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].length, big.length);
  assert.ok(lines[0] === big, "the long line came back unchanged");
  assert.equal(lines[1], "second");
});

test("forEachLine keeps every line of a file read in several pieces", () => {
  const count = 400000;
  const content = Array.from({ length: count }, (_, i) => `line-${i}`).join("\n");
  assert.ok(content.length > 2 * CHUNK, "the file needs at least three reads");
  const { lines } = linesOf(content);
  assert.equal(lines.length, count);
  let wrong = 0;
  for (let i = 0; i < count; i++) if (lines[i] !== `line-${i}`) wrong++;
  assert.equal(wrong, 0, "lines that were cut or joined at a piece boundary");
});

test("forEachLine does not break a character that is split between two reads", () => {
  const twoByte = linesOf(Buffer.concat([Buffer.alloc(CHUNK - 1, "a"), Buffer.from("\u00e9\nnext\n")]));
  assert.equal(twoByte.lines.length, 2);
  assert.ok(twoByte.lines[0] === `${"a".repeat(CHUNK - 1)}\u00e9`);
  const emoji = linesOf(Buffer.concat([Buffer.alloc(CHUNK - 2, "a"), Buffer.from("\u{1F600}\nnext\n")]));
  assert.ok(emoji.lines[0] === `${"a".repeat(CHUNK - 2)}\u{1F600}`);
  assert.equal(emoji.lines[1], "next");
});

test("forEachLine handles a CRLF that is split between two reads", () => {
  const { lines } = linesOf(Buffer.concat([Buffer.alloc(CHUNK - 1, "a"), Buffer.from("\r\nb\n")]));
  assert.equal(lines.length, 2);
  assert.ok(lines[0] === "a".repeat(CHUNK - 1), "the carriage return is not part of the line");
  assert.equal(lines[1], "b");
});

test("readJson parses a file, ignoring a byte-order mark, and gives null for a missing or broken file", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "ok.json"), "\ufeff{\"a\": 1}");
  fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
  assert.deepEqual(readJson(path.join(dir, "ok.json")), { a: 1 });
  assert.equal(readJson(path.join(dir, "bad.json")), null);
  assert.equal(readJson(path.join(dir, "missing.json")), null);
});

test("listDir, isDir, isFile and mtimeIso answer quietly for things that do not exist", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "f.txt"), "x");
  ensureDir(path.join(dir, "sub", "deeper"));
  assert.deepEqual(listDir(dir).map((e) => e.name).sort(), ["f.txt", "sub"]);
  assert.deepEqual(listDir(path.join(dir, "nope")), []);
  assert.equal(isDir(path.join(dir, "sub")), true);
  assert.equal(isDir(path.join(dir, "f.txt")), false);
  assert.equal(isDir(path.join(dir, "nope")), false);
  assert.equal(isFile(path.join(dir, "f.txt")), true);
  assert.equal(isFile(path.join(dir, "sub")), false);
  assert.equal(isFile(path.join(dir, "nope")), false);
  const when = new Date("2026-03-04T05:06:07Z");
  fs.utimesSync(path.join(dir, "f.txt"), when, when);
  assert.equal(mtimeIso(path.join(dir, "f.txt")), "2026-03-04T05:06:07.000Z");
  assert.equal(mtimeIso(path.join(dir, "nope")), "");
});

// --- small helpers ---------------------------------------------------------------------------------

test("makeColors: colours on for a terminal, off for pipes and NO_COLOR, switched on by FORCE_COLOR", () => {
  const on = makeColors({}, true);
  assert.equal(on.on, true);
  assert.equal(on.bold("x"), "\x1b[1mx\x1b[0m");
  assert.equal(on.dim("x"), "\x1b[2mx\x1b[0m");
  assert.equal(on.red("x"), "\x1b[31mx\x1b[0m");
  assert.equal(on.green("x"), "\x1b[32mx\x1b[0m");
  assert.equal(on.yellow("x"), "\x1b[33mx\x1b[0m");
  assert.equal(on.cyan("x"), "\x1b[36mx\x1b[0m");
  const off = makeColors({}, false);
  assert.equal(off.on, false);
  assert.equal(off.bold("x"), "x");
  assert.equal(makeColors({ NO_COLOR: "1" }, true).on, false);
  assert.equal(makeColors({ FORCE_COLOR: "1" }, false).on, true);
  assert.equal(makeColors({ FORCE_COLOR: "1", NO_COLOR: "1" }, false).on, true);
  assert.equal(makeColors({ FORCE_COLOR: "0" }, false).on, false);
});

test("num groups thousands, plural picks the form, pad2 pads", () => {
  assert.deepEqual([0, 999, 1000, 1234567, 1234.6].map(num), ["0", "999", "1,000", "1,234,567", "1,235"]);
  assert.equal(num("not a number"), "0");
  assert.equal(plural(1, "chat"), "1 chat");
  assert.equal(plural(2, "chat"), "2 chats");
  assert.equal(plural(0, "chat"), "0 chats");
  assert.equal(plural(1234, "chat"), "1,234 chats");
  assert.equal(plural(2, "box", "boxen"), "2 boxen");
  assert.equal(pad2(3), "03");
  assert.equal(pad2(12), "12");
});

test("cmp orders by code unit, the same on every machine", () => {
  assert.equal(cmp("a", "b"), -1);
  assert.equal(cmp("b", "a"), 1);
  assert.equal(cmp("a", "a"), 0);
  assert.equal(cmp("B", "a"), -1, "capitals sort before lower case, whatever the locale");
  assert.deepEqual(["b", "B", "a", "A"].sort(cmp), ["A", "B", "a", "b"]);
});

test("escapeRegExp makes any text safe to match literally", () => {
  const text = "a.b*c(d)[e]{f}+?^$|\\";
  assert.ok(new RegExp(`^${escapeRegExp(text)}$`).test(text));
  assert.ok(!new RegExp(`^${escapeRegExp("a.b")}$`).test("axb"));
});

test("tryParse gives the parsed value, or null instead of throwing", () => {
  assert.deepEqual(tryParse("{\"a\":1}"), { a: 1 });
  assert.equal(tryParse("nope"), null);
  assert.equal(tryParse(undefined), null);
  assert.equal(tryParse(""), null);
});

test("fail throws a UserError that carries the message", () => {
  assert.throws(() => fail("boom"), (e) => e instanceof UserError && e instanceof Error && e.message === "boom");
});
