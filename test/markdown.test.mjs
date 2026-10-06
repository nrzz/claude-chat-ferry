import test from "node:test";
import assert from "node:assert/strict";
import { SECRETS } from "./helpers.mjs";
import { fromMarkdown, toMarkdown, turnText } from "../src/markdown.mjs";
import { conversation, finish, toolLine, turn } from "../src/model.mjs";
import { makeDisplay } from "../src/redact.mjs";
import { VERSION } from "../src/version.mjs";

const PROJECT = "D:\\Projects\\webapp"; // only ever used as text here, never as a folder to open

// A finished conversation shaped like a Cursor chat. Times are whole minutes because the Markdown
// headings only show minutes.
function sample() {
  return finish(conversation({
    tool: "cursor", id: "11111111-aaaa-4aaa-8aaa-111111111111", title: "Fix the carousel on mobile", project: PROJECT, model: "fake-model-1",
    startedAt: "2026-07-12T09:14:00.000Z", endedAt: "2026-07-12T10:00:00.000Z", source: "composerData:11111111",
    turns: [
      turn("user", { at: "2026-07-12T09:14:00.000Z", text: "The carousel arrows do not advance on mobile.\n\n(Attached: src/Gallery.tsx)" }),
      turn("assistant", {
        at: "2026-07-12T09:15:00.000Z", text: "The touch handler calls preventDefault before the click.", thinking: "Probably the touch handler.",
        tools: [{ name: "read_file_v2", input: { relativeWorkspacePath: "src/Gallery.tsx" }, output: "export const Gallery = () => null;\nexport default Gallery;" }],
      }),
      turn("user", { at: "2026-07-12T09:16:00.000Z", text: "What is the smallest fix?" }),
      turn("assistant", {
        at: "2026-07-12T09:17:00.000Z", text: "Only call it after a swipe.",
        tools: [{ name: "run_terminal_command_v2", input: { command: "npm test" }, output: "12 passing" }],
      }),
    ],
  }));
}

const roles = (conv) => conv.turns.map((t) => t.role);
const texts = (conv) => conv.turns.map((t) => t.text);

function frontMatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  assert.ok(m, "the file starts with a front matter block");
  return Object.fromEntries(m[1].split("\n").map((line) => { const i = line.indexOf(": "); return [line.slice(0, i), line.slice(i + 2)]; }));
}
const bodyOf = (md) => md.replace(/^---\n[\s\S]*?\n---\n\n/, "");

// Runs fn as if the machine were in another time zone. Restores the zone by name afterwards: deleting
// TZ is not enough on every system.
function inZone(zone, fn) {
  const before = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = zone;
  try { return fn(); } finally { process.env.TZ = before; }
}

// --- writing ---------------------------------------------------------------------------------------

test("toMarkdown starts with front matter naming the chat: title, tool, id, project, model, times, turns, who wrote it", () => {
  const fm = frontMatter(toMarkdown(sample()));
  assert.deepEqual(Object.keys(fm), ["title", "tool", "id", "project", "model", "started", "ended", "turns", "exported", "by"]);
  assert.equal(fm.title, "Fix the carousel on mobile");
  assert.equal(fm.tool, "cursor");
  assert.equal(fm.id, "11111111-aaaa-4aaa-8aaa-111111111111");
  assert.equal(fm.project, PROJECT);
  assert.equal(fm.model, "fake-model-1");
  assert.equal(fm.started, "2026-07-12T09:14:00.000Z");
  assert.equal(fm.ended, "2026-07-12T10:00:00.000Z");
  assert.equal(fm.turns, "4");
  assert.match(fm.exported, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(fm.exported) - Date.now()) < 60000, "exported is the time of the export");
  assert.equal(fm.by, `claude-chat-ferry ${VERSION}`);
});

test("toMarkdown leaves out the front matter lines it has nothing for", () => {
  const md = toMarkdown(finish(conversation({ tool: "antigravity", turns: [turn("user", { text: "hi" })] })));
  assert.deepEqual(Object.keys(frontMatter(md)), ["title", "tool", "turns", "exported", "by"]);
});

test("toMarkdown writes a title, a line saying where the chat is from, and a heading per turn with its UTC time", () => {
  const body = bodyOf(toMarkdown(sample()));
  assert.equal(body, [
    "# Fix the carousel on mobile",
    "",
    `_From Cursor, project ${PROJECT}, 2026-07-12 09:14 UTC._`,
    "",
    "## User \u00b7 2026-07-12 09:14",
    "",
    "The carousel arrows do not advance on mobile.",
    "",
    "(Attached: src/Gallery.tsx)",
    "",
    "## Assistant \u00b7 2026-07-12 09:15",
    "",
    "The touch handler calls preventDefault before the click.",
    "",
    "> **Tool** read_file_v2: src/Gallery.tsx",
    "",
    "## User \u00b7 2026-07-12 09:16",
    "",
    "What is the smallest fix?",
    "",
    "## Assistant \u00b7 2026-07-12 09:17",
    "",
    "Only call it after a swipe.",
    "",
    "> **Tool** run_terminal_command_v2: npm test",
    "",
  ].join("\n"));
});

test("toMarkdown leaves the time off a heading when the turn has none, and names tools it does not know by their id", () => {
  const md = toMarkdown(finish(conversation({ tool: "my-tool", turns: [turn("user", { text: "hi" }), turn("assistant", { text: "hello" })] })), { frontMatter: false });
  assert.ok(md.includes("\n## User\n"));
  assert.ok(md.includes("\n## Assistant\n"));
  assert.ok(md.includes("_From my-tool._"));
});

test("toMarkdown without front matter starts at the title", () => {
  const md = toMarkdown(sample(), { frontMatter: false });
  assert.ok(md.startsWith("# Fix the carousel on mobile\n"));
  assert.ok(!md.includes("---"));
});

test("toMarkdown ends with one newline and never has two blank lines in a row", () => {
  const conv = finish(conversation({ tool: "cursor", turns: [turn("user", { text: "a\n\n\n\n\nb" }), turn("assistant", { text: "c" })] }));
  const md = toMarkdown(conv);
  assert.ok(md.endsWith("c\n"));
  assert.ok(!md.endsWith("\n\n"));
  assert.ok(!/\n{3,}/.test(md));
});

test("toMarkdown shows each tool call as one line by default, and nothing of its output", () => {
  const md = toMarkdown(sample());
  assert.ok(md.includes("> **Tool** read_file_v2: src/Gallery.tsx\n"));
  assert.ok(md.includes("> **Tool** run_terminal_command_v2: npm test\n"));
  assert.ok(!md.includes("export const Gallery"));
  assert.ok(!md.includes("12 passing"));
  assert.equal(toMarkdown(sample(), { tools: "brief" }).replace(/^exported: .*$/m, ""), toMarkdown(sample()).replace(/^exported: .*$/m, ""));
});

test("toMarkdown with tools \"none\" has no tool lines at all", () => {
  const md = toMarkdown(sample(), { tools: "none" });
  assert.ok(!md.includes("**Tool**"));
  assert.ok(!md.includes("read_file_v2"));
  assert.ok(md.includes("The touch handler calls preventDefault before the click."));
});

test("toMarkdown with tools \"full\" quotes each call's output under its line", () => {
  const md = toMarkdown(sample(), { tools: "full" });
  assert.ok(md.includes("> **Tool** read_file_v2: src/Gallery.tsx\n>\n> export const Gallery = () => null;\n> export default Gallery;\n"));
  assert.ok(md.includes("> **Tool** run_terminal_command_v2: npm test\n>\n> 12 passing\n"));
});

test("toMarkdown in full mode writes only the tool line for a call that has no output", () => {
  const conv = finish(conversation({ tool: "cursor", turns: [turn("user", { text: "go" }), turn("assistant", { text: "done", tools: [{ name: "Bash", input: { command: "true" }, output: "" }] })] }));
  const md = toMarkdown(conv, { tools: "full", frontMatter: false });
  assert.ok(md.endsWith("> **Tool** Bash: true\n"));
});

test("toMarkdown cuts a long tool output, keeping the start and the end, at outputMax characters", () => {
  const output = `START${"x".repeat(5000)}END`;
  const conv = finish(conversation({ tool: "cursor", turns: [turn("user", { text: "go" }), turn("assistant", { text: "done", tools: [{ name: "Bash", input: { command: "build" }, output }] })] }));
  const small = toMarkdown(conv, { tools: "full", outputMax: 100, frontMatter: false });
  assert.match(small, /> START/);
  assert.match(small, /END\n$/);
  assert.match(small, /characters left out/);
  assert.ok(small.length < 600);
  const byDefault = toMarkdown(conv, { tools: "full", frontMatter: false });
  assert.match(byDefault, /characters left out/, "the default cap is a couple of thousand characters");
  assert.ok(byDefault.length < 3000);
});

test("toMarkdown quotes every line of a multi-line output", () => {
  const conv = finish(conversation({ tool: "cursor", turns: [turn("user", { text: "go" }), turn("assistant", { text: "done", tools: [{ name: "Bash", input: { command: "ls" }, output: "one\ntwo\n\nfour" }] })] }));
  const md = toMarkdown(conv, { tools: "full", frontMatter: false });
  assert.ok(md.includes("> one\n> two\n> \n> four\n"));
});

test("toMarkdown includes the model's reasoning in a collapsed block only when asked", () => {
  assert.ok(!toMarkdown(sample()).includes("Probably the touch handler."));
  assert.ok(!toMarkdown(sample()).includes("<details>"));
  const md = toMarkdown(sample(), { thinking: true });
  assert.ok(md.includes("<details><summary>Thinking</summary>\n\nProbably the touch handler.\n\n</details>\n\nThe touch handler calls preventDefault before the click."));
  assert.equal(md.split("<details>").length - 1, 1, "only the turn that has reasoning gets a block");
});

test("toMarkdown quotes a front matter value that would be misread, and keeps plain ones bare", () => {
  const title = "Say \"hi\" # now";
  const md = toMarkdown(finish(conversation({ tool: "cursor", title, project: "C:\\Users\\Jane Doe\\app", turns: [turn("user", { text: "hi" })] })));
  assert.ok(md.includes(`title: ${JSON.stringify(title)}\n`));
  assert.ok(md.includes("project: C:\\Users\\Jane Doe\\app\n"));
  assert.ok(md.includes("tool: cursor\n"));
  assert.equal(fromMarkdown(md).title, title);
});

test("toMarkdown passes every string through the display, so secrets and home paths never reach the file", () => {
  const display = makeDisplay({ redact: true, root: PROJECT, home: "C:\\Users\\me" });
  const conv = finish(conversation({
    tool: "cursor", title: `Key ${SECRETS.github}`, project: PROJECT,
    turns: [
      turn("user", { text: `token ${SECRETS.github} in C:\\Users\\me\\notes.txt and ${PROJECT}\\src\\a.js` }),
      turn("assistant", { text: "ok", thinking: `thinking about ${SECRETS.aws}`, tools: [{ name: "bash", input: { command: `deploy --token ${SECRETS.slack}` }, output: `leaked ${SECRETS.anthropic}` }] }),
    ],
  }));
  const md = toMarkdown(conv, { display, tools: "full", thinking: true });
  for (const [kind, secret] of Object.entries({ github: SECRETS.github, aws: SECRETS.aws, slack: SECRETS.slack, anthropic: SECRETS.anthropic })) assert.ok(!md.includes(secret), `the ${kind} secret reached the file`);
  assert.ok(!md.includes("C:\\Users\\me"));
  assert.ok(md.includes("token [REDACTED:github-token] in ~/notes.txt and src/a.js"));
  assert.ok(md.includes("# Key [REDACTED:github-token]"));
  assert.ok(md.includes("> **Tool** bash: deploy --token [REDACTED:slack-token]"));
  assert.ok(md.includes("> leaked [REDACTED:anthropic-key]"));
  assert.ok(md.includes("thinking about [REDACTED:aws-access-key]"));
  assert.ok(display.counts.secrets["github-token"] >= 1);
  assert.ok(display.counts.paths >= 2);
});

test("toMarkdown without a display writes the text as it is", () => {
  const conv = finish(conversation({ tool: "cursor", turns: [turn("user", { text: `token ${SECRETS.github}` })] }));
  assert.ok(toMarkdown(conv).includes(SECRETS.github));
});

test("turnText is a turn's text followed by a line for each tool call", () => {
  assert.equal(turnText(turn("assistant", { text: "Done.", tools: [{ name: "Bash", input: { command: "ls" } }, { name: "Read", input: {} }] })), "Done.\n(Used Bash: ls)\n(Used Read)");
  assert.equal(turnText(turn("user", { text: "hi" })), "hi");
  assert.equal(turnText(turn("assistant", { tools: [{ name: "Bash", input: { command: "ls" } }] })), "(Used Bash: ls)");
});

// --- reading back what this tool wrote --------------------------------------------------------------

test("fromMarkdown reads back what toMarkdown wrote: the same turns, with the same roles and words", () => {
  const original = sample();
  const back = fromMarkdown(toMarkdown(original), { source: "chat.md" });
  assert.deepEqual(roles(back), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(texts(back), texts(original));
});

test("fromMarkdown reads back the chat's title, project, model, id and start and end", () => {
  const original = sample();
  const back = fromMarkdown(toMarkdown(original), { source: "chat.md" });
  assert.equal(back.title, original.title);
  assert.equal(back.project, original.project);
  assert.equal(back.model, original.model);
  assert.equal(back.id, original.id);
  assert.equal(back.startedAt, original.startedAt);
  assert.equal(back.endedAt, original.endedAt);
  assert.equal(back.source, "chat.md");
});

test("fromMarkdown calls its result Markdown and remembers which tool the chat was from", () => {
  const back = fromMarkdown(toMarkdown(sample()));
  assert.equal(back.tool, "markdown");
  assert.equal(back.from, "cursor");
});

test("fromMarkdown reads back the time of every turn, in any time zone", () => {
  const original = sample();
  const md = toMarkdown(original);
  for (const zone of ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) {
    const back = inZone(zone, () => fromMarkdown(md));
    assert.deepEqual(back.turns.map((t) => t.at), original.turns.map((t) => t.at), `read in ${zone}`);
  }
});

test("fromMarkdown reads back each tool call's name and what it did", () => {
  const original = sample();
  const back = fromMarkdown(toMarkdown(original));
  assert.deepEqual(back.turns.map((t) => t.tools.map((x) => x.name)), [[], ["read_file_v2"], [], ["run_terminal_command_v2"]]);
  assert.deepEqual(back.turns.map((t) => t.tools.map((x) => toolLine(x))), original.turns.map((t) => t.tools.map((x) => toolLine(x))));
});

test("fromMarkdown reads the output of a tool call back from a full export, and keeps it out of the text", () => {
  const original = sample();
  const back = fromMarkdown(toMarkdown(original, { tools: "full" }));
  assert.deepEqual(back.turns.map((t) => t.tools.map((x) => x.output)), original.turns.map((t) => t.tools.map((x) => x.output)));
  assert.ok(!back.turns[1].text.includes("export const Gallery"), "the quoted output is not part of what the assistant said");
  assert.ok(!back.turns[3].text.includes("12 passing"));
});

test("fromMarkdown keeps the model's reasoning out of the visible text, and reads it back as thinking", () => {
  const original = sample();
  const back = fromMarkdown(toMarkdown(original, { thinking: true }));
  assert.ok(!back.turns[1].text.includes("Probably the touch handler."), "the reasoning is not part of what the assistant said");
  assert.deepEqual(back.turns.map((t) => t.thinking), original.turns.map((t) => t.thinking));
});

test("fromMarkdown reads a title that needed quoting back as it was", () => {
  const title = "Say \"hi\" # now: a \\ backslash";
  const back = fromMarkdown(toMarkdown(finish(conversation({ tool: "cursor", title, turns: [turn("user", { text: "hi" }), turn("assistant", { text: "hello" })] }))));
  assert.equal(back.title, title);
});

// --- reading hand-written Markdown ---------------------------------------------------------------------

test("fromMarkdown reads **User:** and **Assistant:** labels, with the words on the same line or the next", () => {
  const conv = fromMarkdown("**User:** hello there\n\n**Assistant:** hi, how can I help\nsecond line\n\n**User:**\nmulti\nline\n");
  assert.deepEqual(roles(conv), ["user", "assistant", "user"]);
  assert.deepEqual(texts(conv), ["hello there", "hi, how can I help\nsecond line", "multi\nline"]);
  assert.equal(conv.title, "hello there");
  assert.equal(conv.tool, "markdown");
});

test("fromMarkdown reads plain \"User:\" and \"Assistant:\" lines", () => {
  const conv = fromMarkdown("User: what is 2+2\nAssistant: four\nUser: thanks\nAssistant: welcome\n");
  assert.deepEqual(roles(conv), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(texts(conv), ["what is 2+2", "four", "thanks", "welcome"]);
});

test("fromMarkdown reads \"### Human\" and \"### AI\" headings", () => {
  const conv = fromMarkdown("### Human\n\nQuestion one\n\n### AI\n\nAnswer one\n");
  assert.deepEqual(roles(conv), ["user", "assistant"]);
  assert.deepEqual(texts(conv), ["Question one", "Answer one"]);
});

test("fromMarkdown knows the usual names for the two speakers", () => {
  const shapes = {
    "# User / # Assistant": "# User\n\nq\n\n# Assistant\n\na\n",
    "## Prompt / ## Response": "## Prompt\n\nq\n\n## Response\n\na\n",
    "#### Me / #### Model": "#### Me\n\nq\n\n#### Model\n\na\n",
    "### You / ### Gemini": "### You\n\nq\n\n### Gemini\n\na\n",
    "**Human:** / **Claude:**": "**Human:** q\n\n**Claude:** a\n",
    "Human: / ChatGPT:": "Human: q\nChatGPT: a\n",
    "### Prompt / ### Answer": "### Prompt\n\nq\n\n### Answer\n\na\n",
  };
  for (const [name, md] of Object.entries(shapes)) {
    const conv = fromMarkdown(md);
    assert.deepEqual(roles(conv), ["user", "assistant"], name);
    assert.deepEqual(texts(conv), ["q", "a"], name);
  }
});

test("fromMarkdown reads the time a heading carries, as UTC when it says so", () => {
  const conv = fromMarkdown("## User \u00b7 2026-07-12T09:14:00Z\n\nhi\n\n### Assistant (2026-07-12T09:15:00Z)\n\nhello\n");
  assert.deepEqual(conv.turns.map((t) => t.at), ["2026-07-12T09:14:00.000Z", "2026-07-12T09:15:00.000Z"]);
});

test("a file with no role headings is one user turn, titled by its first line", () => {
  const conv = fromMarkdown("just some text\nwith lines\n");
  assert.deepEqual(roles(conv), ["user"]);
  assert.equal(conv.turns[0].text, "just some text\nwith lines");
  assert.equal(conv.title, "just some text");
});

test("a note with a # heading and no role headings gets the heading as its title", () => {
  const conv = fromMarkdown("# Meeting notes\n\nwe decided X\n");
  assert.equal(conv.title, "Meeting notes");
  assert.deepEqual(texts(conv), ["we decided X"]);
});

test("a code fence that contains \"## User\" does not start a new turn", () => {
  const conv = fromMarkdown("## User\n\nrun this:\n\n```md\n## User\nnot a turn\n```\n\n## Assistant\n\nok\n");
  assert.deepEqual(roles(conv), ["user", "assistant"]);
  assert.equal(conv.turns[0].text, "run this:\n\n```md\n## User\nnot a turn\n```");
  const tilde = fromMarkdown("## User\n\n~~~\n## Assistant\nstill code\n~~~\n\nafter\n");
  assert.deepEqual(roles(tilde), ["user"]);
  assert.match(tilde.turns[0].text, /still code[\s\S]*after$/);
});

test("a heading that is not a speaker's name, or a # heading inside a turn, stays in the text", () => {
  const conv = fromMarkdown("## User\n\nhello\n\n## Notes\n\nmore\n\n# A big heading\n");
  assert.deepEqual(roles(conv), ["user"]);
  assert.equal(conv.turns[0].text, "hello\n\n## Notes\n\nmore\n\n# A big heading");
});

test("a # heading before the first turn is the title when there is no front matter", () => {
  const conv = fromMarkdown("# My Chat Title\n\n## User\n\nhello\n\n## Assistant\n\nhi\n");
  assert.equal(conv.title, "My Chat Title");
  assert.deepEqual(texts(conv), ["hello", "hi"]);
});

test("without a title anywhere the title is the first user line", () => {
  assert.equal(fromMarkdown("## User\n\nhello\n\n## Assistant\n\nhi\n").title, "hello");
});

test("front matter is read, quoted values are unquoted, and keys it does not know are ignored", () => {
  const title = "Say \"hi\" # now";
  const md = [
    "---", `title: ${JSON.stringify(title)}`, "tool: claude-code", "id: abc123", "project: C:\\work\\app", "model: m-1",
    "started: 2026-07-12T09:14:00.000Z", "ended: 2026-07-12T10:00:00.000Z", "unknown_key: ignored", "turns: 2", "---", "",
    "## User", "", "hello", "", "## Assistant", "", "hi", "",
  ].join("\n");
  const conv = fromMarkdown(md, { source: "x.md" });
  assert.equal(conv.title, title);
  assert.equal(conv.tool, "markdown");
  assert.equal(conv.from, "claude-code");
  assert.equal(conv.id, "abc123");
  assert.equal(conv.project, "C:\\work\\app");
  assert.equal(conv.model, "m-1");
  assert.equal(conv.startedAt, "2026-07-12T09:14:00.000Z");
  assert.equal(conv.endedAt, "2026-07-12T10:00:00.000Z");
  assert.equal(conv.source, "x.md");
  assert.equal("unknown_key" in conv, false);
  assert.deepEqual(texts(conv), ["hello", "hi"]);
});

test("fromMarkdown reads a file with Windows line endings and a byte-order mark like any other", () => {
  const md = "---\ntitle: T\n---\n\n## User\n\nhello\n\n## Assistant\n\nhi\n";
  const crlf = fromMarkdown(`\ufeff${md.replace(/\n/g, "\r\n")}`);
  assert.equal(crlf.title, "T");
  assert.deepEqual(roles(crlf), ["user", "assistant"]);
  assert.deepEqual(texts(crlf), ["hello", "hi"]);
});

test("fromMarkdown reads tool lines of an assistant turn: name, then what it did", () => {
  const md = "## User\n\nrun it\n\n## Assistant\n\nDone.\n\n> **Tool** Bash: ls -la\n\n> **Tool** Read\n\n> **Tool** Bash: echo a: b\n";
  const conv = fromMarkdown(md);
  assert.deepEqual(roles(conv), ["user", "assistant"]);
  const tools = conv.turns[1].tools;
  assert.deepEqual(tools.map((t) => t.name), ["Bash", "Read", "Bash"]);
  assert.deepEqual(tools.map((t) => toolLine(t)), ["Bash: ls -la", "Read", "Bash: echo a: b"]);
  assert.equal(conv.turns[1].text, "Done.");
});

test("a tool line in what the person wrote is just text", () => {
  const conv = fromMarkdown("## User\n\n> **Tool** Bash: ls\n\n## Assistant\n\nok\n");
  assert.deepEqual(conv.turns[0].tools, []);
  assert.match(conv.turns[0].text, /Tool/);
});

test("fromMarkdown of an empty file is a chat with no turns", () => {
  for (const empty of ["", "   \n\n", "\ufeff"]) {
    const conv = fromMarkdown(empty);
    assert.deepEqual(conv.turns, [], JSON.stringify(empty));
    assert.equal(conv.title, "(untitled)");
  }
});
