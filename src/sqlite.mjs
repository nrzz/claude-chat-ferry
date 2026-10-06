// Node's built-in SQLite (node:sqlite, Node 22.13 and newer), loaded only when a Cursor store is
// read, so that everything else works on Node 18. Databases are opened read-only; nothing is
// ever written to another tool's store.
import { UserError, tryParse } from "./util.mjs";

let mod = null;

export async function sqlite() {
  if (mod) return mod;
  const original = process.emitWarning;
  // Node 22 announces the module as experimental on first use; that line is not the person's concern.
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === "string" ? warning : warning?.message || "";
    if (/sqlite/i.test(text)) return undefined;
    return original.call(process, warning, ...rest);
  };
  try {
    mod = await import("node:sqlite");
  } catch {
    throw new UserError(`reading this tool's chats needs Node 22.13 or newer (its built-in SQLite); this is Node ${process.versions.node}`);
  } finally {
    process.emitWarning = original;
  }
  return mod;
}

// Opens a database read-only. A store the other tool is writing to at this moment can be busy for
// a few milliseconds: a few retries cover that.
export async function openReadOnly(file) {
  const { DatabaseSync } = await sqlite();
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return new DatabaseSync(file, { readOnly: true });
    } catch (e) {
      last = e;
      if (!/busy|locked/i.test(String(e.message))) break;
      const until = Date.now() + 50 * (attempt + 1);
      while (Date.now() < until) { /* wait */ }
    }
  }
  throw new UserError(`cannot open ${file}: ${last?.message || "unknown error"}`);
}

export const hasTable = (db, name) => !!db.prepare("select 1 as ok from sqlite_master where type = 'table' and name = ?").get(name);

// A stored value as text: node:sqlite hands blobs back as Uint8Array.
export function blobText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("utf8");
  return String(v);
}
export const blobJson = (v) => tryParse(blobText(v));
