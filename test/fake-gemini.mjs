// A Gemini CLI home with sessions in it, written in the shapes Gemini CLI 0.64.0 records
// (test/fixtures/gemini-0.64.0 holds files recorded from that release; the builders below follow
// them). The words in the sessions are invented.
//
// <home>/.gemini/projects.json                       { projects: { "<project folder>": "<short name>" } }
// <home>/.gemini/tmp/<short name>/chats/session-<time>-<id start>.jsonl
//   line 1: { sessionId, projectHash, startTime, lastUpdated, kind }, then one record per line.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export const SESSION_CONTEXT = "<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\nToday's date is Monday, 21 September 2026 (formatted according to the user's locale).\nMy operating system is: win32\n</session_context>";

const TOKENS = { input: 1, output: 1, cached: 0, thoughts: 0, tool: 0, total: 2 };

// A user message: content is a list of parts (a string becomes one text part).
export const user = (id, at, content) => ({ id, timestamp: at, type: "user", content: typeof content === "string" ? [{ text: content }] : content });
// The tool's answer going back to the model is recorded as a user message too.
export const toolAnswer = (id, at, callId, name, response) => user(id, at, [{ functionResponse: { id: callId, name, response } }]);
// A model message. `content` is a string; `thoughts` are { subject, description } objects.
export const model = (id, at, content, extra = {}) => ({ id, timestamp: at, type: "gemini", content, thoughts: [], tokens: TOKENS, model: "gemini-3.1-pro-preview", ...extra });
// A tool call of a model message; `response` is { output } or { error }.
export const call = (id, name, args, response, at) => ({
  id, name, args,
  result: [{ functionResponse: { id, name, response } }],
  status: "error" in response ? "error" : "success",
  timestamp: at, resultDisplay: "", displayName: name, renderOutputAsMarkdown: true,
});

/**
 * makeGemini(home, [{ id, project, started, updated, records, ... }])  writes <home>/.gemini/...
 *   records   the lines after the metadata line (messages and $set, $patch, $rewindTo records)
 *   folder    the short name of the project folder (default: the project's last folder, lowercased)
 *   legacy    true: the folder is the SHA-256 of the project and no projects.json names it (older releases)
 *   registry  false: the project is not entered in projects.json
 *   meta      more fields for the metadata line (directories, kind)
 *   json      true: one .json document (older releases) instead of .jsonl
 */
export function makeGemini(home, sessions) {
  const root = path.join(home, ".gemini");
  const projects = {};
  for (const s of sessions) {
    const project = s.project || "";
    const folder = s.folder || (s.legacy ? sha256(project) : (path.basename(project) || "default").toLowerCase());
    if (project && !s.legacy && s.registry !== false) projects[project] = folder;
    const dir = path.join(root, "tmp", folder, "chats");
    fs.mkdirSync(dir, { recursive: true });
    const meta = { sessionId: s.id, projectHash: sha256(project), startTime: s.started, lastUpdated: s.updated || s.started, kind: "main", ...(s.meta || {}) };
    const stamp = String(s.started || "2026-09-20T08:00:00.000Z").slice(0, 16).replace(/:/g, "-");
    const file = path.join(dir, `session-${stamp}-${s.id.slice(0, 8)}.${s.json ? "json" : "jsonl"}`);
    if (s.json) {
      fs.writeFileSync(file, JSON.stringify({ ...meta, messages: s.records.filter((r) => r.id) }, null, 2) + "\n");
    } else {
      fs.writeFileSync(file, [meta, ...s.records].map((r) => JSON.stringify(r)).join("\n") + "\n");
    }
    if (s.updated) { const d = new Date(s.updated); fs.utimesSync(file, d, d); }
  }
  if (Object.keys(projects).length) {
    const reg = path.join(root, "projects.json");
    let old = {};
    try { old = JSON.parse(fs.readFileSync(reg, "utf8")).projects || {}; } catch { /* none yet */ }
    fs.writeFileSync(reg, JSON.stringify({ projects: { ...old, ...projects } }, null, 2) + "\n");
  }
  return root;
}

export const IDS = {
  health: "11111111-2222-4333-8444-aaaaaaaaaaaa",
  other: "44444444-5555-4666-8777-bbbbbbbbbbbb",
};

// Two sessions: one that Gemini CLI wrote the way it does (the first message is its session context, a
// message is written twice when its tool call finishes, a $patch rewrites the turn, a $set follows
// each message), for `cwd`; one for `other`, whose folder is named by `directories`.
export function sampleGemini(cwd = "D:\\Projects\\webapp", other = "D:\\Projects\\other") {
  const t = (m, s) => `2026-09-20T08:${m}:${s}.000Z`;
  const answer = { output: "app.js\nroutes.js" };
  const thought = { subject: "Looking around", description: "Need a route and a test.", timestamp: t("00", "05") };
  return [
    {
      id: IDS.health, project: cwd, started: t("00", "00"), updated: t("02", "30"),
      records: [
        user("m1", t("00", "00"), SESSION_CONTEXT),
        { $set: { lastUpdated: t("00", "00") } },
        user("m2", t("00", "01"), "Add a health endpoint"),
        { $set: { lastUpdated: t("00", "01") } },
        model("m3", t("00", "05"), "", { thoughts: [thought] }),
        model("m3", t("00", "05"), "", { thoughts: [thought], toolCalls: [call("run_shell_command_1", "run_shell_command", { command: "ls src" }, answer, t("00", "06"))] }),
        toolAnswer("m4", t("00", "07"), "run_shell_command_1", "run_shell_command", answer),
        model("m5", t("00", "15"), "Added GET /health returning 200 and a test."),
        { $set: { sessionId: IDS.health } },
        { $patch: { updates: [{ id: "m3", content: [{ text: "**Looking around** Need a route and a test.", thought: true }, { functionCall: { id: "run_shell_command_1", name: "run_shell_command", args: { command: "ls src" } } }] }], orderIds: ["m1", "m2", "m3", "m4", "m5"] } },
        user("m6", t("01", "00"), "Document it"),
        model("m7", t("01", "15"), "Documented in README under Endpoints."),
        { $set: { lastUpdated: t("02", "30") } },
      ],
    },
    {
      id: IDS.other, project: other, registry: false, started: "2026-09-21T08:00:00.000Z", updated: "2026-09-21T08:01:00.000Z",
      meta: { directories: [other] },
      records: [
        user("o1", "2026-09-21T08:00:00.000Z", SESSION_CONTEXT),
        user("o2", "2026-09-21T08:00:01.000Z", "Other project question"),
        model("o3", "2026-09-21T08:01:00.000Z", "Other project answer", { model: "gemini-2.5-flash" }),
      ],
    },
  ];
}
