// A Gemini CLI home with sessions in it. Invented content.
import fs from "node:fs";
import path from "node:path";

/**
 * makeGemini(home, [{ id, project, started, updated, model, isJsonl, messages: [...] }])
 */
export function makeGemini(home, sessions) {
  for (const s of sessions) {
    const hash = "proj_" + (s.project ? path.basename(s.project) : "default");
    const dir = path.join(home, "tmp", hash, "chats");
    fs.mkdirSync(dir, { recursive: true });
    const ext = s.isJsonl ? ".jsonl" : ".json";
    const file = path.join(dir, `session-${s.id}${ext}`);

    if (s.isJsonl) {
      const lines = [
        JSON.stringify({
          type: "session_meta",
          sessionId: s.id,
          cwd: s.project,
          model: s.model || "gemini-2.5-pro",
          startTime: s.started,
          lastUpdated: s.updated || s.started,
        }),
      ];
      for (const m of s.messages) {
        lines.push(JSON.stringify(m));
      }
      fs.writeFileSync(file, lines.join("\n") + "\n");
    } else {
      const data = {
        sessionId: s.id,
        project: s.project,
        cwd: s.project,
        model: s.model || "gemini-2.5-pro",
        startTime: s.started,
        lastUpdated: s.updated || s.started,
        messages: s.messages,
      };
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    }

    if (s.updated) {
      const d = new Date(s.updated);
      fs.utimesSync(file, d, d);
    }
  }
  return home;
}

export function sampleGemini(cwd = "D:\\Projects\\webapp", other = "D:\\Projects\\other") {
  return [
    {
      id: "gem-1111-2222-3333-aaaaaaaaaaaa",
      project: cwd,
      started: "2026-09-20T08:00:00.000Z",
      updated: "2026-09-20T08:02:30.000Z",
      model: "gemini-2.5-pro",
      isJsonl: false,
      messages: [
        { role: "user", timestamp: "2026-09-20T08:00:00.000Z", content: "Add a health endpoint" },
        {
          role: "model",
          timestamp: "2026-09-20T08:00:15.000Z",
          thoughts: "Need a route and a test.",
          toolCalls: [
            {
              name: "run_command",
              args: { cmd: "ls src" },
              result: "app.js\nroutes.js",
            },
          ],
          content: "Added GET /health returning 200 and a test.",
        },
        { role: "user", timestamp: "2026-09-20T08:01:00.000Z", content: "Document it" },
        { role: "model", timestamp: "2026-09-20T08:01:15.000Z", content: "Documented in README under Endpoints." },
      ],
    },
    {
      id: "gem-4444-5555-6666-bbbbbbbbbbbb",
      project: other,
      started: "2026-09-21T08:00:00.000Z",
      updated: "2026-09-21T08:01:00.000Z",
      model: "gemini-2.5-flash",
      isJsonl: true,
      messages: [
        { type: "user", timestamp: "2026-09-21T08:00:00.000Z", content: "Other project question" },
        { type: "gemini", timestamp: "2026-09-21T08:01:00.000Z", content: "Other project answer" },
      ],
    },
  ];
}
