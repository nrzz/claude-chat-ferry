import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";
import { VERSION } from "../src/version.mjs";

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const json = (...p) => JSON.parse(read(...p));
const pkg = json("package.json");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const sources = ["bin", "src", "test"].flatMap((d) => walk(path.join(ROOT, d))).filter((f) => /\.m?js$/.test(f));

function headerImports(code) {
  const out = [];
  let buf = "";
  for (const line of code.split("\n")) {
    const t = line.trim();
    if (!buf) {
      if (!t || t.startsWith("//") || t.startsWith("#!")) continue;
      if (!/^import\b/.test(t) && !(/^export\b/.test(t) && /\bfrom\b/.test(t))) break;
    }
    buf += ` ${t}`;
    const m = /^\s*(?:import|export)\b.*?\bfrom\s*["']([^"']+)["'];?\s*$|^\s*import\s*["']([^"']+)["'];?\s*$/.exec(buf);
    if (m) { out.push(m[1] || m[2]); buf = ""; }
  }
  return out;
}

// --- package ------------------------------------------------------------------------------------

test("package.json: name, version, module type, bin, engines, scripts, links, license", () => {
  assert.equal(pkg.name, "claude-chat-ferry");
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.bin, { "claude-chat-ferry": "bin/claude-chat-ferry.mjs" });
  assert.equal(pkg.engines.node, ">=18");
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.repository, "github:nrzz/claude-chat-ferry");
  assert.equal(pkg.homepage, "https://github.com/nrzz/claude-chat-ferry#readme");
  assert.equal(pkg.bugs, "https://github.com/nrzz/claude-chat-ferry/issues");
  assert.equal(pkg.author, "Naresh Prabu");
  assert.equal(pkg.license, "MIT");
  assert.ok(pkg.description.length > 40);
  for (const k of ["claude-code", "cursor", "antigravity", "export", "import"]) assert.ok(pkg.keywords.includes(k), k);
  assert.ok(fs.existsSync(path.join(ROOT, pkg.bin["claude-chat-ferry"])));
  assert.ok(read("bin", "claude-chat-ferry.mjs").startsWith("#!/usr/bin/env node\n"));
});

test("the version is the same in the package, the code, the plugin and the changelog", () => {
  assert.equal(json(".claude-plugin", "plugin.json").version, VERSION);
  assert.match(read("CHANGELOG.md"), new RegExp(`^## \\[${VERSION.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}`, "m"));
});

test("the published files exist, and nothing outside the package is listed", () => {
  for (const f of pkg.files) {
    assert.ok(!f.startsWith("/") && !f.includes(".."), f);
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is listed in files but missing`);
  }
  for (const f of ["bin", "src", "skills", ".claude-plugin", "README.md", "LICENSE"]) assert.ok(pkg.files.includes(f), f);
  assert.ok(!pkg.files.includes("test"));
});

test("zero dependencies: no dependency fields, no lockfile, no node_modules, only node: and relative imports", () => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies"]) assert.equal(pkg[field], undefined, field);
  for (const f of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "node_modules"]) assert.ok(!fs.existsSync(path.join(ROOT, f)), `${f} must not exist`);
  assert.ok(sources.length >= 20);
  for (const file of sources) {
    const code = fs.readFileSync(file, "utf8");
    for (const spec of headerImports(code)) assert.ok(spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"), `${path.relative(ROOT, file)} imports ${spec}`);
    assert.ok(!new RegExp("\\brequire\\s*\\(").test(code.replace(/\/\/.*$/gm, "")), `${path.relative(ROOT, file)} uses a CommonJS require call`);
  }
  const sqlite = read("src", "sqlite.mjs");
  assert.match(sqlite, /await import\("node:sqlite"\)/, "node:sqlite is loaded only when a Cursor store is read");
  for (const file of sources.filter((f) => !f.endsWith("sqlite.mjs") && !f.includes(`${path.sep}test${path.sep}`))) assert.ok(!fs.readFileSync(file, "utf8").includes("node:sqlite"), `${path.relative(ROOT, file)} must go through src/sqlite.mjs`);
});

// --- the plugin -----------------------------------------------------------------------------------

test("plugin.json and marketplace.json agree, and carry the listing's links", () => {
  const plugin = json(".claude-plugin", "plugin.json");
  const market = json(".claude-plugin", "marketplace.json");
  assert.equal(plugin.name, "chat-ferry");
  assert.equal(plugin.displayName, "Chat Ferry");
  assert.equal(plugin.license, "MIT");
  assert.deepEqual(plugin.author, { name: "Naresh Prabu" });
  for (const k of ["homepage", "repository", "documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"]) assert.match(plugin[k], /^https:\/\/github\.com\/nrzz\/claude-chat-ferry/, k);
  assert.equal(plugin.privacyPolicyUrl, "https://github.com/nrzz/claude-chat-ferry#privacy-and-redaction");
  assert.ok(plugin.description.includes("/chat-ferry:import") && plugin.description.includes("/chat-ferry:export"));
  assert.equal(market.name, "claude-chat-ferry");
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, "chat-ferry");
  assert.equal(market.plugins[0].source, "./");
  assert.equal(market.plugins[0].category, "productivity");
  assert.equal(market.plugins[0].homepage, plugin.homepage);
  assert.ok(fs.existsSync(path.join(ROOT, ".claude-plugin", "icon.png")), "the directory listing's icon");
});

test("both skills are user-only, pre-approve only this tool's command, and use the Claude Code placeholders", () => {
  for (const name of ["export", "import"]) {
    const text = read("skills", name, "SKILL.md");
    const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    assert.ok(fm, `${name}: front matter`);
    assert.match(fm[1], new RegExp(`^name: ${name}$`, "m"));
    assert.match(fm[1], /^disable-model-invocation: true$/m);
    assert.match(fm[1], /^description: .{30,}$/m);
    const allowed = /^allowed-tools: (.*)$/m.exec(fm[1])[1];
    assert.equal(allowed, 'Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/claude-chat-ferry.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/claude-chat-ferry.mjs *)');
    assert.match(fm[2], /^!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-chat-ferry\.mjs" /m);
    assert.ok(fm[2].includes("${CLAUDE_PROJECT_DIR}"), `${name}: the project folder`);
    assert.ok(fm[2].trim().split("\n").length <= 6, `${name}: a short body (what the model reads)`);
  }
  assert.ok(read("skills", "export", "SKILL.md").includes("export claude:${CLAUDE_SESSION_ID} --to cursor"));
  assert.ok(read("skills", "import", "SKILL.md").includes('skill-import "$ARGUMENTS"'));
  assert.match(read("skills", "import", "SKILL.md"), /^argument-hint: /m);
});

// --- docs ---------------------------------------------------------------------------------------------

test("the README has the sections every toolkit tool has, and the install lines match the package", () => {
  const readme = read("README.md");
  for (const h of ["## What it costs in tokens", "## Install", "## Use", "## Privacy and redaction", "## What was verified, and how", "## Files", "## License"]) assert.ok(readme.includes(`\n${h}\n`), h);
  assert.ok(readme.includes("npx -y github:nrzz/claude-chat-ferry"));
  assert.ok(readme.includes("/plugin marketplace add nrzz/claude-chat-ferry"));
  assert.ok(readme.includes("/plugin install chat-ferry@claude-chat-ferry"));
  assert.ok(readme.includes("/chat-ferry:import") && readme.includes("/chat-ferry:export"));
  assert.ok(readme.includes("Node 22.13"), "says which Node reads Cursor's store");
  const tests = sources.filter((f) => /\.test\.mjs$/.test(f)).length;
  assert.ok(tests >= 12, "test files");
});

test("the CI workflow runs the suite on three systems and four Node versions", () => {
  const ci = read(".github", "workflows", "test.yml");
  assert.match(ci, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(ci, /node: \[20, 22, 24\]/);
  assert.match(ci, /node: 18/);
  assert.match(ci, /run: npm test/);
});

test("the license is MIT and names the author", () => {
  const lic = read("LICENSE");
  assert.match(lic, /MIT License/);
  assert.match(lic, /Naresh Prabu/);
});

test("no file in the repository holds a complete secret-looking token", () => {
  const files = walk(ROOT).filter((f) => !/\.(png|ico)$/i.test(f) && !f.includes(`${path.sep}.git${path.sep}`));
  const patterns = [/sk-ant-[A-Za-z0-9_-]{20,}/, /\bghp_[A-Za-z0-9]{30,}/, /AKIA[0-9A-Z]{16}\b/, /xox[abposr]-[A-Za-z0-9-]{10,}/];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const p of patterns) assert.ok(!p.test(text), `${path.relative(ROOT, f)} matches ${p}`);
  }
});
