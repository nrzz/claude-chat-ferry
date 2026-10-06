// Small shared helpers: errors, text, dates, file names, colours and files.
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// A problem the person can fix (wrong id, bad option). Printed without a stack trace, exit code 1.
export class UserError extends Error {}
export const fail = (message) => { throw new UserError(message); };

// Compares two strings by code unit: the same order on every machine, whatever its locale.
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const pad2 = (n) => String(n).padStart(2, "0");
export const num = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
export const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

// What a terminal or an editor should never be handed: colour codes and other control sequences,
// bidirectional overrides that can make text read differently from how it is stored, and stray
// control characters. A lone carriage return is a progress bar redrawing itself: keep the last draw.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]/g;
export function cleanText(s) {
  let t = String(s ?? "").replace(ANSI, "").replace(/\r+\n/g, "\n");
  if (t.includes("\r")) t = t.split("\n").map((l) => l.slice(l.lastIndexOf("\r") + 1)).join("\n");
  return t.replace(CONTROL, "");
}

// One line of text for a terminal or a title.
export function oneLine(s, max = 200) {
  const t = cleanText(String(s ?? "")).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).replace(/[\ud800-\udbff]$/, "") + "…" : t;
}
// The first non-empty line of a text, as a title.
export const firstLine = (s, max = 80) => oneLine(String(s ?? "").split("\n").find((l) => l.trim()) || "", max);

// Cut a long text down to `max` characters, keeping the start and the end (the end of a command's
// output is usually where the error is). max <= 0 means no limit.
export function capText(text, max, headShare = 0.7) {
  const s = String(text ?? "");
  if (!(max > 0) || s.length <= max) return s;
  const head = Math.floor(max * headShare);
  let a = s.slice(0, head);
  let b = s.slice(s.length - (max - head));
  if (/[\ud800-\udbff]$/.test(a)) a = a.slice(0, -1);
  if (/^[\udc00-\udfff]/.test(b)) b = b.slice(1);
  return `${a}\n\n[… ${num(s.length - a.length - b.length)} characters left out …]\n\n${b}`;
}

// Rough: about four characters per token for English prose and code. Good enough to say whether
// an import costs 2,000 or 60,000 tokens.
export const estimateTokens = (text) => Math.ceil(String(text ?? "").length / 4);

// A file name from a title: lower-case letters, digits and dashes, at most 60 characters.
export function slugify(s, fallback = "chat") {
  const t = String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return t || fallback;
}

// The last part of a path in either spelling, whatever the OS we run on.
export const baseName = (p) => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";

// ---------------------------------------------------------------------------------------------
// Dates. Files carry UTC so an export reads the same on every machine.
// ---------------------------------------------------------------------------------------------

// An ISO timestamp from whatever a tool stored: an ISO string, milliseconds or seconds since 1970,
// a Date, or "" when it is none of those.
export function isoOf(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : "";
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && v.trim()) {
    if (/^\d{9,14}(\.\d+)?$/.test(v.trim())) return isoOf(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : "";
  }
  return "";
}
export const utcDay = (iso) => isoOf(iso).slice(0, 10);
export const utcStamp = (iso) => { const t = isoOf(iso); return t ? `${t.slice(0, 10)} ${t.slice(11, 16)}` : ""; };
export function localStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------------------------
// Colours: on for a terminal, off for pipes and when NO_COLOR is set. FORCE_COLOR switches them on.
// ---------------------------------------------------------------------------------------------

export function makeColors(env = process.env, isTTY = !!process.stdout.isTTY) {
  const forced = !!env.FORCE_COLOR && env.FORCE_COLOR !== "0";
  const on = forced || (isTTY && !env.NO_COLOR);
  const paint = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { on, bold: paint("1"), dim: paint("2"), red: paint("31"), green: paint("32"), yellow: paint("33"), cyan: paint("36") };
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export function listDir(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } }
export function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
export function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
export function mtimeIso(p) { try { return fs.statSync(p).mtime.toISOString(); } catch { return ""; } }
export function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return null; } }
export function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

// Writes the whole file or nothing: a temporary file next to it is renamed into place.
export function writeFileAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// file, or file-2.ext, file-3.ext ... the first that does not exist yet.
export function uniquePath(file) {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let i = 2; i < 1000; i++) { const f = `${stem}-${i}${ext}`; if (!fs.existsSync(f)) return f; }
  throw new UserError(`too many files named like ${file}`);
}

// Calls fn(line) for every non-empty line of a UTF-8 file, reading it in 1 MB pieces so a session
// of hundreds of megabytes never has to fit in memory as one string. Stops early when fn returns
// false. Returns false when the file cannot be opened.
export function forEachLine(file, fn) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return false; }
  const buf = Buffer.allocUnsafe(1 << 20);
  const decoder = new StringDecoder("utf8");
  let pieces = [];
  let first = true;
  const emit = (raw) => {
    let line = raw;
    if (first) { first = false; if (line.charCodeAt(0) === 0xfeff) line = line.slice(1); }
    if (line.endsWith("\r")) line = line.slice(0, -1);
    return line ? fn(line) : undefined;
  };
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      const chunk = decoder.write(buf.subarray(0, n));
      let start = 0;
      for (let nl = chunk.indexOf("\n", start); nl !== -1; nl = chunk.indexOf("\n", start)) {
        pieces.push(chunk.slice(start, nl));
        start = nl + 1;
        const line = pieces.length === 1 ? pieces[0] : pieces.join("");
        pieces = [];
        if (emit(line) === false) return true;
      }
      if (start < chunk.length) pieces.push(chunk.slice(start));
    }
    pieces.push(decoder.end());
    const last = pieces.join("");
    if (last) emit(last);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

// Is p the folder `root` or somewhere below it? Windows spellings compare without regard to case
// and with either slash, whatever OS this runs on.
const looksWindows = (s) => /^[a-zA-Z]:[\\/]|^\\\\/.test(s);
export function isInside(root, p) {
  if (!root || !p) return false;
  const win = looksWindows(root) || looksWindows(p);
  const api = win ? path.win32 : path.posix;
  let a = api.normalize(root);
  let b = api.normalize(p);
  if (win) { a = a.toLowerCase(); b = b.toLowerCase(); }
  const rel = api.relative(a, b);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel));
}
// Does a chat about `folder` belong to `project`? Yes for the same folder, for a folder inside the
// project, and for a parent of the project (a chat about the monorepo counts for its packages),
// unless that parent is the home folder or above it: a chat from a Cursor window opened on ~ is
// not about every project under it.
export function sameProject(folder, project, home = "") {
  if (!folder || !project) return false;
  if (isInside(project, folder)) return true;
  if (!isInside(folder, project)) return false;
  if (home && isInside(folder, home)) return false;
  return !/^(?:[a-zA-Z]:)?[\\/]*$/.test(folder);
}
