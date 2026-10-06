// A Codex CLI home with sessions in it, in the rollout layout. Invented content.
import fs from "node:fs";
import path from "node:path";

/**
 * makeCodex(home, [{ id, cwd, started (ISO), model, items: [...] }]) where items are
 *   ["user", text] | ["assistant", text] | ["call", name, argsObject, callId] | ["output", callId, text] | ["reasoning", text]
 */
export function makeCodex(home, sessions) {
  for (const s of sessions) {
    const t0 = Date.parse(s.started);
    const day = new Date(t0);
    const dir = path.join(home, "sessions", String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, "0"), String(day.getUTCDate()).padStart(2, "0"));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = s.started.replace(/[:.]/g, "-").replace("Z", "");
    const file = path.join(dir, `rollout-${stamp}-${s.id}.jsonl`);
    const lines = [{ timestamp: s.started, type: "session_meta", payload: { id: s.id, timestamp: s.started, cwd: s.cwd, originator: "codex_cli_rs", cli_version: "0.130.0", instructions: null } }];
    if (s.model) lines.push({ timestamp: s.started, type: "turn_context", payload: { cwd: s.cwd, model: s.model, approval_policy: "on-request" } });
    s.items.forEach((it, i) => {
      const timestamp = new Date(t0 + (i + 1) * 15000).toISOString();
      const [kind, a, b, c] = it;
      if (kind === "user") lines.push({ timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: a }] } });
      else if (kind === "assistant") lines.push({ timestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: a }] } });
      else if (kind === "call") lines.push({ timestamp, type: "response_item", payload: { type: "function_call", name: a, arguments: JSON.stringify(b), call_id: c } });
      else if (kind === "output") lines.push({ timestamp, type: "response_item", payload: { type: "function_call_output", call_id: a, output: b } });
      else if (kind === "reasoning") lines.push({ timestamp, type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: a }] } });
      else if (kind === "event") lines.push({ timestamp, type: "event_msg", payload: { type: "token_count", info: null } });
    });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const end = new Date(t0 + (s.items.length + 2) * 15000);
    fs.utimesSync(file, end, end);
  }
  return home;
}

export function sampleCodex(cwd = "D:\\Projects\\webapp", other = "D:\\Projects\\other") {
  return [
    { id: "0199c0de-1111-4111-8111-aaaaaaaaaaaa", cwd, started: "2026-09-20T08:00:00.000Z", model: "gpt-5-codex", items: [["user", "Add a health endpoint"], ["reasoning", "Need a route and a test."], ["call", "exec_command", { cmd: "ls src" }, "call_1"], ["output", "call_1", "app.js\nroutes.js"], ["assistant", "Added GET /health returning 200 and a test."], ["event"], ["user", "Document it"], ["assistant", "Documented in README under Endpoints."]] },
    { id: "0199c0de-2222-4222-8222-bbbbbbbbbbbb", cwd: other, started: "2026-09-21T08:00:00.000Z", items: [["user", "Other project question"], ["assistant", "Other project answer"]] },
  ];
}
