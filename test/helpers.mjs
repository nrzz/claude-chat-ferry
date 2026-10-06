// Shared test helpers: throwaway worlds (a Claude config folder, a home folder, project folders),
// ways to run the CLI, fake secrets, and whether this Node has SQLite.
//
// SAFETY: nothing here reads or writes a real folder of Claude Code, Cursor, Antigravity or
// Codex. Importing this file points HOME, USERPROFILE, CLAUDE_CONFIG_DIR, CURSOR_USER_DIR,
// ANTIGRAVITY_DIR and CODEX_HOME of the test process at empty temporary folders, so even a test
// that forgets to pass its own environment cannot reach them. Every child process gets a world's
// environment, and runCli refuses to run with a config folder outside the OS temp folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "bin", "claude-chat-ferry.mjs");

const made = [];
export function tmpDir(prefix = "ferry-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
process.on("exit", () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// The guard: empty folders for this process.
const guard = tmpDir("ferry-guard-");
process.env.HOME = guard;
process.env.USERPROFILE = guard;
process.env.CLAUDE_CONFIG_DIR = path.join(guard, ".claude");
process.env.CURSOR_USER_DIR = path.join(guard, "cursor");
process.env.ANTIGRAVITY_DIR = path.join(guard, "antigravity");
process.env.CODEX_HOME = path.join(guard, "codex");
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;

const underTmp = (p) => path.resolve(p).toLowerCase().startsWith(fs.realpathSync(os.tmpdir()).toLowerCase());
const configDirOf = (e) => e.CLAUDE_CONFIG_DIR || path.join((process.platform === "win32" ? e.USERPROFILE || e.HOME : e.HOME) || "", ".claude");

// A throwaway world: base/home is the home folder, base/home/.claude the Claude config folder,
// base/cursor a Cursor user folder, base/antigravity an Antigravity folder, base/codex a Codex home,
// base/work/<name> project folders.
export function world(name = "w") {
  const base = tmpDir(`ferry-${name}-`);
  const home = path.join(base, "home");
  const claude = path.join(home, ".claude");
  const cursor = path.join(base, "cursor");
  const antigravity = path.join(base, "antigravity");
  const codex = path.join(base, "codex");
  for (const d of [claude, cursor, antigravity, codex]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claude, CURSOR_USER_DIR: cursor, ANTIGRAVITY_DIR: antigravity, CODEX_HOME: codex, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return {
    base, home, claude, cursor, antigravity, codex, env,
    project(n) { const d = path.join(base, "work", n); fs.mkdirSync(d, { recursive: true }); return d; },
  };
}

// Runs the real CLI in a child process.
export function runCli(args, { cwd, env, input } = {}) {
  const e = { ...process.env, ...env };
  if (!underTmp(configDirOf(e)) || !underTmp(e.HOME || "") || !underTmp(e.USERPROFILE || "")) {
    throw new Error("runCli needs an environment from world(): the Claude config and home folders must be temporary");
  }
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: e, input, encoding: "utf8", windowsHide: true, timeout: 120000 });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", all: `${r.stdout || ""}${r.stderr || ""}` };
}

// Runs main() in this process and captures what it prints.
export async function run(args, w, { cwd, tty = false, env = {} } = {}) {
  const out = [];
  const err = [];
  const code = await main(args, { cwd: cwd || w.base, env: { ...w.env, ...env }, tty, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join(""), err: err.join(""), all: out.join("") + err.join("") };
}

// Does this Node have node:sqlite (22.13 and newer)? Tests of the Cursor reader skip without it.
export const hasSqlite = await (async () => { try { await import("node:sqlite"); return true; } catch { return false; } })();

// Fake secrets, built from pieces so no complete token sits in the source for scanners to flag.
const j = (...parts) => parts.join("");
export const SECRETS = {
  anthropic: j("sk-", "ant-", "api03-", "A1b2C3d4".repeat(6)),
  dbPassword: "hunter2secret",
  github: j("gh", "p_", "c".repeat(36)),
  aws: j("AKIA", "IOSFODNN7", "EXAMPLE"),
  slack: j("xo", "xb-", "123456789012-abcdefghij"),
};

export const read = (f) => fs.readFileSync(f, "utf8");
export const exists = (f) => fs.existsSync(f);
