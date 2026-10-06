// Does Claude Code itself continue a session this tool wrote? With a Claude Code binary at hand
// (E2E_CLAUDE, or `claude` on the PATH) the test resumes an imported session against a fake API
// on localhost and checks what Claude Code sent: every imported turn, the banner first, then the
// new prompt. No real request is made and no token is spent. Without a binary the test is skipped.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { world } from "./helpers.mjs";
import { makeAntigravity, sampleConversations } from "./fake-antigravity.mjs";
import { run } from "./helpers.mjs";

function findClaude() {
  if (process.env.E2E_CLAUDE) return process.env.E2E_CLAUDE;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8", windowsHide: true });
  const line = (probe.stdout || "").split(/\r?\n/).find((l) => l.trim());
  return line ? line.trim() : "";
}
const CLAUDE = findClaude();
const isWinShim = /\.cmd$/i.test(CLAUDE);

test("Claude Code resumes an imported session and sends its turns to the model", { skip: !CLAUDE && "no Claude Code binary (set E2E_CLAUDE)" }, async () => {
  const w = world("e2e");
  const project = w.project("proj");
  makeAntigravity(w.antigravity, sampleConversations());
  const imp = await run(["import", "antigravity:latest"], w, { cwd: project });
  assert.equal(imp.code, 0, imp.all);
  const id = /claude --resume ([0-9a-f-]{36})/.exec(imp.out)[1];
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { seen.push({ url: req.url, body }); res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fake api: stop here" } })); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { ...w.env, ANTHROPIC_API_KEY: "sk-ant-api03-bogus", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
  delete env.CLAUDECODE;
  const args = ["-p", "--resume", id, "--output-format", "json", "Reply with OK. MARKER_NEW_PROMPT"];
  const child = isWinShim ? spawn(`"${CLAUDE}" ${args.map((a) => `"${a}"`).join(" ")}`, { cwd: project, env, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) : spawn(CLAUDE, args, { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  child.stdout.on("data", () => {});
  await new Promise((r) => { const t = setTimeout(() => { child.kill(); r(); }, 90000); child.on("exit", () => { clearTimeout(t); r(); }); });
  server.close();
  const posts = seen.filter((s) => s.url.startsWith("/v1/messages"));
  assert.ok(posts.length >= 1, `Claude Code never called the API; stderr: ${err.slice(0, 500)}`);
  const body = JSON.parse(posts[0].body);
  const text = (m) => (typeof m.content === "string" ? m.content : (m.content || []).map((b) => b.text || "").join("\n"));
  const msgs = body.messages.filter((m) => m.role === "user" || m.role === "assistant");
  assert.match(text(msgs[0]), /^\[Conversation imported from Antigravity chat "Retry loop in the client"/);
  const all = msgs.map(text).join("\n");
  for (const marker of ["fix the retry loop in client.go", "Running the tests first.", "thanks, also add a test", "Added client_test.go with a backoff test.", "MARKER_NEW_PROMPT"]) assert.ok(all.includes(marker), `missing: ${marker}`);
  assert.ok(msgs.length >= 5, `${msgs.length} messages`);
});
