// An Antigravity folder with conversations in it: the transcript each one gets under brain/, and
// the titles file, encoded the way Antigravity's summaries protobuf is laid out. Invented content.
import fs from "node:fs";
import path from "node:path";

// --- a minimal protobuf encoder ---
const varint = (n) => { const out = []; let v = n; do { let b = v % 128; v = Math.floor(v / 128); if (v > 0) b |= 0x80; out.push(b); } while (v > 0); return Buffer.from(out); };
const field = (num, wt, payload) => Buffer.concat([varint(num * 8 + wt), payload]);
export const pbVarint = (num, n) => field(num, 0, varint(n));
export const pbBytes = (num, bytes) => field(num, 2, Buffer.concat([varint(bytes.length), bytes]));
export const pbString = (num, s) => pbBytes(num, Buffer.from(String(s), "utf8"));

// The titles file: one field-1 entry per conversation, { f1: id, f2: { f1: title, f2: 4, f4: id } }.
export function summariesProto(conversations) {
  return Buffer.concat(conversations.filter((c) => c.title).map((c) => pbBytes(1, Buffer.concat([pbString(1, c.id), pbBytes(2, Buffer.concat([pbString(1, c.title), pbVarint(2, 4), pbString(4, c.id), pbVarint(5, 1)]))]))));
}

/**
 * makeAntigravity(dir, [{ id, title, steps: [{ source, type, status, created_at, content, thinking, tool_calls }] }], { full })
 * Writes brain/<id>/.system_generated/logs/transcript.jsonl (and transcript_full.jsonl when `full`),
 * and agyhub_summaries_proto.pb with the titles.
 */
export function makeAntigravity(dir, conversations, { full = true, titles = true } = {}) {
  for (const c of conversations) {
    const logs = path.join(dir, "brain", c.id, ".system_generated", "logs");
    fs.mkdirSync(logs, { recursive: true });
    const lines = c.steps.map((s, i) => JSON.stringify({ step_index: i, status: "DONE", ...s })).join("\n") + "\n";
    fs.writeFileSync(path.join(logs, "transcript.jsonl"), lines);
    if (full) fs.writeFileSync(path.join(logs, "transcript_full.jsonl"), c.fullLines ? c.fullLines.map((s, i) => JSON.stringify({ step_index: i, status: "DONE", ...s })).join("\n") + "\n" : lines);
  }
  if (titles) fs.writeFileSync(path.join(dir, "agyhub_summaries_proto.pb"), summariesProto(conversations));
  return dir;
}

export const USER = (content, created_at) => ({ source: "USER_EXPLICIT", type: "USER_INPUT", created_at, content: `<USER_REQUEST>\n${content}\n</USER_REQUEST>` });
export const HISTORY = (created_at) => ({ source: "SYSTEM", type: "CONVERSATION_HISTORY", created_at });
export const ANSWER = (content, created_at, extra = {}) => ({ source: "MODEL", type: "PLANNER_RESPONSE", created_at, content, ...extra });
export const TOOL = (type, content, created_at) => ({ source: "MODEL", type, created_at, content });

export function sampleConversations() {
  return [
    {
      id: "a4637e82-7a92-4895-8051-3ea8dd644802", title: "Retry loop in the client",
      steps: [
        USER("fix the retry loop in client.go", "2026-09-30T10:00:00Z"),
        HISTORY("2026-09-30T10:00:01Z"),
        ANSWER("Running the tests first.", "2026-09-30T10:00:05Z", { thinking: "Look at client.go before anything.", tool_calls: [{ name: "run_command", args: { CommandLine: "go test ./...", Cwd: "/tmp/proj" } }] }),
        TOOL("RUN_COMMAND", "ok  \tproj\t0.4s", "2026-09-30T10:00:09Z"),
        TOOL("VIEW_FILE", "package client\n\nfunc retry() {}\n", "2026-09-30T10:00:12Z"),
        ANSWER("The loop never backs off. I added exponential backoff with a cap of 30 seconds.", "2026-09-30T10:01:00Z"),
        USER("thanks, also add a test", "2026-09-30T10:02:00Z"),
        ANSWER("Added client_test.go with a backoff test.", "2026-09-30T10:03:00Z"),
      ],
    },
    {
      id: "c545ff0c-fb94-41b9-b564-1509a63bcacb", title: "",
      steps: [USER("what does this repo do", "2026-06-14T17:38:17Z"), HISTORY("2026-06-14T17:38:18Z"), ANSWER("It is a small web app.", "2026-06-14T17:38:40Z")],
    },
  ];
}
