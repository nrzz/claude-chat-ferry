// What may leave the machine. Every string that goes into an export passes through `display`:
//   always        control sequences removed, the home folder shown as ~
//   with redact   secrets replaced by [REDACTED:kind], the project folder shown as . or a relative path
// The secret rules are the ones claude-session-replay and claude-code-team-sync use. Redaction is
// best effort: it catches the common key, token and password shapes, not every secret.
import { cleanText, cmp, escapeRegExp } from "./util.mjs";

// Whole-match rules: the match is replaced.
export const SECRET_RULES = [
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g],
  ["stripe-key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g],
  ["github-token", /\bgithub_pat_[A-Za-z0-9_]{40,}/g],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["slack-webhook", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g],
  ["teams-webhook", /https:\/\/[a-z0-9-]+\.webhook\.office\.com\/[^\s"'<>`]+/gi],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["google-oauth-secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}\b/g],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
];
// Label-and-value rules: group 1 (the label) is kept, group 2 (the value) is replaced.
export const VALUE_RULES = [
  ["bearer-token", /(\bBearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/g],
  ["url-password", /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'`]*:)([^\s@/"'`]+)(?=@)/gi],
  ["aws-secret", /(aws_secret_access_key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})/gi],
  ["azure-key", /((?:AccountKey|SharedAccessKey)\s*=\s*)([A-Za-z0-9+/=]{20,})/gi],
  ["connection-password", /((?:^|[;"'])\s*(?:Password|Pwd)=)([^;'"\s]{2,})/gim],
  ["env-secret", /^(\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*["']?)([^\s"'#]{4,})/gm],
  ["assigned-secret", /(\b(?:password|passwd|secret|client_secret|api_?key|access_?token|auth_?token|refresh_?token|token)["']?\s*[:=]\s*["'])([^"'\s]{6,})(?=["'])/gi],
];
// Values that are obviously not secrets: placeholders, template references, type names.
export const PLACEHOLDER_VALUE = /^(?:x+|\*+|\.+|changeme|change_me|password|secret|null|none|undefined|example[\w-]*|dummy[\w-]*|test\w{0,4}|your[\w-]*|<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|%[A-Z_]+%|\[REDACTED[^\]]*\]?)$/i;

const bump = (counts, key, n = 1) => { counts[key] = (counts[key] || 0) + n; };

// Returns redact(text, counts): the text with secrets replaced, and counts[kind] raised for each.
export function makeRedactor(extraPatterns = []) {
  const extra = [];
  for (const p of extraPatterns) {
    try { extra.push(["custom", new RegExp(p, "g")]); } catch { /* an invalid pattern is skipped */ }
  }
  const rules = [...SECRET_RULES, ...extra];
  return function redact(s, counts = {}) {
    if (typeof s !== "string" || s.length < 8) return s;
    let out = s;
    for (const [kind, re] of rules) out = out.replace(re, () => { bump(counts, kind); return `[REDACTED:${kind}]`; });
    for (const [kind, re] of VALUE_RULES) {
      out = out.replace(re, (m, keep, value) => {
        if (PLACEHOLDER_VALUE.test(value)) return m;
        bump(counts, kind);
        return `${keep}[REDACTED:${kind}]`;
      });
    }
    return out;
  };
}

// Which secrets a text still contains: { kind: count }.
export function findSecrets(text) {
  const counts = {};
  makeRedactor()(String(text), counts);
  return counts;
}

// Every way a folder shows up in a transcript: both slashes, and for a Windows drive also the Git
// Bash, WSL and Cygwin spellings.
function pathVariants(p) {
  const base = String(p).replace(/[\\/]+$/, "");
  const set = new Set([base, base.replace(/\\/g, "/"), base.replace(/\//g, "\\")]);
  const drive = /^([a-zA-Z]):[\\/](.+)$/.exec(base);
  if (drive) {
    const rest = drive[2].replace(/\\/g, "/");
    const d = drive[1].toLowerCase();
    for (const prefix of [`/${d}/`, `/mnt/${d}/`, `/cygdrive/${d}/`]) set.add(prefix + rest);
  }
  return [...set].filter((v) => v.length > 2);
}
const TAIL = "((?:[\\\\/][^\\\\/\\s\"'`<>|*?:]+)*)";

// Returns map(text): the project folder becomes "." or a relative path and the home folder "~".
// counts.paths is raised for every path rewritten.
export function pathMapper({ root, home }, counts = {}) {
  const winish = [root, home].some((p) => /^[a-zA-Z]:|\\/.test(String(p || "")));
  const norm = (s) => (winish ? s.toLowerCase() : s);
  const table = new Map();
  const spellings = [];
  const add = (p, kind) => {
    if (!p) return;
    for (const v of pathVariants(p)) if (!table.has(norm(v))) { table.set(norm(v), kind); spellings.push(v); }
  };
  add(root, "root");
  add(home, "home");
  spellings.sort((a, b) => b.length - a.length);
  const re = spellings.length
    ? new RegExp(`(?:${spellings.map(escapeRegExp).join("|")})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_])${TAIL}`, winish ? "gi" : "g")
    : null;
  return (s) => {
    if (!re) return s;
    return s.replace(re, (m, tail) => {
      const kind = table.get(norm(m.slice(0, m.length - tail.length)));
      const rest = tail.replace(/\\/g, "/");
      bump(counts, "paths");
      if (kind === "root") return rest ? rest.slice(1) : ".";
      return `~${rest}`;
    });
  };
}

// makeDisplay({ redact, root, home, patterns }) -> { text(s), home(s), counts, redact }
//   text(s)  one string, cleaned, with secrets and paths dealt with
//   home(s)  one string, cleaned, with only the home folder rewritten as ~ (for a project path)
//   counts   { secrets: { kind: n }, paths }, filled in as strings pass through
export function makeDisplay({ redact = false, root = "", home = "", patterns = [] } = {}) {
  const counts = { secrets: {}, paths: 0 };
  const redactor = redact ? makeRedactor(patterns) : null;
  const toPaths = pathMapper(redact ? { root, home } : { home }, counts);
  const homeOnly = pathMapper({ home }, {});
  const text = (s) => {
    if (typeof s !== "string" || !s) return s;
    let out = cleanText(s);
    if (redactor) out = redactor(out, counts.secrets);
    return toPaths(out);
  };
  return { text, home: (s) => (typeof s === "string" && s ? homeOnly(cleanText(s)) : s), counts, redact };
}

// "replaced 3 secrets (github-token 2, env-secret 1); rewrote 18 paths"
export function describeCounts(counts) {
  const kinds = Object.entries(counts.secrets).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  const secrets = kinds.reduce((n, [, c]) => n + c, 0);
  const parts = [secrets ? `replaced ${secrets} secret${secrets === 1 ? "" : "s"} (${kinds.map(([k, c]) => `${k} ${c}`).join(", ")})` : "no secrets found"];
  if (counts.paths) parts.push(`rewrote ${counts.paths} path${counts.paths === 1 ? "" : "s"}`);
  return parts.join("; ");
}
