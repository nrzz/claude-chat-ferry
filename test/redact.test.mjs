import test from "node:test";
import assert from "node:assert/strict";
import { SECRETS } from "./helpers.mjs";
import { PLACEHOLDER_VALUE, SECRET_RULES, VALUE_RULES, describeCounts, findSecrets, makeDisplay, makeRedactor, pathMapper } from "../src/redact.mjs";

// Every fake secret is built from pieces, so no complete token sits in this file for a scanner to flag.
const j = (...parts) => parts.join("");

// [what it is, the kind the redactor names it, the fake secret]
const WHOLE_MATCH = [
  ["a private key block", "private-key", j("-----BEGIN ", "OPENSSH PRIVATE KEY-----\n", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n", "AAAAB3NzaC1lZDI1NTE5AAAAIB\n", "-----END ", "OPENSSH PRIVATE KEY-----")],
  ["an Anthropic API key", "anthropic-key", SECRETS.anthropic],
  ["an OpenAI project key", "openai-key", j("sk-", "proj-", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6")],
  ["an OpenAI key of the older shape", "openai-key", j("sk-", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0")],
  ["a Stripe live key", "stripe-key", j("sk_", "live_", "A1b2C3d4E5f6G7h8I9j0K1l2")],
  ["a Stripe restricted test key", "stripe-key", j("rk_", "test_", "A1b2C3d4E5f6G7h8I9j0")],
  ["a GitHub token", "github-token", SECRETS.github],
  ["a GitHub OAuth token", "github-token", j("gh", "o_", "d".repeat(36))],
  ["a GitHub fine-grained token", "github-token", j("github", "_pat_", "11ABCDEFG0", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ")],
  ["a GitLab token", "gitlab-token", j("gl", "pat-", "abcdefghij0123456789")],
  ["a Slack token", "slack-token", SECRETS.slack],
  ["a Slack webhook", "slack-webhook", j("https://hooks.", "slack.com/services/", "T0000000/B0000000/abcdefghijklmnopqrstuvwx")],
  ["a Teams webhook", "teams-webhook", j("https://contoso.", "webhook.office.com/", "webhookb2/abc-123@def/IncomingWebhook/xyz/uvw")],
  ["an AWS access key id", "aws-access-key", SECRETS.aws],
  ["an AWS temporary access key id", "aws-access-key", j("AS", "IA", "IOSFODNN7", "EXAMPLE")],
  ["a Google API key", "google-api-key", j("AI", "za", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6x")],
  ["a Google OAuth client secret", "google-oauth-secret", j("GOC", "SPX-", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4")],
  ["an npm token", "npm-token", j("npm", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")],
  ["a Hugging Face token", "huggingface-token", j("hf", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7")],
  ["a SendGrid key", "sendgrid-key", j("SG", ".", "A1b2C3d4E5f6G7h8I9j0K1", ".", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v")],
  ["a JSON web token", "jwt", j("ey", "J", "hbGciOiJIUzI1NiJ9", ".", "ey", "J", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "abcdefghijklmnop")],
];

// [what it is, the kind, the text, the text after redaction]: these rules keep the label and replace the value.
const LABELLED = [
  ["a bearer token", "bearer-token", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789", "Authorization: Bearer [REDACTED:bearer-token]"],
  ["a password in a URL", "url-password", `postgres://admin:${SECRETS.dbPassword}@db.example.com:5432/app`, "postgres://admin:[REDACTED:url-password]@db.example.com:5432/app"],
  ["an AWS secret access key", "aws-secret", j("aws_secret_access_key = \"", "wJalrXUtnFEMI/", "K7MDENG/", "bPxRfiCY", "EXAMPLEKEY\""), "aws_secret_access_key = \"[REDACTED:aws-secret]\""],
  ["an Azure storage key", "azure-key", j("DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6", "==;EndpointSuffix=core.windows.net"), "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=[REDACTED:azure-key];EndpointSuffix=core.windows.net"],
  ["a password in a connection string", "connection-password", `Server=db;Database=app;User Id=sa;Password=${SECRETS.dbPassword};`, "Server=db;Database=app;User Id=sa;Password=[REDACTED:connection-password];"],
  ["a secret in an environment assignment", "env-secret", `export DATABASE_PASSWORD=${SECRETS.dbPassword}`, "export DATABASE_PASSWORD=[REDACTED:env-secret]"],
  ["an env file line", "env-secret", "API_KEY=abcd1234efgh5678", "API_KEY=[REDACTED:env-secret]"],
  ["a quoted password", "assigned-secret", `password: "${SECRETS.dbPassword}"`, "password: \"[REDACTED:assigned-secret]\""],
  ["a secret in JSON", "assigned-secret", "{\"client_secret\": \"abcdef123456\"}", "{\"client_secret\": \"[REDACTED:assigned-secret]\"}"],
  ["a token in code", "assigned-secret", "const token = \"abcdef123456\"", "const token = \"[REDACTED:assigned-secret]\""],
];

// --- the secret rules ------------------------------------------------------------------------------

for (const [what, kind, secret] of WHOLE_MATCH) {
  test(`makeRedactor replaces ${what}`, () => {
    const counts = {};
    const out = makeRedactor()(`before ${secret} after`, counts);
    assert.equal(out, `before [REDACTED:${kind}] after`);
    assert.deepEqual(counts, { [kind]: 1 });
  });
}

for (const [what, kind, text, expected] of LABELLED) {
  test(`makeRedactor replaces ${what} and keeps its label`, () => {
    const counts = {};
    const out = makeRedactor()(text, counts);
    assert.equal(out, expected);
    assert.deepEqual(counts, { [kind]: 1 });
  });
}

test("every rule of the redactor has a sample above, so a new rule cannot be added untested", () => {
  const covered = new Set([...WHOLE_MATCH, ...LABELLED].map((row) => row[1]));
  const rules = new Set([...SECRET_RULES, ...VALUE_RULES].map((rule) => rule[0]));
  assert.deepEqual([...rules].sort(), [...covered].sort());
});

test("a private key is replaced whole, with the key material between the markers", () => {
  const body = "TOPSECRETLINE1\nTOPSECRETLINE2";
  const out = makeRedactor()(`${j("-----BEGIN ", "RSA PRIVATE KEY-----")}\n${body}\n${j("-----END ", "RSA PRIVATE KEY-----")}\nkept`, {});
  assert.equal(out, "[REDACTED:private-key]\nkept");
});

test("placeholders and template references are left alone", () => {
  const redact = makeRedactor();
  for (const text of [
    "password: changeme",
    "password: \"changeme\"",
    "TOKEN=${TOKEN}",
    "export API_KEY=$API_KEY",
    "API_KEY=%API_KEY%",
    "api_key: \"<your-api-key>\"",
    "secret: \"xxxxxxxxxx\"",
    "token = \"your-token-here\"",
    "SECRET_KEY=example-key-value",
    "API_KEY=dummy-value",
    "password = \"password\"",
    "password: \"testing\"",
    "password: \"[REDACTED:x]\"",
  ]) {
    const counts = {};
    assert.equal(redact(text, counts), text, text);
    assert.deepEqual(counts, {}, text);
  }
});

test("a placeholder beside a real secret does not stop the real one from being replaced", () => {
  const counts = {};
  const out = makeRedactor()(`DB_PASSWORD=changeme\nAPI_TOKEN=${SECRETS.dbPassword}\n`, counts);
  assert.equal(out, "DB_PASSWORD=changeme\nAPI_TOKEN=[REDACTED:env-secret]\n");
  assert.deepEqual(counts, { "env-secret": 1 });
});

test("PLACEHOLDER_VALUE matches the obvious non-secrets and not a real-looking value", () => {
  for (const v of ["changeme", "CHANGE_ME", "xxxx", "****", "null", "none", "undefined", "example-key", "dummy_value", "your-token", "<token>", "${TOKEN}", "$TOKEN", "%TOKEN%", "[REDACTED:github-token]", "test"]) {
    assert.ok(PLACEHOLDER_VALUE.test(v), v);
  }
  for (const v of [SECRETS.dbPassword, "s3cr3tV4lue", "hunter2"]) assert.ok(!PLACEHOLDER_VALUE.test(v), v);
});

test("makeRedactor counts every replacement, adding to the counts it is given", () => {
  const redact = makeRedactor();
  const counts = {};
  const out = redact(`a ${SECRETS.github} b ${SECRETS.github} c ${SECRETS.aws}`, counts);
  assert.equal(out, "a [REDACTED:github-token] b [REDACTED:github-token] c [REDACTED:aws-access-key]");
  assert.deepEqual(counts, { "github-token": 2, "aws-access-key": 1 });
  redact(`again ${SECRETS.github}`, counts);
  assert.deepEqual(counts, { "github-token": 3, "aws-access-key": 1 });
});

test("makeRedactor works without a counts object", () => {
  assert.equal(makeRedactor()(`key ${SECRETS.aws}`), "key [REDACTED:aws-access-key]");
});

test("text that is already redacted stays as it is", () => {
  const redact = makeRedactor();
  const text = `token ${SECRETS.github}\nBearer abcdefghijklmnopqrstuvwxyz0123456789\nDB_PASSWORD=${SECRETS.dbPassword}`;
  const once = redact(text, {});
  const counts = {};
  assert.equal(redact(once, counts), once);
  assert.deepEqual(counts, {});
});

test("makeRedactor hands back anything that is not a string, and strings too short to hold a secret", () => {
  const redact = makeRedactor();
  assert.equal(redact("short"), "short");
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(42), 42);
});

test("makeRedactor takes extra patterns as \"custom\" rules, and skips one that is not a valid pattern", () => {
  const counts = {};
  const out = makeRedactor(["ACME-[0-9]{6}", "([unclosed"])("ticket ACME-123456 and ACME-654321 done", counts);
  assert.equal(out, "ticket [REDACTED:custom] and [REDACTED:custom] done");
  assert.deepEqual(counts, { custom: 2 });
});

test("findSecrets counts the secrets a text still holds, by kind", () => {
  assert.deepEqual(findSecrets(`${SECRETS.github} and ${SECRETS.aws} and ${SECRETS.github} and password: "${SECRETS.dbPassword}"`), { "github-token": 2, "aws-access-key": 1, "assigned-secret": 1 });
  assert.deepEqual(findSecrets("nothing to see here, just text that is long enough"), {});
  assert.deepEqual(findSecrets(""), {});
});

// --- paths -----------------------------------------------------------------------------------------

test("pathMapper shows the project folder as a relative path and the home folder as ~, in every Windows spelling", () => {
  const map = pathMapper({ root: "D:\\Projects\\webapp", home: "C:\\Users\\me" });
  assert.equal(map("D:\\Projects\\webapp\\src\\a.js"), "src/a.js");
  assert.equal(map("D:\\Projects\\webapp\\src\\deep\\er\\a.js"), "src/deep/er/a.js");
  assert.equal(map("d:/projects/webapp/src/a.js"), "src/a.js", "forward slashes and another case");
  assert.equal(map("/d/Projects/webapp/src/a.js"), "src/a.js", "Git Bash");
  assert.equal(map("/mnt/d/Projects/webapp/src/a.js"), "src/a.js", "WSL");
  assert.equal(map("/cygdrive/d/Projects/webapp/src/a.js"), "src/a.js", "Cygwin");
  assert.equal(map("D:\\Projects\\webapp"), ".");
  assert.equal(map("C:\\Users\\me\\notes.txt"), "~/notes.txt");
  assert.equal(map("/c/Users/me/.claude/x.json"), "~/.claude/x.json");
  assert.equal(map("C:\\Users\\me"), "~");
});

test("pathMapper rewrites a path inside a sentence and leaves the words around it", () => {
  const map = pathMapper({ root: "D:\\Projects\\webapp", home: "C:\\Users\\me" });
  assert.equal(map("see D:\\Projects\\webapp\\src\\a.js: line 3"), "see src/a.js: line 3");
  assert.equal(map("cp D:\\Projects\\webapp\\a.txt C:\\Users\\me\\b.txt"), "cp a.txt ~/b.txt");
});

test("pathMapper does not touch folders that merely start with the same name", () => {
  const map = pathMapper({ root: "D:\\Projects\\webapp", home: "C:\\Users\\me" });
  for (const other of ["C:\\Users\\me2\\x", "D:\\Projects\\webapp2\\x", "D:\\Projects\\webapp-old\\x", "D:\\Projects\\webapp_old\\x", "D:\\Projects\\webapp.bak\\x", "D:\\Projects\\webapp.ts"]) {
    assert.equal(map(other), other);
  }
});

test("pathMapper on posix paths: the same rules, and case matters", () => {
  const map = pathMapper({ root: "/work/webapp", home: "/home/me" });
  assert.equal(map("/work/webapp/src/a.js"), "src/a.js");
  assert.equal(map("/work/webapp"), ".");
  assert.equal(map("/home/me/.claude/x.json"), "~/.claude/x.json");
  assert.equal(map("/home/me"), "~");
  assert.equal(map("in /work/webapp/src/a.js:12 and /home/me/z"), "in src/a.js:12 and ~/z");
  assert.equal(map("/home/me2/x"), "/home/me2/x");
  assert.equal(map("/work/webapp2"), "/work/webapp2");
  assert.equal(map("/WORK/webapp/a"), "/WORK/webapp/a");
});

test("pathMapper prefers the more specific folder when the project is inside the home folder", () => {
  const map = pathMapper({ root: "C:\\Users\\me\\dev\\app", home: "C:\\Users\\me" });
  assert.equal(map("C:\\Users\\me\\dev\\app\\src\\x.js"), "src/x.js");
  assert.equal(map("C:\\Users\\me\\.ssh\\config"), "~/.ssh/config");
  assert.equal(map("C:\\Users\\me\\dev\\other\\y"), "~/dev/other/y");
});

test("pathMapper handles folders with spaces and trailing separators", () => {
  const spaced = pathMapper({ root: "C:\\Users\\Jane Doe\\dev\\app", home: "C:\\Users\\Jane Doe" });
  assert.equal(spaced("C:\\Users\\Jane Doe\\dev\\app\\src\\x.js"), "src/x.js");
  assert.equal(spaced("C:\\Users\\Jane Doe\\.ssh"), "~/.ssh");
  const trailing = pathMapper({ root: "/work/webapp/", home: "/home/me/" });
  assert.equal(trailing("/work/webapp/src"), "src");
  assert.equal(trailing("/home/me/x"), "~/x");
});

test("pathMapper counts the paths it rewrites, and does nothing without a folder to look for", () => {
  const counts = {};
  const map = pathMapper({ root: "/work/webapp", home: "/home/me" }, counts);
  map("/work/webapp/a /home/me/b /elsewhere/c");
  map("/work/webapp");
  assert.equal(counts.paths, 3);
  const quiet = {};
  assert.equal(pathMapper({}, quiet)("/work/webapp/src"), "/work/webapp/src");
  assert.deepEqual(quiet, {});
});

test("pathMapper does not rewrite everything when the folder is a drive root or /", () => {
  assert.equal(pathMapper({ root: "C:\\" })("C:\\Windows\\x"), "C:\\Windows\\x");
  assert.equal(pathMapper({ root: "/" })("/usr/bin/env"), "/usr/bin/env");
});

// --- the display -----------------------------------------------------------------------------------

test("makeDisplay always removes control sequences and shows the home folder as ~, even without redaction", () => {
  const display = makeDisplay({ home: "/home/me" });
  assert.equal(display.text("a\x1b[31mb\x1b[0m"), "ab");
  assert.equal(display.text("/home/me/x"), "~/x");
  assert.equal(display.text(`key ${SECRETS.github}`), `key ${SECRETS.github}`, "secrets stay unless redaction is on");
  assert.equal(display.redact, false);
  assert.deepEqual(display.counts, { secrets: {}, paths: 1 });
});

test("makeDisplay with redaction replaces secrets, shows the project as . and the home as ~, and counts both", () => {
  const display = makeDisplay({ redact: true, root: "/work/webapp", home: "/home/me" });
  assert.equal(display.text(`/work/webapp/a.js ${SECRETS.github} /home/me/y ${SECRETS.aws}`), "a.js [REDACTED:github-token] ~/y [REDACTED:aws-access-key]");
  assert.deepEqual(display.counts, { secrets: { "github-token": 1, "aws-access-key": 1 }, paths: 2 });
  assert.equal(display.redact, true);
});

test("makeDisplay leaves the project folder alone when redaction is off", () => {
  const display = makeDisplay({ root: "/work/webapp", home: "/home/me" });
  assert.equal(display.text("/work/webapp/a.js"), "/work/webapp/a.js");
});

test("makeDisplay takes extra patterns for the redaction", () => {
  const display = makeDisplay({ redact: true, patterns: ["ACME-[0-9]{6}"] });
  assert.equal(display.text("ACME-123456 is internal"), "[REDACTED:custom] is internal");
  assert.deepEqual(display.counts.secrets, { custom: 1 });
});

test("makeDisplay hands back what is not a string, or is empty", () => {
  const display = makeDisplay({ redact: true, home: "/home/me" });
  assert.equal(display.text(""), "");
  assert.equal(display.text(null), null);
  assert.equal(display.text(5), 5);
  assert.equal(display.home(""), "");
  assert.equal(display.home(5), 5);
});

test("display.home rewrites only the home folder: not the project folder, not secrets, and not the counts", () => {
  const display = makeDisplay({ redact: true, root: "/work/webapp", home: "/home/me" });
  assert.equal(display.home("/home/me/proj/x.js"), "~/proj/x.js");
  assert.equal(display.home("/work/webapp/src"), "/work/webapp/src");
  assert.equal(display.home("\x1b[31m/home/me/x\x1b[0m"), "~/x");
  assert.equal(display.home(SECRETS.github), SECRETS.github);
  assert.deepEqual(display.counts, { secrets: {}, paths: 0 });
});

test("describeCounts says in plain words what was done", () => {
  assert.equal(describeCounts({ secrets: {}, paths: 0 }), "no secrets found");
  assert.equal(describeCounts({ secrets: { "github-token": 1 }, paths: 0 }), "replaced 1 secret (github-token 1)");
  assert.equal(describeCounts({ secrets: { "github-token": 1, "env-secret": 1 }, paths: 0 }), "replaced 2 secrets (env-secret 1, github-token 1)");
  assert.equal(describeCounts({ secrets: { "env-secret": 1, "github-token": 2 }, paths: 18 }), "replaced 3 secrets (github-token 2, env-secret 1); rewrote 18 paths");
});

test("describeCounts names the biggest kind first, then by name, and speaks of one path in the singular", () => {
  assert.equal(describeCounts({ secrets: { b: 2, a: 2, c: 3 }, paths: 0 }), "replaced 7 secrets (c 3, a 2, b 2)");
  assert.equal(describeCounts({ secrets: {}, paths: 1 }), "no secrets found; rewrote 1 path");
  assert.equal(describeCounts({ secrets: {}, paths: 2 }), "no secrets found; rewrote 2 paths");
});

test("describeCounts reads the counts a display collects", () => {
  const display = makeDisplay({ redact: true, root: "/work/webapp", home: "/home/me" });
  display.text(`${SECRETS.github} and ${SECRETS.aws} in /work/webapp/a.js`);
  assert.equal(describeCounts(display.counts), "replaced 2 secrets (aws-access-key 1, github-token 1); rewrote 1 path");
});
